// GitHub REST API クライアント。PAT を扱うため service worker 内でのみ使う。
// すべての関数は throw せず GithubResult<T> で返す（UI 側は describeGithubError で表示）。

import type {
  AuthMode,
  AuthTestPayload,
  FileContentPayload,
  GithubApiError,
  GithubResult,
  PrFile,
  PrFilesPayload,
  PrInfo,
  ReviewCommentInput,
  ReviewCommentPayload,
  ReviewSubmitPayload,
} from '../shared/github';
import type { PrRef } from '../shared/messages';
import { buildReviewRequestBody } from '../shared/review-drafts';
import { getPat } from '../shared/settings';

const API_BASE = 'https://api.github.com';

/** files API は 100 件/ページ。巨大 PR での暴走を避けるための取得上限 */
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 10;

/** contents API はこのサイズを超えると content を返さない */
const CONTENTS_SIZE_LIMIT = 1024 * 1024;

interface FetchOk {
  ok: true;
  authMode: AuthMode;
  res: Response;
}

interface FetchErr {
  ok: false;
  authMode: AuthMode;
  error: GithubApiError;
}

async function apiRequest(
  method: 'GET' | 'POST',
  pathAndQuery: string,
  body?: unknown
): Promise<FetchOk | FetchErr> {
  const pat = await getPat();
  const authMode: AuthMode = pat ? 'pat' : 'anonymous';
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (pat) headers['Authorization'] = `Bearer ${pat}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${pathAndQuery}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return {
      ok: false,
      authMode,
      error: { kind: 'network', message: e instanceof Error ? e.message : String(e) },
    };
  }
  if (res.ok) return { ok: true, authMode, res };
  return { ok: false, authMode, error: await toApiError(res) };
}

function apiGet(pathAndQuery: string): Promise<FetchOk | FetchErr> {
  return apiRequest('GET', pathAndQuery);
}

async function toApiError(res: Response): Promise<GithubApiError> {
  const status = res.status;
  let message = res.statusText;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'message' in body) {
      message = String((body as { message: unknown }).message);
      // 422 (Validation Failed) 等は errors 配列に具体的な理由が入る
      const errors = (body as { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const details = errors
          .map((e) =>
            e && typeof e === 'object'
              ? String(
                  (e as { message?: unknown; code?: unknown }).message ??
                    (e as { code?: unknown }).code ??
                    ''
                )
              : String(e)
          )
          .filter((s) => s.length > 0);
        if (details.length > 0) message += `（${details.join(' / ')}）`;
      }
    }
  } catch {
    // body が JSON でなくても statusText で続行
  }
  if (status === 401) return { kind: 'unauthorized', status, message };
  if (status === 403 || status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0' || /rate limit/i.test(message)) {
      const reset = res.headers.get('x-ratelimit-reset');
      return {
        kind: 'rate_limited',
        status,
        message,
        rateLimitReset: reset ? Number(reset) * 1000 : undefined,
      };
    }
    return { kind: 'forbidden', status, message };
  }
  if (status === 404) return { kind: 'not_found', status, message };
  return { kind: 'unexpected', status, message };
}

/** GET /repos/{owner}/{repo}/pulls/{n} — head SHA などのメタ情報 */
export async function getPrInfo(pr: PrRef): Promise<GithubResult<PrInfo>> {
  const r = await apiGet(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.pr}`);
  if (!r.ok) return r;
  const json = (await r.res.json()) as {
    title: string;
    state: string;
    head: { sha: string; repo: { name: string; owner: { login: string } } | null };
    base: { sha: string };
  };
  return {
    ok: true,
    authMode: r.authMode,
    value: {
      title: json.title,
      state: json.state,
      headSha: json.head.sha,
      baseSha: json.base.sha,
      // head.repo は fork が削除済みだと null。その場合は base 側リポジトリで引く
      headRepo: json.head.repo
        ? { owner: json.head.repo.owner.login, repo: json.head.repo.name }
        : { owner: pr.owner, repo: pr.repo },
    },
  };
}

/** GET /repos/{owner}/{repo}/pulls/{n}/files — 変更ファイル一覧（pagination 対応） */
export async function getPrFiles(pr: PrRef): Promise<GithubResult<PrFilesPayload>> {
  const files: PrFile[] = [];
  let authMode: AuthMode = 'anonymous';
  let truncated = false;

  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const r = await apiGet(
      `/repos/${pr.owner}/${pr.repo}/pulls/${pr.pr}/files?per_page=${FILES_PER_PAGE}&page=${page}`
    );
    if (!r.ok) return r;
    authMode = r.authMode;
    const json = (await r.res.json()) as Array<{
      filename: string;
      previous_filename?: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }>;
    for (const f of json) {
      files.push({
        path: f.filename,
        previousPath: f.previous_filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      });
    }
    const hasNext = /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(r.res.headers.get('link') ?? '');
    if (json.length < FILES_PER_PAGE || !hasNext) {
      return { ok: true, authMode, value: { files, truncated: false } };
    }
    truncated = page === MAX_FILE_PAGES;
  }
  return { ok: true, authMode, value: { files, truncated } };
}

/** contents API の base64（改行入り）を UTF-8 テキストにデコードする */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** GET /repos/{owner}/{repo}/contents/{path}?ref={sha} — ファイル内容 */
export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<GithubResult<FileContentPayload>> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const r = await apiGet(
    `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
  );
  if (!r.ok) return r;
  const json = (await r.res.json()) as
    | { type: string; size: number; encoding?: string; content?: string }
    | unknown[];

  if (Array.isArray(json) || json.type !== 'file') {
    return {
      ok: false,
      authMode: r.authMode,
      error: { kind: 'unexpected', message: `ファイルではありません: ${path}` },
    };
  }
  if (json.encoding !== 'base64' || typeof json.content !== 'string' || json.size > CONTENTS_SIZE_LIMIT) {
    // 1MB 超は encoding: "none" で content が空になる
    return {
      ok: false,
      authMode: r.authMode,
      error: { kind: 'too_large', message: `size=${json.size}: ${path}` },
    };
  }
  return {
    ok: true,
    authMode: r.authMode,
    value: { path, ref, size: json.size, content: decodeBase64Utf8(json.content) },
  };
}

/**
 * GET /repos/{owner}/{repo}/contents/{dir}?ref={sha} — ディレクトリ直下のファイル一覧。
 * Go のパッケージ解決（ディレクトリ = パッケージ）に使う。dir は '' でリポジトリルート。
 */
export async function listDirectory(
  owner: string,
  repo: string,
  dir: string,
  ref: string
): Promise<GithubResult<string[]>> {
  const encodedPath = dir
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/');
  const r = await apiGet(
    `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
  );
  if (!r.ok) return r;
  const json = (await r.res.json()) as unknown;
  if (!Array.isArray(json)) {
    return {
      ok: false,
      authMode: r.authMode,
      error: { kind: 'unexpected', message: `ディレクトリではありません: ${dir}` },
    };
  }
  const paths = json
    .filter(
      (e): e is { type: string; path: string } =>
        !!e &&
        typeof e === 'object' &&
        (e as { type?: unknown }).type === 'file' &&
        typeof (e as { path?: unknown }).path === 'string'
    )
    .map((e) => e.path);
  return { ok: true, authMode: r.authMode, value: paths };
}

/**
 * POST /repos/{owner}/{repo}/pulls/{n}/comments — レビューコメント投稿。
 * line は diff（patch）の RIGHT サイドに含まれる行であること。
 * PAT 未設定なら API を呼ばずに kind: 'pat_required' を返す
 * （UI 側のボタン無効化と合わせた二重防御）。
 */
export async function postReviewComment(
  pr: PrRef,
  params: { commitId: string; path: string; line: number; body: string }
): Promise<GithubResult<ReviewCommentPayload>> {
  const pat = await getPat();
  if (!pat) {
    return {
      ok: false,
      authMode: 'anonymous',
      error: {
        kind: 'pat_required',
        message: 'コメント投稿には PAT の設定が必要です',
      },
    };
  }
  const r = await apiRequest(
    'POST',
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.pr}/comments`,
    {
      body: params.body,
      commit_id: params.commitId,
      path: params.path,
      line: params.line,
      side: 'RIGHT',
    }
  );
  if (!r.ok) return r;
  const json = (await r.res.json()) as { html_url: string; id: number };
  return {
    ok: true,
    authMode: r.authMode,
    value: { htmlUrl: json.html_url, id: json.id },
  };
}

/**
 * POST /repos/{owner}/{repo}/pulls/{n}/reviews — 溜めた下書きを 1 つのレビューとして
 * まとめて投稿する。event: 'COMMENT' なので approve / request changes にはならない。
 * 各コメントの line は diff（patch）の RIGHT サイドに含まれる行であること。
 * 1 行でも invalid だと 422 で全体が失敗する（部分投稿はされない）ため、
 * 呼び出し側は失敗時に下書きを消さずユーザーが修正して再送できるようにする。
 * PAT 未設定なら API を呼ばずに kind: 'pat_required' を返す（UI 側と二重防御）。
 */
export async function submitReview(
  pr: PrRef,
  params: { commitId: string; comments: ReviewCommentInput[] }
): Promise<GithubResult<ReviewSubmitPayload>> {
  const pat = await getPat();
  if (!pat) {
    return {
      ok: false,
      authMode: 'anonymous',
      error: {
        kind: 'pat_required',
        message: 'レビュー投稿には PAT の設定が必要です',
      },
    };
  }
  if (params.comments.length === 0) {
    return {
      ok: false,
      authMode: 'pat',
      error: { kind: 'unexpected', message: '下書きが 1 件もありません' },
    };
  }
  const r = await apiRequest(
    'POST',
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.pr}/reviews`,
    buildReviewRequestBody(params.commitId, params.comments)
  );
  if (!r.ok) return r;
  const json = (await r.res.json()) as { html_url: string; id: number };
  return {
    ok: true,
    authMode: r.authMode,
    value: { htmlUrl: json.html_url, id: json.id },
  };
}

/** PAT があれば GET /user で有効性確認、なければ GET /rate_limit で疎通確認 */
export async function testAuth(): Promise<GithubResult<AuthTestPayload>> {
  const pat = await getPat();
  if (pat) {
    const r = await apiGet('/user');
    if (!r.ok) return r;
    const json = (await r.res.json()) as { login: string };
    return {
      ok: true,
      authMode: r.authMode,
      value: {
        authenticated: true,
        login: json.login,
        rateLimit: rateLimitFromHeaders(r.res.headers),
      },
    };
  }
  const r = await apiGet('/rate_limit');
  if (!r.ok) return r;
  const json = (await r.res.json()) as {
    resources: { core: { limit: number; remaining: number; reset: number } };
  };
  return {
    ok: true,
    authMode: r.authMode,
    value: { authenticated: false, rateLimit: json.resources.core },
  };
}

function rateLimitFromHeaders(
  headers: Headers
): AuthTestPayload['rateLimit'] {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (limit == null || remaining == null || reset == null) return undefined;
  return { limit: Number(limit), remaining: Number(remaining), reset: Number(reset) };
}
