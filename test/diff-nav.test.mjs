// 差分ナビゲーション（issue #25）の hunk 遷移ロジックのテスト。
// 「▼ 次の差分へ」を押しても移動しない不具合（PR #29 の実機確認で発覚）は
// スクロール位置がコンテンツ末尾でクランプされることが原因なので、
// クランプされる状況をここで再現する。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createDiffNav } from '../dist-test/diff-nav.mjs';

/**
 * スクロールコンテナの偽物。
 * scrollTo は実ブラウザと同じく 0〜(contentHeight - viewportHeight) にクランプする。
 */
function fakeScroller({ hunkTops, viewportHeight, contentHeight }) {
  const state = { scrollTop: 0 };
  const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
  // 実ブラウザと同じく、クランプ + 端数の丸めを掛ける
  const scrollTo = (top) => {
    state.scrollTop = Math.round(Math.min(Math.max(0, top), maxScrollTop));
  };
  return {
    state,
    maxScrollTop,
    scrollTo,
    /** behavior:'smooth' を模して、途中の位置でも scroll イベント相当を通知する */
    smoothScrollTo: (top, nav) => {
      const from = state.scrollTop;
      for (const progress of [0.3, 0.7, 1]) {
        scrollTo(from + (Math.min(Math.max(0, top), maxScrollTop) - from) * progress);
        nav.syncToScroll();
      }
    },
    geometry: {
      scrollTop: () => state.scrollTop,
      maxScrollTop: () => maxScrollTop,
      hunkTop: (index) => hunkTops[index],
    },
  };
}

/** 「次へ」「前へ」を n 回押して、そのたびに選択された hunk index を記録する */
function pressRepeatedly(nav, scroller, method, times) {
  const visited = [];
  for (let i = 0; i < times; i++) {
    scroller.smoothScrollTo(nav[method](), nav);
    visited.push(nav.index());
  }
  return visited;
}

describe('createDiffNav', () => {
  test('スクロールできる範囲の hunk は「次へ」で順に選択され、末尾から先頭へ折り返す', () => {
    // hunk が 3 件、いずれも scrollTop の上限（500 - 200 = 300）より手前にある
    const scroller = fakeScroller({
      hunkTops: [0, 100, 250],
      viewportHeight: 200,
      contentHeight: 500,
    });
    const nav = createDiffNav(3, scroller.geometry);

    assert.equal(nav.index(), 0);
    assert.equal(nav.label(), '1 / 3');
    assert.deepEqual(pressRepeatedly(nav, scroller, 'next', 4), [1, 2, 0, 1]);
  });

  test('「前へ」で逆順に選択され、先頭から末尾へ折り返す', () => {
    const scroller = fakeScroller({
      hunkTops: [0, 100, 250],
      viewportHeight: 200,
      contentHeight: 500,
    });
    const nav = createDiffNav(3, scroller.geometry);

    assert.deepEqual(pressRepeatedly(nav, scroller, 'prev', 4), [2, 1, 0, 2]);
  });

  // ここが今回の不具合の再現。末尾付近の hunk はスクロール位置が上限でクランプされ、
  // 位置からは手前の hunk と区別できない → 位置ベースの判定だと到達できなくなる。
  test('末尾付近の hunk（スクロールがクランプされる位置）にも「次へ」で到達できる', () => {
    // scrollTop の上限は 600 - 200 = 400。hunk 2（450）と hunk 3（520）は
    // どちらもクランプ後の scrollTop が 400 になり、位置では区別できない
    const scroller = fakeScroller({
      hunkTops: [0, 100, 450, 520],
      viewportHeight: 200,
      contentHeight: 600,
    });
    const nav = createDiffNav(4, scroller.geometry);

    // 4 回押せば全 hunk を 1 巡して先頭に戻る
    assert.deepEqual(pressRepeatedly(nav, scroller, 'next', 4), [1, 2, 3, 0]);
  });

  test('末尾付近の hunk からでも「前へ」で手前の hunk に戻れる', () => {
    const scroller = fakeScroller({
      hunkTops: [0, 100, 450, 520],
      viewportHeight: 200,
      contentHeight: 600,
    });
    const nav = createDiffNav(4, scroller.geometry);

    scroller.smoothScrollTo(nav.next(), nav); // 1
    scroller.smoothScrollTo(nav.next(), nav); // 2（ここからクランプ域）
    scroller.smoothScrollTo(nav.next(), nav); // 3
    assert.equal(nav.index(), 3);
    assert.deepEqual(pressRepeatedly(nav, scroller, 'prev', 3), [2, 1, 0]);
  });

  test('コンテンツ全体が収まっていてスクロールできない場合も全 hunk を巡回できる', () => {
    // maxScrollTop = 0。全 hunk が同じスクロール位置になるので、
    // 位置ベースの判定では 1 件目から動けない
    const scroller = fakeScroller({
      hunkTops: [20, 60, 120],
      viewportHeight: 300,
      contentHeight: 200,
    });
    const nav = createDiffNav(3, scroller.geometry);

    assert.equal(nav.label(), '1 / 3');
    assert.deepEqual(pressRepeatedly(nav, scroller, 'next', 3), [1, 2, 0]);
  });

  test('手動スクロールにはカウンタが追従する', () => {
    const scroller = fakeScroller({
      hunkTops: [0, 100, 250],
      viewportHeight: 200,
      contentHeight: 500,
    });
    const nav = createDiffNav(3, scroller.geometry);

    scroller.scrollTo(260); // hunk 2 を通り過ぎる位置まで手でスクロール
    nav.syncToScroll();
    assert.equal(nav.label(), '3 / 3');

    scroller.scrollTo(100);
    nav.syncToScroll();
    assert.equal(nav.label(), '2 / 3');

    scroller.scrollTo(0);
    nav.syncToScroll();
    assert.equal(nav.label(), '1 / 3');
  });

  test('ボタンで選んだ hunk は、途中のスクロールイベントを経ても選択が保たれる', () => {
    const scroller = fakeScroller({
      hunkTops: [0, 100, 450, 520],
      viewportHeight: 200,
      contentHeight: 600,
    });
    const nav = createDiffNav(4, scroller.geometry);

    scroller.smoothScrollTo(nav.next(), nav); // 1
    scroller.smoothScrollTo(nav.next(), nav); // 2
    scroller.smoothScrollTo(nav.next(), nav); // 3（クランプされて scrollTop は上限のまま）
    // smooth scroll の完了後に来るスクロールイベントで選択が巻き戻らないこと
    nav.syncToScroll();
    nav.syncToScroll();
    assert.equal(nav.label(), '4 / 4');
  });

  // hunk の位置は getBoundingClientRect 由来なので端数を持つ。scrollTop 側は端数が
  // 丸められるため、判定に余裕がないと「その hunk まで来たのに 1 つ手前」と読まれる。
  // 実機（PR #32 の expand）ではこれで「次へ」が 1 / 7 に張り付いていた。
  test('hunk の位置が端数を持っていても、到達した hunk が現在位置になる', () => {
    const scroller = fakeScroller({
      hunkTops: [8.4, 200.4, 400.4],
      viewportHeight: 200,
      contentHeight: 900,
    });
    const nav = createDiffNav(3, scroller.geometry);

    assert.deepEqual(pressRepeatedly(nav, scroller, 'next', 3), [1, 2, 0]);

    // 手動スクロールでも同じ。hunk 1 の位置まで下げると scrollTop は 196
    //（= 200.4 - 4 の丸め）になり、余裕なしの判定では hunk 0 と読まれてしまう
    scroller.scrollTo(200.4 - 4);
    assert.equal(scroller.state.scrollTop, 196);
    nav.syncToScroll();
    assert.equal(nav.label(), '2 / 3');
  });

  test('移動アニメーションの通過点では選択が手前の hunk に戻らない', () => {
    const scroller = fakeScroller({
      hunkTops: [0, 100, 250],
      viewportHeight: 200,
      contentHeight: 500,
    });
    const nav = createDiffNav(3, scroller.geometry);

    nav.next(); // hunk 1 を選択（スクロールはこれから）
    assert.equal(nav.label(), '2 / 3');
    for (const top of [20, 50, 80, 96]) {
      scroller.scrollTo(top);
      nav.syncToScroll();
      assert.equal(nav.label(), '2 / 3', `通過点 ${top}px で選択が変わった`);
    }
  });

  test('移動アニメーション中にユーザーが逆方向へスクロールしたら追従に切り替わる', () => {
    const scroller = fakeScroller({
      hunkTops: [0, 100, 250],
      viewportHeight: 200,
      contentHeight: 500,
    });
    const nav = createDiffNav(3, scroller.geometry);

    scroller.smoothScrollTo(nav.next(), nav); // hunk 1 へ
    nav.next(); // hunk 2 へ移動開始（下方向）
    scroller.scrollTo(150);
    nav.syncToScroll(); // 通過点
    assert.equal(nav.label(), '3 / 3');
    scroller.scrollTo(0); // ユーザーが上へスクロールして割り込む
    nav.syncToScroll();
    assert.equal(nav.label(), '1 / 3');
  });
});
