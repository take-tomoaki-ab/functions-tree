// diff-lines（patch → RIGHT サイドのコメント可能行集合、関数範囲との突き合わせ）の
// ユニットテスト。純粋ロジックなので Node 上でそのまま検証できる。
// 実行前に pretest（esbuild）が dist-test/diff-lines.mjs を生成する。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  commentableLinesForRange,
  parsePatchCommentableLines,
} from '../dist-test/diff-lines.mjs';

describe('parsePatchCommentableLines', () => {
  test('単一 hunk: 文脈行と追加行が RIGHT の行番号で得られ、削除行は含まれない', () => {
    const patch = [
      '@@ -10,6 +10,7 @@ function foo() {',
      ' context10',
      ' context11',
      '-old line',
      '+new line 12',
      '+new line 13',
      ' context14',
      ' context15',
      ' context16',
    ].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.commentable, [10, 11, 12, 13, 14, 15, 16]);
    assert.deepEqual(r.added, [12, 13]);
  });

  test('複数 hunk: それぞれのヘッダの開始行から数え直す', () => {
    const patch = [
      '@@ -1,2 +1,3 @@',
      ' a',
      '+x',
      ' b',
      '@@ -30,3 +31,4 @@',
      ' p',
      '+q',
      ' r',
      ' s',
    ].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.commentable, [1, 2, 3, 31, 32, 33, 34]);
    assert.deepEqual(r.added, [2, 32]);
  });

  test('追加のみ（新規ファイル）: 全行が追加行になる', () => {
    const patch = ['@@ -0,0 +1,3 @@', '+a', '+b', '+c'].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.commentable, [1, 2, 3]);
    assert.deepEqual(r.added, [1, 2, 3]);
  });

  test('削除のみ + 文脈行: 文脈行だけがコメント可能（追加行なし）', () => {
    const patch = ['@@ -1,3 +1,2 @@', ' keep1', '-gone', ' keep2'].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.commentable, [1, 2]);
    assert.deepEqual(r.added, []);
  });

  test('文脈なしの純削除: RIGHT にコメント可能な行はない', () => {
    const patch = ['@@ -2 +1,0 @@', '-gone'].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.commentable, []);
    assert.deepEqual(r.added, []);
  });

  test('行数省略ヘッダ（@@ -1 +1 @@）は 1 行として扱う', () => {
    const patch = ['@@ -1 +1 @@', '-a', '+b'].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.commentable, [1]);
    assert.deepEqual(r.added, [1]);
  });

  test('"\\ No newline at end of file" は無視される', () => {
    const patch = ['@@ -1,2 +1,2 @@', ' a', '-b', '+c', '\\ No newline at end of file'].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.commentable, [1, 2]);
    assert.deepEqual(r.added, [2]);
  });

  test('hunk の行数を超えた末尾の空文字列を文脈行と誤認しない', () => {
    const patch = ['@@ -1,1 +1,1 @@', ' a', ''].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.commentable, [1]);
  });

  test('patch がない（バイナリ / 巨大ファイル / 変更なしリネーム）なら空集合', () => {
    for (const patch of [undefined, null, '']) {
      const r = parsePatchCommentableLines(patch);
      assert.deepEqual(r.commentable, []);
      assert.deepEqual(r.added, []);
    }
  });
});

describe('commentableLinesForRange', () => {
  const info = {
    commentable: [10, 11, 12, 13, 14, 30, 31],
    added: [12, 13, 31],
  };

  test('範囲内のコメント可能行を返し、推奨行は最初の追加行', () => {
    const r = commentableLinesForRange(info, 11, 14);
    assert.deepEqual(r.lines, [11, 12, 13, 14]);
    assert.equal(r.commentLine, 12);
  });

  test('範囲内に追加行がなければ最初のコメント可能行（文脈行）にフォールバック', () => {
    const r = commentableLinesForRange(info, 10, 11);
    assert.deepEqual(r.lines, [10, 11]);
    assert.equal(r.commentLine, 10);
  });

  test('範囲と重なる行がなければ lines は空で commentLine は undefined', () => {
    const r = commentableLinesForRange(info, 20, 25);
    assert.deepEqual(r.lines, []);
    assert.equal(r.commentLine, undefined);
  });

  test('範囲の両端（startLine / endLine）を含む', () => {
    const r = commentableLinesForRange(info, 30, 31);
    assert.deepEqual(r.lines, [30, 31]);
    assert.equal(r.commentLine, 31);
  });
});
