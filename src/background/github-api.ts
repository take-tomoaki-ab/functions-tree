// GitHub REST API クライアント。PAT を扱うため service worker 内でのみ使う。
// すべての関数は throw せず GithubResult<T> で返す（UI 側は describeGithubError で表示）。

import type {
  AuthMode,
  AuthTestPayload,
  FileContentPayload,
  GithubApiError,
  GithubResult,
  PendingReviewPayload,
  PrFile,
  PrFilesPayload,
  PrInfo,
  ReviewSubmitPayload,
} from '../shared/github';
import type { PrRef } from '../shared/messages';
import { buildPendingReviewCreateBody, parsePendingComments } from '../shared/review-drafts';
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

/** PAT 必須の操作で PAT が無いときに返す共通エラー */
function patRequired(message: string): FetchErr {
  return {
    ok: false,
    authMode: 'anonymous',
    error: { kind: 'pat_required', message },
  };
}

/**
 * POST /graphql — pending review の取得・操作に使う（pending 状態のレビュー
 * コメントは REST からは見えず、PATCH / DELETE も効かないため）。
 * GraphQL はエラーでも HTTP 200 で errors 配列を返すため、ここで GithubApiError に写す。
 */
async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<{ ok: true; authMode: AuthMode; data: T } | FetchErr> {
  const r = await apiRequest('POST', '/graphql', { query, variables });
  if (!r.ok) return r;
  const json = (await r.res.json()) as {
    data?: T;
    errors?: Array<{ message?: unknown }>;
  };
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const message = json.errors
      .map((e) => String(e?.message ?? ''))
      .filter((s) => s.length > 0)
      .join(' / ');
    return {
      ok: false,
      authMode: r.authMode,
      error: { kind: 'unexpected', message: message || 'GraphQL エラー' },
    };
  }
  if (json.data === undefined || json.data === null) {
    return {
      ok: false,
      authMode: r.authMode,
      error: { kind: 'unexpected', message: 'GraphQL 応答に data がありません' },
    };
  }
  return { ok: true, authMode: r.authMode, data: json.data };
}

/** GraphQL で取得する pending review の応答形 */
interface PendingReviewQueryData {
  repository: {
    pullRequest: {
      reviews: {
        nodes: Array<{
          id: string;
          comments: { nodes: unknown[] };
        } | null>;
      };
    } | null;
  } | null;
}

/**
 * 認証ユーザーの pending review とそのコメント一覧を GraphQL で取得する。
 * reviews(states: PENDING) は認証ユーザー本人の pending review だけを返す
 * （他人のものは見えず、1 PR につき 1 つまで）。
 */
async function fetchPendingReview(
  pr: PrRef
): Promise<{ ok: true; authMode: AuthMode; value: PendingReviewPayload } | FetchErr> {
  const r = await graphqlRequest<PendingReviewQueryData>(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviews(states: PENDING, first: 1) {
            nodes { id comments(first: 100) { nodes { id path line body } } }
          }
        }
      }
    }`,
    { owner: pr.owner, name: pr.repo, number: pr.pr }
  );
  if (!r.ok) return r;
  const pullRequest = r.data.repository?.pullRequest;
  if (!pullRequest) {
    return {
      ok: false,
      authMode: r.authMode,
      error: { kind: 'not_found', message: `PR が見つかりません: ${pr.owner}/${pr.repo}#${pr.pr}` },
    };
  }
  const pending = pullRequest.reviews.nodes.find((n) => n !== null) ?? null;
  if (!pending) {
    return { ok: true, authMode: r.authMode, value: { reviewId: null, comments: [] } };
  }
  return {
    ok: true,
    authMode: r.authMode,
    value: {
      reviewId: pending.id,
      comments: parsePendingComments(pending.comments.nodes),
    },
  };
}

/**
 * pending review の現在の状態を取得する。PAT 未設定時はエラーではなく
 * 「pending review なし」を返す（未認証では pending review は存在し得ないため、
 * パネルを開いただけでエラー表示にならないようにする）。
 */
export async function getPendingReview(
  pr: PrRef
): Promise<GithubResult<PendingReviewPayload>> {
  const pat = await getPat();
  if (!pat) {
    return {
      ok: true,
      authMode: 'anonymous',
      value: { reviewId: null, comments: [] },
    };
  }
  return fetchPendingReview(pr);
}

/**
 * pending review に下書きコメントを 1 件追加する。
 * - pending review が無い: POST /pulls/{n}/reviews（event なし = PENDING）で
 *   コメント込みのレビューを作成する（REST で作成は可能。見えないのは pending の
 *   コメント取得・更新・削除だけ）
 * - ある: GraphQL の addPullRequestReviewThread で追記する
 * どちらも成功後に取得し直した pending review 全体を返す（GitHub 側が正）。
 * line が diff の RIGHT サイドに無い場合などは失敗する（下書きは増えない）。
 */
export async function addPendingComment(
  pr: PrRef,
  params: { commitId: string; path: string; line: number; body: string }
): Promise<GithubResult<PendingReviewPayload>> {
  const pat = await getPat();
  if (!pat) return patRequired('下書きの追加には PAT の設定が必要です');

  const state = await fetchPendingReview(pr);
  if (!state.ok) return state;

  if (state.value.reviewId === null) {
    const r = await apiRequest(
      'POST',
      `/repos/${pr.owner}/${pr.repo}/pulls/${pr.pr}/reviews`,
      buildPendingReviewCreateBody(params.commitId, params)
    );
    if (!r.ok) return r;
  } else {
    const r = await graphqlRequest(
      `mutation($reviewId: ID!, $path: String!, $line: Int!, $body: String!) {
        addPullRequestReviewThread(input: {
          pullRequestReviewId: $reviewId, path: $path, line: $line, side: RIGHT, body: $body
        }) { thread { id } }
      }`,
      {
        reviewId: state.value.reviewId,
        path: params.path,
        line: params.line,
        body: params.body,
      }
    );
    if (!r.ok) return r;
  }
  return fetchPendingReview(pr);
}

/**
 * GraphQL updatePullRequestReviewComment — 下書きコメントの本文を更新する。
 * 行の変更はできない（呼び出し側で削除 → 追加し直す）。
 */
export async function updatePendingComment(
  pr: PrRef,
  commentId: string,
  body: string
): Promise<GithubResult<PendingReviewPayload>> {
  const pat = await getPat();
  if (!pat) return patRequired('下書きの更新には PAT の設定が必要です');
  const r = await graphqlRequest(
    `mutation($commentId: ID!, $body: String!) {
      updatePullRequestReviewComment(input: {
        pullRequestReviewCommentId: $commentId, body: $body
      }) { pullRequestReviewComment { id } }
    }`,
    { commentId, body }
  );
  if (!r.ok) return r;
  return fetchPendingReview(pr);
}

/**
 * GraphQL deletePullRequestReviewComment — 下書きコメントを削除する。
 * 最後の 1 件を消して pending review が空になったら、レビュー自体も削除する
 * （空の pending review が残ると GitHub 側で「レビュー中」状態が続いてしまう）。
 */
export async function deletePendingComment(
  pr: PrRef,
  commentId: string
): Promise<GithubResult<PendingReviewPayload>> {
  const pat = await getPat();
  if (!pat) return patRequired('下書きの削除には PAT の設定が必要です');
  const r = await graphqlRequest(
    `mutation($commentId: ID!) {
      deletePullRequestReviewComment(input: { id: $commentId }) {
        pullRequestReview { id }
      }
    }`,
    { commentId }
  );
  if (!r.ok) return r;
  const after = await fetchPendingReview(pr);
  if (!after.ok) return after;
  if (after.value.reviewId !== null && after.value.comments.length === 0) {
    const del = await graphqlRequest(
      `mutation($reviewId: ID!) {
        deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) {
          pullRequestReview { id }
        }
      }`,
      { reviewId: after.value.reviewId }
    );
    if (del.ok) {
      return {
        ok: true,
        authMode: del.authMode,
        value: { reviewId: null, comments: [] },
      };
    }
    // 空レビューの削除に失敗しても下書き削除自体は済んでいるので現状を返す
  }
  return after;
}

/**
 * GraphQL submitPullRequestReview — pending review を event: COMMENT で
 * submit する（approve / request changes にはならない）。
 * 失敗時（push で行が outdated になった等）は pending review が
 * GitHub 側にそのまま残るので、ユーザーは修正して再送できる。
 */
export async function submitPendingReview(
  reviewId: string
): Promise<GithubResult<ReviewSubmitPayload>> {
  const pat = await getPat();
  if (!pat) return patRequired('レビュー投稿には PAT の設定が必要です');
  const r = await graphqlRequest<{
    submitPullRequestReview: { pullRequestReview: { url: string } | null } | null;
  }>(
    `mutation($reviewId: ID!) {
      submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: COMMENT }) {
        pullRequestReview { url }
      }
    }`,
    { reviewId }
  );
  if (!r.ok) return r;
  const url = r.data.submitPullRequestReview?.pullRequestReview?.url;
  if (typeof url !== 'string') {
    return {
      ok: false,
      authMode: r.authMode,
      error: { kind: 'unexpected', message: 'レビュー投稿の応答が想定外の形です' },
    };
  }
  return { ok: true, authMode: r.authMode, value: { htmlUrl: url } };
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
