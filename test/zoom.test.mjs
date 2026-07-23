// zoom（グラフズームの倍率計算）のユニットテスト。純粋ロジックなので Node 上で
// そのまま検証できる。実行前に pretest（esbuild）が dist-test/zoom.mjs を生成する。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  anchoredScroll,
  clampZoom,
  formatZoom,
  wheelZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  zoomIn,
  zoomOut,
} from '../dist-test/zoom.mjs';

describe('clampZoom', () => {
  test('範囲内の値はそのまま返す', () => {
    assert.equal(clampZoom(1), 1);
    assert.equal(clampZoom(2.5), 2.5);
  });

  test('上限・下限に丸める', () => {
    assert.equal(clampZoom(100), ZOOM_MAX);
    assert.equal(clampZoom(0.01), ZOOM_MIN);
  });

  test('NaN / Infinity は等倍にフォールバックする', () => {
    assert.equal(clampZoom(Number.NaN), 1);
    assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1);
  });
});

describe('zoomIn / zoomOut', () => {
  test('1 段で ZOOM_STEP 倍だけ変化する', () => {
    assert.equal(zoomIn(1), ZOOM_STEP);
    assert.equal(zoomOut(1), 1 / ZOOM_STEP);
  });

  test('in と out は互いに打ち消す（クランプ範囲内）', () => {
    assert.ok(Math.abs(zoomOut(zoomIn(1)) - 1) < 1e-12);
  });

  test('上限・下限で頭打ちになる', () => {
    assert.equal(zoomIn(ZOOM_MAX), ZOOM_MAX);
    assert.equal(zoomOut(ZOOM_MIN), ZOOM_MIN);
  });
});

describe('wheelZoom', () => {
  test('deltaY が負（上スクロール / ピンチアウト）で拡大する', () => {
    assert.ok(wheelZoom(1, -100) > 1);
  });

  test('deltaY が正で縮小する', () => {
    assert.ok(wheelZoom(1, 100) < 1);
  });

  test('deltaY=480 で倍率がちょうど半分になる', () => {
    assert.ok(Math.abs(wheelZoom(1, 480) - 0.5) < 1e-12);
  });

  test('連続イベントでも上限・下限を越えない', () => {
    let z = 1;
    for (let i = 0; i < 100; i++) z = wheelZoom(z, -480);
    assert.equal(z, ZOOM_MAX);
    for (let i = 0; i < 100; i++) z = wheelZoom(z, 480);
    assert.equal(z, ZOOM_MIN);
  });
});

describe('formatZoom', () => {
  test('パーセント表記に丸める', () => {
    assert.equal(formatZoom(1), '100%');
    assert.equal(formatZoom(1.25), '125%');
    assert.equal(formatZoom(1 / ZOOM_STEP), '80%');
  });
});

describe('anchoredScroll', () => {
  test('倍率が変わらなければスクロールも変わらない', () => {
    assert.equal(anchoredScroll(100, 50, 1), 100);
  });

  test('アンカー位置のコンテンツが動かないスクロール量を返す', () => {
    // コンテンツ上の点 100+50=150 が 2 倍で 300 へ移動 → 300-50=250
    assert.equal(anchoredScroll(100, 50, 2), 250);
  });

  test('縮小時はスクロールが手前に戻る', () => {
    assert.equal(anchoredScroll(100, 50, 0.5), 25);
  });
});
