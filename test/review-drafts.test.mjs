// review-drafts（GitHub pending review まわりの純粋ロジック）のユニットテスト。
// リクエストボディの組み立て・API 応答のデシリアライズ・ノードとの対応付けを
// Node 上でそのまま検証できる。
// 実行前に pretest（esbuild）が dist-test/review-drafts.mjs を生成する。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildPendingReviewCreateBody,
  draftNodeIds,
  findCommentForNode,
  parsePendingComments,
} from '../dist-test/review-drafts.mjs';

const comment = (overrides = {}) => ({
  id: 'PRRC_node101',
  path: 'src/a.ts',
  line: 12,
  body: 'ここは早期 return にできそう',
  ...overrides,
});

const node = (overrides = {}) => ({
  id: 'src/a.ts#foo@10',
  filePath: 'src/a.ts',
  commentableLines: [11, 12, 13],
  ...overrides,
});

describe('buildPendingReviewCreateBody（POST /pulls/{n}/reviews の組み立て）', () => {
  test('commit_id + コメント 1 件（side: RIGHT）で、event を含まない（= PENDING で作成）', () => {
    const body = buildPendingReviewCreateBody('abc123', {
      path: 'src/a.ts',
      line: 12,
      body: 'コメント 1',
    });
    assert.deepEqual(body, {
      commit_id: 'abc123',
      comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'コメント 1' }],
    });
    assert.equal('event' in body, false);
  });

  test('余計なフィールドは API ボディに漏れない', () => {
    const body = buildPendingReviewCreateBody('abc123', {
      path: 'src/a.ts',
      line: 12,
      body: 'x',
      extra: 'leak',
    });
    assert.deepEqual(Object.keys(body.comments[0]).sort(), [
      'body',
      'line',
      'path',
      'side',
    ]);
  });
});

describe('parsePendingComments（GraphQL のコメントノード配列の読み戻し検証）', () => {
  test('正しい配列は必要なフィールドだけ抜き出して復元される', () => {
    const apiComment = {
      id: 'PRRC_node101',
      path: 'src/a.ts',
      line: 12,
      body: '本文',
      url: 'https://example.invalid/ignored',
      author: { login: 'someone' },
    };
    assert.deepEqual(parsePendingComments([apiComment]), [
      { id: 'PRRC_node101', path: 'src/a.ts', line: 12, body: '本文' },
    ]);
  });

  test('配列でない値（undefined / オブジェクト / 文字列）は空になる', () => {
    assert.deepEqual(parsePendingComments(undefined), []);
    assert.deepEqual(parsePendingComments(null), []);
    assert.deepEqual(parsePendingComments({ id: 'x' }), []);
    assert.deepEqual(parsePendingComments('[]'), []);
  });

  test('形の壊れた要素は黙って捨てられ、正しい要素だけ残る', () => {
    const ok = comment();
    const result = parsePendingComments([
      ok,
      null,
      'junk',
      { ...comment(), id: 101 }, // id が文字列でない
      { ...comment(), id: '' }, // 空 id
      { ...comment(), path: '' }, // 空 path
      { ...comment(), body: 42 }, // body が文字列でない
      { path: 'a.ts', line: 1, body: 'x' }, // id 不足
    ]);
    assert.deepEqual(result, [ok]);
  });

  test('line が無い / 不正（outdated 等）なら null になる', () => {
    const result = parsePendingComments([
      { ...comment(), line: null },
      { ...comment(), id: 'PRRC_node102', line: 0 },
      { ...comment(), id: 'PRRC_node103', line: 1.5 },
      { ...comment(), id: 'PRRC_node104', line: undefined },
    ]);
    assert.deepEqual(
      result.map((c) => [c.id, c.line]),
      [
        ['PRRC_node101', null],
        ['PRRC_node102', null],
        ['PRRC_node103', null],
        ['PRRC_node104', null],
      ]
    );
  });
});

describe('findCommentForNode（ノード ⇔ 下書きコメントの対応付け）', () => {
  test('path が一致しコメント可能行に載っているコメントが引ける', () => {
    const c = comment();
    assert.deepEqual(findCommentForNode([c], node()), c);
  });

  test('path 違い / 行がコメント可能行に無い / 行なし はマッチしない', () => {
    assert.equal(
      findCommentForNode([comment({ path: 'src/b.ts' })], node()),
      undefined
    );
    assert.equal(findCommentForNode([comment({ line: 99 })], node()), undefined);
    assert.equal(findCommentForNode([comment({ line: null })], node()), undefined);
  });

  test('複数マッチする場合は先頭を返す（フォームの編集対象が安定する）', () => {
    const first = comment({ id: 'PRRC_a', line: 11 });
    const second = comment({ id: 'PRRC_b', line: 12 });
    assert.deepEqual(findCommentForNode([first, second], node()), first);
  });
});

describe('draftNodeIds（グラフ上の下書きマーク対象）', () => {
  test('下書きのあるノードの ID だけが集合に入る', () => {
    const nodes = [
      node(),
      node({ id: 'src/b.ts#bar@5', filePath: 'src/b.ts', commentableLines: [7] }),
      node({ id: 'src/c.ts#baz@1', filePath: 'src/c.ts', commentableLines: [2] }),
    ];
    const comments = [comment(), comment({ id: 'PRRC_node102', path: 'src/b.ts', line: 7 })];
    const ids = draftNodeIds(comments, nodes);
    assert.deepEqual([...ids].sort(), ['src/a.ts#foo@10', 'src/b.ts#bar@5']);
  });

  test('下書きが無ければ空集合', () => {
    assert.equal(draftNodeIds([], [node()]).size, 0);
  });
});
