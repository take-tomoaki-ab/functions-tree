// source-diff（パネルのソース表示を git diff 風の行リストへ組み立てる）のユニットテスト。
// DOM に依存しない純粋ロジックなので Node 上でそのまま検証できる。
// 実行前に pretest（esbuild）が dist-test/source-diff.mjs を生成する。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildSourceRows,
  computeDiffHunks,
  computeDiffMarks,
  diffStat,
  splitTokensByLine,
} from '../dist-test/source-diff.mjs';

describe('splitTokensByLine', () => {
  test('行内に収まるトークンは行頭基準のオフセットになる', () => {
    // 'ab\ncde' → 行 0 = [0,2), 行 1 = [3,6)
    const tokens = [
      [0, 2, 'keyword'],
      [3, 6, 'string'],
    ];
    assert.deepEqual(splitTokensByLine('ab\ncde', tokens), [
      [[0, 2, 'keyword']],
      [[0, 3, 'string']],
    ]);
  });

  test('複数行にまたがるトークン（ブロックコメント等）は行境界で分割される', () => {
    // '/*x\ny*/' 全体が comment。行 0 = [0,3), 行 1 = [4,7)
    assert.deepEqual(splitTokensByLine('/*x\ny*/', [[0, 7, 'comment']]), [
      [[0, 3, 'comment']],
      [[0, 3, 'comment']],
    ]);
  });

  test('トークンのない行は空配列になる', () => {
    assert.deepEqual(splitTokensByLine('a\nb\nc', [[4, 5, 'number']]), [
      [],
      [],
      [[0, 1, 'number']],
    ]);
  });

  test('改行文字はトークンに含めない（行末で切る）', () => {
    // 'ab\ncd' の [0,5) は行 0 の [0,2) と行 1 の [0,2) になる（改行は落ちる）
    assert.deepEqual(splitTokensByLine('ab\ncd', [[0, 5, 'string']]), [
      [[0, 2, 'string']],
      [[0, 2, 'string']],
    ]);
  });

  test('トークンなしなら全行が空配列', () => {
    assert.deepEqual(splitTokensByLine('a\nb', []), [[], []]);
  });
});

describe('buildSourceRows', () => {
  test('行番号は startLine から振られ、追加行だけ kind が add になる', () => {
    const rows = buildSourceRows({
      sourceText: 'function f() {\n  return 1;\n}',
      startLine: 10,
      addedLines: [11],
    });
    assert.deepEqual(
      rows.map((r) => [r.kind, r.lineNo, r.text]),
      [
        ['context', 10, 'function f() {'],
        ['add', 11, '  return 1;'],
        ['context', 12, '}'],
      ]
    );
  });

  test('削除行は beforeLine の直前に、行番号なしで挿入される', () => {
    const rows = buildSourceRows({
      sourceText: 'a\nb\nc',
      startLine: 5,
      addedLines: [6],
      deletedLines: [{ beforeLine: 6, text: 'old b' }],
    });
    assert.deepEqual(
      rows.map((r) => [r.kind, r.lineNo, r.text]),
      [
        ['context', 5, 'a'],
        ['del', undefined, 'old b'],
        ['add', 6, 'b'],
        ['context', 7, 'c'],
      ],
      'git diff と同じ「削除 → 追加」の並びになる'
    );
  });

  test('同じ位置の連続削除は patch の順序を保って並ぶ', () => {
    const rows = buildSourceRows({
      sourceText: 'a\nb',
      startLine: 1,
      deletedLines: [
        { beforeLine: 2, text: 'x' },
        { beforeLine: 2, text: 'y' },
      ],
    });
    assert.deepEqual(
      rows.map((r) => [r.kind, r.text]),
      [
        ['context', 'a'],
        ['del', 'x'],
        ['del', 'y'],
        ['context', 'b'],
      ]
    );
  });

  test('削除行にはハイライトトークンを付けない（旧内容なので構文木がない）', () => {
    const rows = buildSourceRows({
      sourceText: 'a',
      startLine: 1,
      highlightTokens: [[0, 1, 'keyword']],
      deletedLines: [{ beforeLine: 1, text: 'gone' }],
    });
    assert.deepEqual(rows[0], { kind: 'del', text: 'gone', tokens: [] });
    assert.deepEqual(rows[1].tokens, [[0, 1, 'keyword']]);
  });

  test('ハイライトトークンが行ごとに割り当てられる', () => {
    // 'const x\nreturn' → 'const' = [0,5), 'return' = [8,14)
    const rows = buildSourceRows({
      sourceText: 'const x\nreturn',
      startLine: 1,
      highlightTokens: [
        [0, 5, 'keyword'],
        [8, 14, 'keyword'],
      ],
    });
    assert.deepEqual(rows[0].tokens, [[0, 5, 'keyword']]);
    assert.deepEqual(rows[1].tokens, [[0, 6, 'keyword']]);
  });

  test('diff 情報が未指定（diff 外の関数 / 古いキャッシュ）なら全行 context', () => {
    const rows = buildSourceRows({ sourceText: 'a\nb', startLine: 3 });
    assert.deepEqual(
      rows.map((r) => [r.kind, r.lineNo]),
      [
        ['context', 3],
        ['context', 4],
      ]
    );
  });

  test('新規追加された関数は全行 add になる', () => {
    const rows = buildSourceRows({
      sourceText: 'a\nb\nc',
      startLine: 1,
      addedLines: [1, 2, 3],
    });
    assert.ok(rows.every((r) => r.kind === 'add'));
  });

  test('範囲外の削除行（beforeLine が sourceText の行に対応しない）は描かれない', () => {
    const rows = buildSourceRows({
      sourceText: 'a\nb',
      startLine: 10,
      deletedLines: [{ beforeLine: 99, text: 'stray' }],
    });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.kind === 'context'));
  });
});

describe('diffStat', () => {
  test('追加行 / 削除行の数を数える（context は数えない）', () => {
    const rows = buildSourceRows({
      sourceText: 'a\nb\nc',
      startLine: 1,
      addedLines: [2, 3],
      deletedLines: [{ beforeLine: 2, text: 'x' }],
    });
    assert.deepEqual(diffStat(rows), { added: 2, deleted: 1 });
  });

  test('無変更の関数は 0 件（サマリを出さない判定に使う）', () => {
    const rows = buildSourceRows({ sourceText: 'a\nb', startLine: 1 });
    assert.deepEqual(diffStat(rows), { added: 0, deleted: 0 });
  });
});

// issue #25: 差分ナビゲーション（次/前の差分ボタン）が飛び先とする hunk 単位
describe('computeDiffHunks', () => {
  test('無変更の関数には hunk がない', () => {
    const rows = buildSourceRows({ sourceText: 'a\nb', startLine: 1 });
    assert.deepEqual(computeDiffHunks(rows), []);
  });

  test('context で区切られた add/del はそれぞれ別の hunk になる', () => {
    const rows = buildSourceRows({
      sourceText: 'a\nb\nc\nd\ne',
      startLine: 1,
      addedLines: [2, 4],
    });
    assert.deepEqual(computeDiffHunks(rows), [
      { startRow: 1, endRow: 2 },
      { startRow: 3, endRow: 4 },
    ]);
  });

  test('削除→追加（同じ変更）は 1 つの hunk にまとまる', () => {
    const rows = buildSourceRows({
      sourceText: 'a\nb\nc',
      startLine: 1,
      addedLines: [2],
      deletedLines: [{ beforeLine: 2, text: 'old b' }],
    });
    // rows = [context a, del, add, context c]
    assert.deepEqual(computeDiffHunks(rows), [{ startRow: 1, endRow: 3 }]);
  });

  test('新規追加された関数は全行が 1 つの hunk になる', () => {
    const rows = buildSourceRows({
      sourceText: 'a\nb\nc',
      startLine: 1,
      addedLines: [1, 2, 3],
    });
    assert.deepEqual(computeDiffHunks(rows), [{ startRow: 0, endRow: 3 }]);
  });
});

// issue #25: overview ruler（VSCode のスクロールバー横インジケータ）用のマーク
describe('computeDiffMarks', () => {
  test('行がなければ空', () => {
    assert.deepEqual(computeDiffMarks([]), []);
  });

  test('無変更ならマークなし', () => {
    const rows = buildSourceRows({ sourceText: 'a\nb', startLine: 1 });
    assert.deepEqual(computeDiffMarks(rows), []);
  });

  test('add/del は隣接していても種別ごとに別マークになり、比率は行位置に対応する', () => {
    const rows = buildSourceRows({
      sourceText: 'a\nb\nc',
      startLine: 1,
      addedLines: [2],
      deletedLines: [{ beforeLine: 2, text: 'old b' }],
    });
    // rows = [context a, del, add, context c] → 4 行中、del=1/4〜2/4, add=2/4〜3/4
    assert.deepEqual(computeDiffMarks(rows), [
      { kind: 'del', startRatio: 0.25, endRatio: 0.5 },
      { kind: 'add', startRatio: 0.5, endRatio: 0.75 },
    ]);
  });

  test('連続する追加行はまとめて 1 マークになる', () => {
    const rows = buildSourceRows({
      sourceText: 'a\nb\nc\nd',
      startLine: 1,
      addedLines: [2, 3],
    });
    assert.deepEqual(computeDiffMarks(rows), [{ kind: 'add', startRatio: 0.25, endRatio: 0.75 }]);
  });
});
