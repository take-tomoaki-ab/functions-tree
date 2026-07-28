// 解析結果キャッシュ（cacheKey / resolveCacheHit）のユニットテスト。純粋ロジックなので
// chrome.storage には依存しない。実行前に pretest（esbuild）が dist-test/graph-cache.mjs を生成する。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cacheKey, resolveCacheHit } from '../dist-test/graph-cache.mjs';

const PR = { owner: 'honojs', repo: 'hono', pr: 4200 };
const GRAPH = { nodes: [], edges: [], analyzedFiles: [], skippedFiles: [], unresolvedCallCount: 0 };

describe('cacheKey', () => {
  test('owner/repo/PR番号から一意なキーを作る（head SHA は含まない）', () => {
    assert.equal(cacheKey(PR), 'graphCache:honojs/hono#4200');
  });

  test('PR 番号が違えばキーも変わる', () => {
    assert.notEqual(cacheKey(PR), cacheKey({ ...PR, pr: 4201 }));
  });
});

describe('resolveCacheHit', () => {
  test('エントリなしはキャッシュミス', () => {
    assert.equal(resolveCacheHit(null, 'sha1', false), null);
    assert.equal(resolveCacheHit(undefined, 'sha1', false), null);
  });

  test('head SHA が一致すればキャッシュヒット（グラフを返す）', () => {
    const entry = { headSha: 'sha1', graph: GRAPH };
    assert.equal(resolveCacheHit(entry, 'sha1', false), GRAPH);
  });

  test('head SHA が不一致（新しいコミット）ならキャッシュミス', () => {
    const entry = { headSha: 'sha-old', graph: GRAPH };
    assert.equal(resolveCacheHit(entry, 'sha-new', false), null);
  });

  test('forceRefresh: true なら head SHA が一致していてもキャッシュミス扱い', () => {
    const entry = { headSha: 'sha1', graph: GRAPH };
    assert.equal(resolveCacheHit(entry, 'sha1', true), null);
  });
});
