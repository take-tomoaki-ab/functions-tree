// 解析結果キャッシュのキー生成・ヒット判定ロジック（chrome.storage には非依存の純粋部分）。
// 実際の読み書き（chrome.storage.session）は analyzer.ts 側で配線する。

import type { FunctionGraph } from '../shared/graph';
import type { PrRef } from '../shared/messages';

/** chrome.storage に保存する 1 PR 分のキャッシュエントリ */
export interface CacheEntry {
  headSha: string;
  graph: FunctionGraph;
}

/**
 * PR ごとの storage キー。head SHA はキーに含めず値の中で持つ（新しいコミットが積まれる
 * たびにキーが増え続けるのを避け、常に 1 PR = 1 エントリに保つため）。
 */
export function cacheKey(pr: PrRef): string {
  return `graphCache:${pr.owner}/${pr.repo}#${pr.pr}`;
}

/**
 * 保存済みエントリと現在の head SHA からキャッシュを使ってよいか判定する。
 * forceRefresh（明示的な再解析）、エントリなし、head SHA 不一致（新しいコミット）は
 * いずれもキャッシュ不使用（null）。
 */
export function resolveCacheHit(
  entry: CacheEntry | null | undefined,
  headSha: string,
  forceRefresh: boolean
): FunctionGraph | null {
  if (forceRefresh || !entry) return null;
  if (entry.headSha !== headSha) return null;
  return entry.graph;
}
