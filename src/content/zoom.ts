// グラフズームの倍率計算（純粋ロジック）。
// DOM 操作（SVG のサイズ書き換え・スクロール位置の設定）は panel.ts / mermaid-view.ts が
// 行い、ここは「次の倍率はいくつか」「スクロールをどこへ動かすか」の計算だけを持つ
// （Node 上でそのままユニットテストできる）。

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
/** ＋/− ボタン 1 回あたりの倍率変化（乗算。1 段で 25% 拡大） */
export const ZOOM_STEP = 1.25;

/** 倍率を [ZOOM_MIN, ZOOM_MAX] に収める */
export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

export function zoomIn(scale: number): number {
  return clampZoom(scale * ZOOM_STEP);
}

export function zoomOut(scale: number): number {
  return clampZoom(scale / ZOOM_STEP);
}

/**
 * Ctrl/Cmd + ホイール（トラックパッドのピンチも Chrome は ctrlKey 付き wheel として
 * 通知する）1 イベント分の倍率変化。deltaY が負（上スクロール / ピンチアウト）で拡大。
 * deltaY=480 で倍率が 1/2 になる連続スケール（ピンチの細かい delta にも滑らかに追従する）。
 */
export function wheelZoom(scale: number, deltaY: number): number {
  return clampZoom(scale * Math.pow(2, -deltaY / 480));
}

/** UI 表示用のパーセント表記（例: 1.25 → "125%"） */
export function formatZoom(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * ズーム後もアンカー位置（ボタン操作ならビューポート中央、ホイールならカーソル位置）の
 * 下にあるコンテンツが動かないよう見せるためのスクロール量。
 * コンテンツ上の点 (scroll + anchor) が ratio 倍の位置へ移動するので、そこから
 * anchor を引いた値が新しいスクロール位置になる（負値はブラウザ側で 0 に丸められる）。
 */
export function anchoredScroll(scroll: number, anchor: number, ratio: number): number {
  return (scroll + anchor) * ratio - anchor;
}
