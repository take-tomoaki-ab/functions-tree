// GitHub REST API クライアント。トークンを扱うため service worker 内でのみ使う。
// すべての関数は throw せず GithubResult<T> で返す（UI 側は describeGithubError で表示）。
//
// fine-grained token は「1 トークン = 1 owner」なので、すべての呼び出しに
// 「どのリポジトリ向けか」の文脈（owner）を通し、その owner のトークンで認証する。

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
  TokenCheckResult,
} from '../shared/github';
import type { PrRef } from '../shared/messages';
import { buildPendingReviewCreateBody, parsePendingComments } from '../shared/review-drafts';
import {
  getTokenFor,
  parseTokenExpiration,
  recordVerifiedRepo,
  updateTokenMeta,
} from '../shared/settings';

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

/**
 * リクエストの認証文脈。owner はトークンを引くためのキーで、
 * null なら未認証で投げる（公開リポジトリのみ・低レート制限）。
 */
interface AuthContext {
  owner: string | null;
  tokenRegistered: boolean;
}

/**
 * 応答ヘッダの `GitHub-Authentication-Token-Expiration` を storage に書き戻す。
 * 実測ではこのヘッダは成功・失敗を問わずすべての応答に載る（GraphQL の POST にも）ので、
 * 通常の API 呼び出しのついでに期限を最新化できる。ポーリングは不要。
 * ヘッダ形式は `2026-08-12 06:13:53 UTC` で ISO8601 ではないため正規化して保存する。
 */
function recordExpiration(owner: string, headers: Headers): void {
  const expiresAt = parseTokenExpiration(headers.get('github-authentication-token-expiration'));
  if (!expiresAt) return;
  // 書き戻しの失敗で API 呼び出し自体を壊さない
  void updateTokenMeta(owner, { expiresAt }).catch(() => undefined);
}

async function apiRequest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  owner: string | null,
  pathAndQuery: string,
  body?: unknown
): Promise<FetchOk | FetchErr> {
  const entry = owner ? await getTokenFor(owner) : null;
  const authMode: AuthMode = entry ? 'pat' : 'anonymous';
  const auth: AuthContext = { owner, tokenRegistered: entry !== null };
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (entry) headers['Authorization'] = `Bearer ${entry.token}`;
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
      error: {
        kind: 'network',
        message: e instanceof Error ? e.message : String(e),
        owner: owner ?? undefined,
        tokenRegistered: auth.tokenRegistered,
      },
    };
  }
  if (owner && entry) recordExpiration(owner, res.headers);
  if (res.ok) return { ok: true, authMode, res };
  return { ok: false, authMode, error: await toApiError(res, auth) };
}

function apiGet(owner: string | null, pathAndQuery: string): Promise<FetchOk | FetchErr> {
  return apiRequest('GET', owner, pathAndQuery);
}

async function toApiError(res: Response, auth: AuthContext): Promise<GithubApiError> {
  const status = res.status;
  let message = res.statusText;
  // 実測では 403 に限らず 200 / 404 にも載るのでステータスを問わず拾う。
  // ただし GraphQL の応答には載らないため、書き込み系では取れないことが多い
  const requiredPermissions = res.headers.get('x-accepted-github-permissions') ?? undefined;
  const common = {
    owner: auth.owner ?? undefined,
    tokenRegistered: auth.tokenRegistered,
    requiredPermissions,
  };
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
  if (status === 401) return { kind: 'unauthorized', status, message, ...common };
  if (status === 403 || status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0' || /rate limit/i.test(message)) {
      const reset = res.headers.get('x-ratelimit-reset');
      return {
        kind: 'rate_limited',
        status,
        message,
        rateLimitReset: reset ? Number(reset) * 1000 : undefined,
        ...common,
      };
    }
    return { kind: 'forbidden', status, message, ...common };
  }
  if (status === 404) return { kind: 'not_found', status, message, ...common };
  return { kind: 'unexpected', status, message, ...common };
}

/** GET /repos/{owner}/{repo}/pulls/{n} — head SHA などのメタ情報 */
export async function getPrInfo(pr: PrRef): Promise<GithubResult<PrInfo>> {
  const r = await apiGet(pr.owner, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.pr}`);
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
      pr.owner,
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

/**
 * GET /repos/{owner}/{repo}/contents/{path}?ref={sha} — ファイル内容。
 *
 * authOwner に別の owner を渡すと、その owner のトークンで認証する。fork PR で
 * head 側 owner のトークンが無いときに base 側のトークンを使うためのもので、
 * fine-grained token が「選択したリポジトリ + 全 public リポジトリの read」を
 * 常に含むことを利用している（未認証 60 req/h に落とさずに public fork を読める）。
 */
export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  authOwner: string = owner
): Promise<GithubResult<FileContentPayload>> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const r = await apiGet(
    authOwner,
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
  ref: string,
  authOwner: string = owner
): Promise<GithubResult<string[]>> {
  const encodedPath = dir
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/');
  const r = await apiGet(
    authOwner,
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

/** トークン必須の操作で、その owner のトークンが無いときに返す共通エラー */
function tokenRequired(owner: string, message: string): FetchErr {
  return {
    ok: false,
    authMode: 'anonymous',
    error: { kind: 'token_required', message, owner, tokenRegistered: false },
  };
}

/**
 * POST /graphql — pending review の取得・操作に使う（pending 状態のレビュー
 * コメントは REST からは見えず、PATCH / DELETE も効かないため）。
 * GraphQL はエラーでも HTTP 200 で errors 配列を返すため、ここで GithubApiError に写す。
 */
async function graphqlRequest<T>(
  owner: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ ok: true; authMode: AuthMode; data: T } | FetchErr> {
  const r = await apiRequest('POST', owner, '/graphql', { query, variables });
  if (!r.ok) return r;
  const json = (await r.res.json()) as {
    data?: T;
    errors?: Array<{ message?: unknown; type?: unknown }>;
  };
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const message = json.errors
      .map((e) => String(e?.message ?? ''))
      .filter((s) => s.length > 0)
      .join(' / ');
    // GraphQL はエラーでも HTTP 200 で返し、X-Accepted-GitHub-Permissions も載らない。
    // NOT_FOUND / FORBIDDEN の type だけは拾って、権限まわりの案内に寄せる
    const type = json.errors.map((e) => String(e?.type ?? '')).find((t) => t.length > 0);
    const kind =
      type === 'NOT_FOUND' ? 'not_found' : type === 'FORBIDDEN' ? 'forbidden' : 'unexpected';
    return {
      ok: false,
      authMode: r.authMode,
      error: {
        kind,
        message: message || 'GraphQL エラー',
        owner,
        tokenRegistered: r.authMode === 'pat',
      },
    };
  }
  if (json.data === undefined || json.data === null) {
    return {
      ok: false,
      authMode: r.authMode,
      error: { kind: 'unexpected', message: 'GraphQL 応答に data がありません', owner },
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
    pr.owner,
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
      error: {
        kind: 'not_found',
        message: `PR が見つかりません: ${pr.owner}/${pr.repo}#${pr.pr}`,
        owner: pr.owner,
        tokenRegistered: r.authMode === 'pat',
      },
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
 * pending review の現在の状態を取得する。その owner のトークンが未登録なら
 * エラーではなく「pending review なし」を返す（未認証では pending review は
 * 存在し得ないため、パネルを開いただけでエラー表示にならないようにする）。
 */
export async function getPendingReview(
  pr: PrRef
): Promise<GithubResult<PendingReviewPayload>> {
  const entry = await getTokenFor(pr.owner);
  if (!entry) {
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
  const entry = await getTokenFor(pr.owner);
  if (!entry) return tokenRequired(pr.owner, '下書きの追加にはトークンの登録が必要です');

  const state = await fetchPendingReview(pr);
  if (!state.ok) return state;

  if (state.value.reviewId === null) {
    const r = await apiRequest(
      'POST',
      pr.owner,
      `/repos/${pr.owner}/${pr.repo}/pulls/${pr.pr}/reviews`,
      buildPendingReviewCreateBody(params.commitId, params)
    );
    if (!r.ok) return r;
  } else {
    const r = await graphqlRequest(
      pr.owner,
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
  const entry = await getTokenFor(pr.owner);
  if (!entry) return tokenRequired(pr.owner, '下書きの更新にはトークンの登録が必要です');
  const r = await graphqlRequest(
    pr.owner,
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
  const entry = await getTokenFor(pr.owner);
  if (!entry) return tokenRequired(pr.owner, '下書きの削除にはトークンの登録が必要です');
  const r = await graphqlRequest(
    pr.owner,
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
  // 実測では最後のコメントを消すと pending review も GitHub 側で自動的に消えるが、
  // 残るケースに備えて空レビューの明示削除は残す（deletePullRequestReview 自体は
  // Pull requests: write だけで通ることを確認済み）
  if (after.value.reviewId !== null && after.value.comments.length === 0) {
    const del = await graphqlRequest(
      pr.owner,
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
  pr: PrRef,
  reviewId: string
): Promise<GithubResult<ReviewSubmitPayload>> {
  const entry = await getTokenFor(pr.owner);
  if (!entry) return tokenRequired(pr.owner, 'レビュー投稿にはトークンの登録が必要です');
  const r = await graphqlRequest<{
    submitPullRequestReview: { pullRequestReview: { url: string } | null } | null;
  }>(
    pr.owner,
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

/**
 * 対象リポジトリへの疎通確認。
 *
 * `GET /user` は fine-grained token では権限不要で通るため（実測で確認済み）、
 * 「トークン文字列が有効」以上のことを何も保証しない。そのため確認は必ず
 * 対象リポジトリ単位で行い、権限ごとに 1 本ずつ実際のエンドポイントを叩く。
 * write 権限はレビュー作成という副作用なしに検証できないので確認しない
 * （失敗時のエラーメッセージで案内する）。
 */
export async function testAuth(owner: string, repo: string): Promise<GithubResult<AuthTestPayload>> {
  const entry = await getTokenFor(owner);
  if (!entry) {
    return {
      ok: false,
      authMode: 'anonymous',
      error: {
        kind: 'token_required',
        message: `${owner} 用のトークンが登録されていません`,
        owner,
        tokenRegistered: false,
      },
    };
  }

  const base = `/repos/${owner}/${repo}`;
  const metadata = await checkEndpoint(owner, base);
  const pullRequests = await checkEndpoint(owner, `${base}/pulls?per_page=1`);
  const contents = await checkEndpoint(owner, `${base}/contents/`);

  // Metadata すら通らない = トークンのスコープにこの repo が入っていない
  // （fine-grained は権限不足を 404 に潰すので 403 ではなく 404 で来る）
  if (metadata.result.ok) await recordVerifiedRepo(owner, repo);

  const rate = await apiGet(owner, '/rate_limit');
  const rateLimit = rate.ok
    ? (
        (await rate.res.json()) as {
          resources: { core: { limit: number; remaining: number; reset: number } };
        }
      ).resources.core
    : undefined;

  return {
    ok: true,
    authMode: 'pat',
    value: {
      authenticated: true,
      owner,
      repo,
      checks: {
        metadata: metadata.result,
        pullRequests: pullRequests.result,
        contents: contents.result,
      },
      expiresAt: metadata.expiresAt ?? (await getTokenFor(owner))?.expiresAt,
      rateLimit,
    },
  };
}

/** 疎通確認 1 本分。通信自体が失敗しても throw せず結果に畳む */
async function checkEndpoint(
  owner: string,
  pathAndQuery: string
): Promise<{ result: TokenCheckResult; expiresAt?: string }> {
  const r = await apiGet(owner, pathAndQuery);
  if (r.ok) {
    return {
      result: { ok: true, status: r.res.status },
      expiresAt: parseTokenExpiration(
        r.res.headers.get('github-authentication-token-expiration')
      ),
    };
  }
  return {
    result: {
      ok: false,
      status: r.error.status,
      message: describeCheckFailure(r.error),
    },
  };
}

/** 疎通確認の失敗理由を 1 行で。fine-grained では 404 が「スコープ外」を意味しうる */
function describeCheckFailure(error: GithubApiError): string {
  if (error.kind === 'not_found') {
    return '404 — リポジトリが存在しないか、トークンの Repository access に含まれていません';
  }
  if (error.kind === 'forbidden') {
    const perms = error.requiredPermissions ? `（要: ${error.requiredPermissions}）` : '';
    return `403 — 権限が不足しています${perms}`;
  }
  if (error.kind === 'unauthorized') return '401 — トークンが無効または期限切れです';
  if (error.kind === 'rate_limited') return '429 — レート制限に達しました';
  return `${error.status ?? '-'} — ${error.message}`;
}
