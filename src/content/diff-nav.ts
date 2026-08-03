// 差分ナビゲーション（issue #25）の「今どの hunk を見ているか」を管理する純粋ロジック。
// panel.ts は DOM（スクロール位置の読み取り・実際のスクロール・ハイライト）だけを担い、
// 選択中 hunk の遷移規則はここでテスト可能にする。

/** スクロールコンテナの寸法・hunk 位置の読み取り口（panel.ts が DOM から供給する） */
export interface DiffNavGeometry {
  /** 現在の scrollTop */
  scrollTop: () => number;
  /** scrollTop の上限（scrollHeight - clientHeight）。これより下へはスクロールできない */
  maxScrollTop: () => number;
  /** hunk index の先頭行が、スクロールコンテナの座標系で何 px の位置にあるか */
  hunkTop: (index: number) => number;
}

/** hunk の先頭行が上端にぴったり張り付かないよう少し上に取る余白（px） */
const SCROLL_MARGIN = 4;

/**
 * 「この hunk の位置まで来ている」と判定する許容幅（px）。
 * hunk の位置は getBoundingClientRect 由来で端数を持つ一方、scrollTop は端数が
 * 丸められるため、SCROLL_MARGIN ぴったりで判定すると hunk へスクロールしきった直後でも
 * 端数のぶんだけ足りず「まだ手前の hunk」と判定されてしまう（hunk の間隔は最低 1 行
 * ＝十数 px あるので、1px 緩めても次の hunk を先取りすることはない）。
 */
const POSITION_SLACK = SCROLL_MARGIN + 1;

export interface DiffNav {
  /** 選択中の hunk index */
  index: () => number;
  /** カウンタ表示用の `n / N` */
  label: () => string;
  /** 前の hunk を選択し、スクロール先の scrollTop を返す（先頭で押すと末尾へ折り返す） */
  prev: () => number;
  /** 次の hunk を選択し、スクロール先の scrollTop を返す（末尾で押すと先頭へ折り返す） */
  next: () => number;
  /** 手動スクロールに追従して選択を更新する */
  syncToScroll: () => void;
}

export function createDiffNav(hunkCount: number, geometry: DiffNavGeometry): DiffNav {
  // 選択中の hunk はスクロール位置から都度求めるのではなく状態として持つ。
  // コンテンツ末尾付近の hunk は scrollTo しても scrollTop が上限でクランプされ、
  // 手前の hunk と同じ位置になってしまうため、位置から逆算すると後半の hunk へ
  // 到達できない（「次へ」を押しても選択が進まない）。
  let active = 0;

  const scrollTargetOf = (index: number): number =>
    Math.max(0, geometry.hunkTop(index) - SCROLL_MARGIN);

  /** 実際に到達できるスクロール位置（末尾側は上限でクランプされる） */
  const reachableTopOf = (index: number): number =>
    Math.min(scrollTargetOf(index), Math.max(0, geometry.maxScrollTop()));

  // 直近で開始位置を過ぎた hunk = 今見ている hunk とみなす（未到達なら先頭扱い）
  const indexFromScroll = (): number => {
    const top = geometry.scrollTop();
    let idx = 0;
    for (let i = 0; i < hunkCount; i++) {
      if (geometry.hunkTop(i) <= top + POSITION_SLACK) idx = i;
      else break;
    }
    return idx;
  };

  /**
   * 進行中のスクロールアニメーション（smooth scroll）の目標位置。
   * 到達するまでは位置ベースの判定を止める（通過点ごとに選択を計算し直すと、
   * 移動しきる前の位置に対応する手前の hunk が一瞬選択されて見えてしまう）。
   * ユーザーが逆方向へスクロールして割り込んだら追従に戻す。
   */
  let pending: { top: number; downward: boolean; last: number } | null = null;

  const select = (index: number): number => {
    active = index;
    const from = geometry.scrollTop();
    const reachable = reachableTopOf(index);
    // 移動距離がなければアニメーションもスクロールイベントも起きない
    pending =
      Math.abs(reachable - from) <= SCROLL_MARGIN
        ? null
        : { top: reachable, downward: reachable > from, last: from };
    return scrollTargetOf(index);
  };

  return {
    index: () => active,
    label: () => `${active + 1} / ${hunkCount}`,
    prev: () => select((active - 1 + hunkCount) % hunkCount),
    next: () => select((active + 1) % hunkCount),
    syncToScroll: () => {
      const top = geometry.scrollTop();
      if (pending !== null) {
        const reached = Math.abs(top - pending.top) <= SCROLL_MARGIN;
        const reversed = pending.downward
          ? top < pending.last - SCROLL_MARGIN
          : top > pending.last + SCROLL_MARGIN;
        pending.last = top;
        if (reached) pending = null;
        if (!reversed) return;
        pending = null; // ユーザーが割り込んで自分でスクロールした
      }
      // 選択中 hunk の到達位置にまだ居るならスクロールは自分が起こしたものなので
      // 選択を保つ（クランプ域では位置から hunk を区別できないため、ここで
      // 位置ベースの判定に戻すと選択が手前の hunk へ巻き戻ってしまう）。
      if (Math.abs(top - reachableTopOf(active)) <= SCROLL_MARGIN) return;
      active = indexFromScroll();
    },
  };
}
