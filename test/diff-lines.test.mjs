// diff-lines（patch → RIGHT サイドのコメント可能行集合、関数範囲との突き合わせ）の
// ユニットテスト。純粋ロジックなので Node 上でそのまま検証できる。
// 実行前に pretest（esbuild）が dist-test/diff-lines.mjs を生成する。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  commentableLinesForRange,
  deletedLinesForRange,
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
      assert.deepEqual(r.deleted, []);
    }
  });
});

// 削除行は RIGHT に行番号を持たないので「次に来る RIGHT 行の直前」として位置を持つ。
// パネルのソース表示で git diff と同じ「削除 → 追加」の並びを再現するための情報。
describe('parsePatchCommentableLines: 削除行', () => {
  test('置換 hunk: 削除行は追加行と同じ RIGHT 行を beforeLine に持つ', () => {
    const patch = [
      '@@ -10,3 +10,3 @@',
      ' keep10',
      '-old11',
      '+new11',
      ' keep12',
    ].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.deleted, [{ beforeLine: 11, text: 'old11' }]);
    assert.deepEqual(r.added, [11]);
  });

  test('連続削除: 内容と順序が保たれ、beforeLine は同じ行になる', () => {
    const patch = ['@@ -1,4 +1,2 @@', ' a', '-b', '-c', ' d'].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.deleted, [
      { beforeLine: 2, text: 'b' },
      { beforeLine: 2, text: 'c' },
    ]);
    assert.deepEqual(r.added, []);
  });

  test('hunk 冒頭の削除: beforeLine は hunk の開始行', () => {
    const patch = ['@@ -1,3 +1,2 @@', '-gone', ' keep1', ' keep2'].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.deleted, [{ beforeLine: 1, text: 'gone' }]);
  });

  test('複数 hunk: それぞれの RIGHT 開始行から数え直す', () => {
    const patch = [
      '@@ -1,2 +1,1 @@',
      ' a',
      '-b',
      '@@ -30,2 +29,1 @@',
      '-p',
      ' q',
    ].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.deleted, [
      { beforeLine: 2, text: 'b' },
      { beforeLine: 29, text: 'p' },
    ]);
  });

  test('先頭の "-" を除いた内容が入る（空の削除行 / インデント保持）', () => {
    const patch = ['@@ -1,3 +1,1 @@', ' a', '-', '-    indented'].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.deleted, [
      { beforeLine: 2, text: '' },
      { beforeLine: 2, text: '    indented' },
    ]);
  });

  test('diff ヘッダの "--- a/file" を削除行と誤認しない（hunk 外は無視）', () => {
    const patch = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', ' a'].join('\n');
    const r = parsePatchCommentableLines(patch);
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.added, []);
  });
});

describe('deletedLinesForRange', () => {
  const info = parsePatchCommentableLines(
    [
      '@@ -8,11 +8,7 @@',
      ' c8',
      '-del9',
      ' c9',
      ' c10',
      '-del11',
      '-del12',
      ' c11',
      ' c12',
      ' c13',
      ' c14',
      '-del15',
    ].join('\n')
  );

  test('beforeLine が範囲内の削除行だけを返す', () => {
    assert.deepEqual(deletedLinesForRange(info, 10, 12), [
      { beforeLine: 11, text: 'del11' },
      { beforeLine: 11, text: 'del12' },
    ]);
  });

  test('範囲の両端を含む', () => {
    assert.deepEqual(deletedLinesForRange(info, 9, 9), [
      { beforeLine: 9, text: 'del9' },
    ]);
  });

  test('範囲外なら空（隣の関数の削除行を拾わない）', () => {
    assert.deepEqual(deletedLinesForRange(info, 12, 14), []);
  });
});

describe('commentableLinesForRange', () => {
  const info = {
    commentable: [10, 11, 12, 13, 14, 30, 31],
    added: [12, 13, 31],
    deleted: [],
  };

  test('範囲内のコメント可能行を返し、推奨行は最初の追加行', () => {
    const r = commentableLinesForRange(info, 11, 14);
    assert.deepEqual(r.lines, [11, 12, 13, 14]);
    assert.deepEqual(r.added, [12, 13], '範囲内の追加行だけを返す');
    assert.equal(r.commentLine, 12);
    assert.equal(r.hasChange, true, '追加行を含むので変更あり');
  });

  test('範囲内に追加行がなければ最初のコメント可能行（文脈行）にフォールバックし、hasChange は false（差分なしだがコメント可）', () => {
    const r = commentableLinesForRange(info, 10, 11);
    assert.deepEqual(r.lines, [10, 11]);
    assert.deepEqual(r.added, []);
    assert.equal(r.commentLine, 10);
    assert.equal(r.hasChange, false);
  });

  test('範囲と重なる行がなければ lines は空で commentLine は undefined、hasChange も false', () => {
    const r = commentableLinesForRange(info, 20, 25);
    assert.deepEqual(r.lines, []);
    assert.deepEqual(r.added, []);
    assert.equal(r.commentLine, undefined);
    assert.equal(r.hasChange, false);
  });

  test('範囲の両端（startLine / endLine）を含む', () => {
    const r = commentableLinesForRange(info, 30, 31);
    assert.deepEqual(r.lines, [30, 31]);
    assert.equal(r.commentLine, 31);
    assert.equal(r.hasChange, true);
  });
});
