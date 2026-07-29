// source-segments（ソース 1 行を描画単位へ分割し、識別子を切り出す）のユニットテスト。
// DOM に依存しない純粋ロジックなので Node 上でそのまま検証できる。
// 実行前に pretest（esbuild）が dist-test/source-segments.mjs を生成する。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { splitSourceSegments } from '../dist-test/source-segments.mjs';

/** 識別子として拾われたテキストの一覧 */
const identifiers = (segments) =>
  segments.filter((s) => s.identifier === true).map((s) => s.text);

describe('splitSourceSegments', () => {
  test('セグメントの text を連結すると元の行テキストに戻る', () => {
    const text = 'const total = items.length + 1; // 合計';
    const tokens = [
      [0, 5, 'keyword'],
      [31, 38, 'comment'],
    ];
    const segments = splitSourceSegments(text, tokens);
    assert.equal(segments.map((s) => s.text).join(''), text);
  });

  test('ハイライトされない隙間から識別子だけを切り出す（記号・空白は無装飾）', () => {
    // 'let x = y;' の 'let' のみ keyword
    const segments = splitSourceSegments('let x = y;', [[0, 3, 'keyword']]);
    assert.deepEqual(segments, [
      { text: 'let', kind: 'keyword' },
      { text: ' ' },
      { text: 'x', identifier: true },
      { text: ' = ' },
      { text: 'y', identifier: true },
      { text: ';' },
    ]);
  });

  test('メンバーアクセスはドットで区切って両方を識別子にする', () => {
    assert.deepEqual(identifiers(splitSourceSegments('obj.prop.value', [])), [
      'obj',
      'prop',
      'value',
    ]);
  });

  test('function / type のトークンは識別子として選択できる', () => {
    // 'render(props)' の 'render' が function
    const segments = splitSourceSegments('render(props)', [[0, 6, 'function']]);
    assert.deepEqual(segments, [
      { text: 'render', kind: 'function', identifier: true },
      { text: '(' },
      { text: 'props', identifier: true },
      { text: ')' },
    ]);
  });

  test('keyword / string / comment / number / constant のトークンは識別子にしない', () => {
    const cases = [
      ['return', 'keyword'],
      ['"text"', 'string'],
      ['// memo', 'comment'],
      ['42', 'number'],
      ['null', 'constant'],
      ['true', 'constant'],
    ];
    for (const [text, kind] of cases) {
      const segments = splitSourceSegments(text, [[0, text.length, kind]]);
      assert.deepEqual(segments, [{ text, kind }], `${kind}: ${text}`);
    }
  });

  test('文字列・コメントの中身は識別子として拾わない（トークンで塗られているため）', () => {
    // 'log("total")' の '"total"' が string
    const segments = splitSourceSegments('log("total")', [
      [0, 3, 'function'],
      [4, 11, 'string'],
    ]);
    assert.deepEqual(identifiers(segments), ['log']);
  });

  test('複数の識別子を含む型トークン（Python の `dict[str, int]` 等）は選択対象にしない', () => {
    const text = 'dict[str, int]';
    assert.deepEqual(splitSourceSegments(text, [[0, text.length, 'type']]), [
      { text, kind: 'type' },
    ]);
  });

  test('数字を含む名前・アンダースコア・$・非 ASCII も 1 つの識別子として扱う', () => {
    assert.deepEqual(
      identifiers(splitSourceSegments('foo2 + _bar + $baz + 合計', [])),
      ['foo2', '_bar', '$baz', '合計']
    );
  });

  test('数字から始まる並びは識別子にしない', () => {
    assert.deepEqual(identifiers(splitSourceSegments('1px 2 3abc', [])), ['px', 'abc']);
  });

  test('範囲外・逆順のトークンは無視して素のテキストとして扱う', () => {
    // [10,20) は範囲外、[3,1) は逆順 → どちらも捨てるが text は失われない
    const segments = splitSourceSegments('abc', [
      [10, 20, 'keyword'],
      [3, 1, 'string'],
    ]);
    assert.deepEqual(segments, [{ text: 'abc', identifier: true }]);
  });

  test('トークンが空（削除行など）でも識別子は拾える', () => {
    assert.deepEqual(identifiers(splitSourceSegments('  logger.info(msg);', [])), [
      'logger',
      'info',
      'msg',
    ]);
  });

  test('空行は空のセグメントリストになる', () => {
    assert.deepEqual(splitSourceSegments('', []), []);
  });
});
