// review-drafts（下書きキューの状態管理と SUBMIT_REVIEW のリクエスト組み立て）の
// ユニットテスト。純粋ロジックなので Node 上でそのまま検証できる。
// 実行前に pretest（esbuild）が dist-test/review-drafts.mjs を生成する。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildReviewRequestBody,
  draftStorageKey,
  findDraft,
  parseDrafts,
  removeDraft,
  upsertDraft,
} from '../dist-test/review-drafts.mjs';

const draft = (overrides = {}) => ({
  nodeId: 'src/a.ts#foo@10',
  nodeName: 'foo',
  path: 'src/a.ts',
  line: 12,
  body: 'ここは早期 return にできそう',
  ...overrides,
});

describe('draftStorageKey', () => {
  test('owner/repo#pr を含むキーになる', () => {
    const key = draftStorageKey({ owner: 'honojs', repo: 'hono', pr: 5140 });
    assert.equal(key, 'reviewDrafts:honojs/hono#5140');
  });

  test('PR が違えば別のキーになる（キューが PR 単位で分離される）', () => {
    const a = draftStorageKey({ owner: 'o', repo: 'r', pr: 1 });
    const b = draftStorageKey({ owner: 'o', repo: 'r', pr: 2 });
    const c = draftStorageKey({ owner: 'o', repo: 'r2', pr: 1 });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });
});

describe('upsertDraft', () => {
  test('新規ノードの下書きは末尾に追加される', () => {
    const d1 = draft();
    const d2 = draft({ nodeId: 'src/b.ts#bar@5', nodeName: 'bar', path: 'src/b.ts' });
    const result = upsertDraft([d1], d2);
    assert.deepEqual(result, [d1, d2]);
  });

  test('同一ノードの下書きは位置を保ったまま置き換わる（編集）', () => {
    const d1 = draft();
    const d2 = draft({ nodeId: 'src/b.ts#bar@5' });
    const edited = draft({ body: '修正後の本文', line: 14 });
    const result = upsertDraft([d1, d2], edited);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], edited);
    assert.deepEqual(result[1], d2);
  });

  test('元の配列は変更しない（イミュータブル）', () => {
    const original = [draft()];
    upsertDraft(original, draft({ nodeId: 'x#y@1' }));
    upsertDraft(original, draft({ body: 'changed' }));
    assert.equal(original.length, 1);
    assert.equal(original[0].body, 'ここは早期 return にできそう');
  });
});

describe('removeDraft / findDraft', () => {
  test('指定ノードの下書きだけが取り除かれる', () => {
    const d1 = draft();
    const d2 = draft({ nodeId: 'src/b.ts#bar@5' });
    const result = removeDraft([d1, d2], d1.nodeId);
    assert.deepEqual(result, [d2]);
  });

  test('存在しないノード ID の削除は no-op（元の配列も壊さない）', () => {
    const original = [draft()];
    const result = removeDraft(original, 'nope#nope@1');
    assert.deepEqual(result, original);
    assert.equal(original.length, 1);
  });

  test('findDraft はノード ID で引ける（なければ undefined）', () => {
    const d1 = draft();
    assert.deepEqual(findDraft([d1], d1.nodeId), d1);
    assert.equal(findDraft([d1], 'nope#nope@1'), undefined);
  });
});

describe('parseDrafts（storage.session からの読み戻し検証）', () => {
  test('正しい配列はそのまま復元される（ラウンドトリップ）', () => {
    const list = [draft(), draft({ nodeId: 'src/b.ts#bar@5', line: 7 })];
    const roundTripped = parseDrafts(JSON.parse(JSON.stringify(list)));
    assert.deepEqual(roundTripped, list);
  });

  test('配列でない値（undefined / オブジェクト / 文字列）は空キューになる', () => {
    assert.deepEqual(parseDrafts(undefined), []);
    assert.deepEqual(parseDrafts(null), []);
    assert.deepEqual(parseDrafts({ nodeId: 'x' }), []);
    assert.deepEqual(parseDrafts('[]'), []);
  });

  test('形の壊れた要素は黙って捨てられ、正しい要素だけ残る', () => {
    const ok = draft();
    const result = parseDrafts([
      ok,
      null,
      'junk',
      { ...draft(), nodeId: '' }, // 空 nodeId
      { ...draft(), line: 0 }, // 行番号は 1 始まり
      { ...draft(), line: 1.5 }, // 整数でない
      { ...draft(), line: '12' }, // 型違い
      { ...draft(), body: '   ' }, // 空白のみの本文
      { nodeId: 'a#b@1', nodeName: 'b', path: 'a' }, // フィールド不足
    ]);
    assert.deepEqual(result, [ok]);
  });
});

describe('buildReviewRequestBody（POST /pulls/{n}/reviews の組み立て）', () => {
  test('commit_id / event: COMMENT / side: RIGHT の形になり、順序が保たれる', () => {
    const body = buildReviewRequestBody('abc123', [
      { path: 'src/a.ts', line: 12, body: 'コメント 1' },
      { path: 'src/b.ts', line: 7, body: 'コメント 2' },
    ]);
    assert.deepEqual(body, {
      commit_id: 'abc123',
      event: 'COMMENT',
      comments: [
        { path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'コメント 1' },
        { path: 'src/b.ts', line: 7, side: 'RIGHT', body: 'コメント 2' },
      ],
    });
  });

  test('下書きの UI 用フィールド（nodeId / nodeName）は API ボディに漏れない', () => {
    const body = buildReviewRequestBody('abc123', [draft()]);
    assert.deepEqual(Object.keys(body.comments[0]).sort(), [
      'body',
      'line',
      'path',
      'side',
    ]);
  });
});
