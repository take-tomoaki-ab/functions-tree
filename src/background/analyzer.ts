// SW 内でのコールグラフ構築。analyzer-core に GitHub API と拡張内 wasm を配線し、
// 解析結果を SW のメモリにキャッシュする（未認証レート制限 60 req/h の保護が主目的）。

import type { GithubResult } from '../shared/github';
import type { GraphPayload } from '../shared/graph';
import type { PrRef } from '../shared/messages';
import type { Analyzer, FetchFileResult } from './analyzer-core';
import { buildGraph, createAnalyzer, isAnalyzablePath } from './analyzer-core';
import { getFileContent, getPrFiles, getPrInfo } from './github-api';

// Parser / Language の初期化は 10ms 程度だが、SW の生存中は使い回す。
// SW が休止 → 再起動するとモジュールスコープごと消えるので、遅延初期化で包む。
let analyzerPromise: Promise<Analyzer> | null = null;

function getAnalyzer(): Promise<Analyzer> {
  analyzerPromise ??= createAnalyzer({
    runtimeWasm: chrome.runtime.getURL('wasm/web-tree-sitter.wasm'),
    typescriptWasm: chrome.runtime.getURL('wasm/tree-sitter-typescript.wasm'),
    tsxWasm: chrome.runtime.getURL('wasm/tree-sitter-tsx.wasm'),
  }).catch((e) => {
    analyzerPromise = null; // 初期化失敗は次回リトライできるように捨てる
    throw e;
  });
  return analyzerPromise;
}

// 解析結果のメモリキャッシュ。SW が生きている間だけ有効で、head が進むとキーが変わる。
const graphCache = new Map<string, GraphPayload>();

function cacheKey(pr: PrRef, headSha: string): string {
  return `${pr.owner}/${pr.repo}#${pr.pr}@${headSha}`;
}

/** BUILD_GRAPH の実体。GitHub API のエラーは GithubResult として呼び出し元に返す */
export async function buildGraphForPr(pr: PrRef): Promise<GithubResult<GraphPayload>> {
  const infoRes = await getPrInfo(pr);
  if (!infoRes.ok) return infoRes;
  const { headSha, headRepo } = infoRes.value;

  const key = cacheKey(pr, headSha);
  const cached = graphCache.get(key);
  if (cached) {
    console.info(`[functions-tree] graph cache hit: ${key}`);
    return { ok: true, authMode: infoRes.authMode, value: { ...cached, fromCache: true } };
  }

  const filesRes = await getPrFiles(pr);
  if (!filesRes.ok) return filesRes;
  const changedPaths = filesRes.value.files
    .filter((f) => f.status !== 'removed' && isAnalyzablePath(f.path))
    .map((f) => f.path);

  let analyzer: Analyzer;
  try {
    analyzer = await getAnalyzer();
  } catch (e) {
    return {
      ok: false,
      authMode: filesRes.authMode,
      error: {
        kind: 'unexpected',
        message: `tree-sitter の初期化に失敗: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }

  // 深さ 1 の依存取得も含め、ファイルの中身はすべて head 側リポジトリ + head SHA から引く
  let rateLimitError: GithubResult<GraphPayload> | null = null;
  const fetchFile = async (path: string): Promise<FetchFileResult> => {
    const r = await getFileContent(headRepo.owner, headRepo.repo, path, headSha);
    if (r.ok) return { ok: true, content: r.value.content };
    // レート制限は覚えておき、1 ファイルも解析できなかったときのエラー表示に使う
    if (r.error.kind === 'rate_limited') rateLimitError = r;
    return { ok: false, reason: r.error.kind };
  };

  const graph = await buildGraph(analyzer, changedPaths, fetchFile);
  if (rateLimitError && graph.analyzedFiles.length === 0) {
    return rateLimitError;
  }

  const payload: GraphPayload = { graph, headSha, fromCache: false };
  graphCache.set(key, payload);
  console.info(
    `[functions-tree] graph built: ${key} nodes=${graph.nodes.length} edges=${graph.edges.length} files=${graph.analyzedFiles.length} skipped=${graph.skippedFiles.length}`
  );
  return { ok: true, authMode: filesRes.authMode, value: payload };
}
