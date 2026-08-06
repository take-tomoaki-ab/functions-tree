// SW 内でのコールグラフ構築。analyzer-core に GitHub API と拡張内 wasm を配線し、
// 解析結果を chrome.storage.session にキャッシュする（未認証レート制限 60 req/h の保護、
// および issue #13: パネルの開閉・SW のサスペンド/再起動をまたいだ再計算回避が目的）。

import type { GithubResult } from '../shared/github';
import type { GraphPayload } from '../shared/graph';
import type { PrRef } from '../shared/messages';
import type { Analyzer, FetchFileResult, ListDirResult } from './analyzer-core';
import { hasTokenFor } from '../shared/settings';
import { buildGraph, createAnalyzer, isAnalyzablePath } from './analyzer-core';
import { getFileContent, getPrFiles, getPrInfo, listDirectory } from './github-api';
import type { CacheEntry } from './graph-cache';
import { cacheKey, resolveCacheHit } from './graph-cache';

// Parser / Language の初期化は 10ms 程度だが、SW の生存中は使い回す。
// SW が休止 → 再起動するとモジュールスコープごと消えるので、遅延初期化で包む。
let analyzerPromise: Promise<Analyzer> | null = null;

function getAnalyzer(): Promise<Analyzer> {
  analyzerPromise ??= createAnalyzer({
    runtimeWasm: chrome.runtime.getURL('wasm/web-tree-sitter.wasm'),
    grammars: {
      typescript: chrome.runtime.getURL('wasm/tree-sitter-typescript.wasm'),
      tsx: chrome.runtime.getURL('wasm/tree-sitter-tsx.wasm'),
      go: chrome.runtime.getURL('wasm/tree-sitter-go.wasm'),
      python: chrome.runtime.getURL('wasm/tree-sitter-python.wasm'),
    },
  }).catch((e) => {
    analyzerPromise = null; // 初期化失敗は次回リトライできるように捨てる
    throw e;
  });
  return analyzerPromise;
}

/**
 * chrome.storage.session からキャッシュエントリを読む。MV3 の SW はモジュールスコープの
 * 変数を保持できない（休止 → 再起動で消える）ため、storage.session に永続化することで
 * パネルの開閉や SW 再起動をまたいだキャッシュヒットを実現する。読み取り失敗時は
 * キャッシュなし扱いにして通常の解析にフォールバックする。
 */
async function readCache(key: string): Promise<CacheEntry | null> {
  try {
    const stored = await chrome.storage.session.get(key);
    const entry = stored[key] as CacheEntry | undefined;
    return entry ?? null;
  } catch (e) {
    console.warn(`[functions-tree] graph cache read failed: ${key}`, e);
    return null;
  }
}

/**
 * 容量制限（storage.session は約 10MB）超過等で書き込みに失敗しても、解析結果自体は
 * 呼び出し元に返せているので、ここでは警告ログのみに留めてエラーにしない。
 */
async function writeCache(key: string, entry: CacheEntry): Promise<void> {
  try {
    await chrome.storage.session.set({ [key]: entry });
  } catch (e) {
    console.warn(`[functions-tree] graph cache write failed: ${key}`, e);
  }
}

/**
 * BUILD_GRAPH の実体。GitHub API のエラーは GithubResult として呼び出し元に返す。
 * forceRefresh: true の場合はキャッシュを読まず必ず再解析する（明示的な再解析ボタン用）。
 */
export async function buildGraphForPr(
  pr: PrRef,
  opts: { forceRefresh?: boolean } = {}
): Promise<GithubResult<GraphPayload>> {
  const infoRes = await getPrInfo(pr);
  if (!infoRes.ok) return infoRes;
  const { headSha, headRepo } = infoRes.value;

  const key = cacheKey(pr);
  const cachedEntry = await readCache(key);
  const cachedGraph = resolveCacheHit(cachedEntry, headSha, opts.forceRefresh ?? false);
  if (cachedGraph) {
    console.info(`[functions-tree] graph cache hit: ${key}@${headSha}`);
    return {
      ok: true,
      authMode: infoRes.authMode,
      value: { graph: cachedGraph, headSha, fromCache: true },
    };
  }

  const filesRes = await getPrFiles(pr);
  if (!filesRes.ok) return filesRes;
  // patch は行レベルのコメント可否判定（GraphNode.commentableLines）に使う
  const changedFiles = filesRes.value.files
    .filter((f) => f.status !== 'removed' && isAnalyzablePath(f.path))
    .map((f) => ({ path: f.path, patch: f.patch }));

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

  // 深さ 1 の依存取得も含め、ファイルの中身はすべて head 側リポジトリ + head SHA から引く。
  // fork PR では head 側が別 owner のリポジトリになる。fine-grained token は
  // 明示的に選択したリポジトリしかアクセスできず、しかもスコープ外は 404 で返るため、
  // 「PR は読めるのに中身が 1 つも取れない」状態が起こりうる。空グラフを黙って返すと
  // 原因が分からないので、fork 由来の失敗は種別を分けて明示的に通知する。
  // 実際にここに落ちるのは private な base + 別 owner の fork のケースだけで、
  // public な fork は下の contentAuthOwner のフォールバックで読める。
  const isFork = headRepo.owner.toLowerCase() !== pr.owner.toLowerCase();
  const forkRepo = `${headRepo.owner}/${headRepo.repo}`;

  // fork PR で head 側 owner のトークンが無いときは base 側 owner のトークンで引く。
  // fine-grained token は選択したリポジトリに加えて全 public リポジトリの read を
  // 常に含むため、public な fork はこれで読める。未認証（60 req/h）に落とすと
  // fork PR の解析がレート制限で成立しなくなるので、ここは必ず認証を通す。
  // private な fork は base 側トークンでも 404 になり、fork_unreadable として通知する。
  const contentAuthOwner =
    isFork && !(await hasTokenFor(headRepo.owner)) ? pr.owner : headRepo.owner;

  let rateLimitError: GithubResult<GraphPayload> | null = null;
  let forkError: GithubResult<GraphPayload> | null = null;

  /** 取得失敗を skippedFiles の reason 文字列に落とす。fork 由来は別種別にする */
  const classify = (error: { kind: string }, authMode: GithubResult<never>['authMode']): string => {
    if (isFork && (error.kind === 'not_found' || error.kind === 'forbidden')) {
      forkError ??= {
        ok: false,
        authMode,
        error: {
          kind: 'fork_unreadable',
          message: `fork 元リポジトリ ${forkRepo} のファイルを取得できません`,
          forkRepo,
          owner: headRepo.owner,
        },
      };
      return 'fork_unreadable';
    }
    return error.kind;
  };

  const fetchFile = async (path: string): Promise<FetchFileResult> => {
    const r = await getFileContent(headRepo.owner, headRepo.repo, path, headSha, contentAuthOwner);
    if (r.ok) return { ok: true, content: r.value.content };
    // レート制限は覚えておき、1 ファイルも解析できなかったときのエラー表示に使う
    if (r.error.kind === 'rate_limited') rateLimitError = r;
    return { ok: false, reason: classify(r.error, r.authMode) };
  };

  // Go のパッケージ解決用（ディレクトリ = パッケージ）。contents API はディレクトリも引ける
  const listDir = async (dir: string): Promise<ListDirResult> => {
    const r = await listDirectory(headRepo.owner, headRepo.repo, dir, headSha, contentAuthOwner);
    if (r.ok) return { ok: true, paths: r.value };
    if (r.error.kind === 'rate_limited') rateLimitError = r;
    return { ok: false, reason: classify(r.error, r.authMode) };
  };

  const graph = await buildGraph(analyzer, changedFiles, fetchFile, { listDir });
  if (rateLimitError && graph.analyzedFiles.length === 0) {
    return rateLimitError;
  }
  // 1 ファイルも解析できず、原因が fork 側の読めなさなら空グラフではなくエラーを返す
  if (forkError && graph.analyzedFiles.length === 0) {
    return forkError;
  }

  const payload: GraphPayload = { graph, headSha, fromCache: false };
  await writeCache(key, { headSha, graph });
  console.info(
    `[functions-tree] graph built: ${key}@${headSha} nodes=${graph.nodes.length} edges=${graph.edges.length} files=${graph.analyzedFiles.length} skipped=${graph.skippedFiles.length}`
  );
  return { ok: true, authMode: filesRes.authMode, value: payload };
}
