// content / options ⇔ background service worker 間のメッセージ型定義。
// リクエストは type 判別のユニオンで増やしていく（Phase 3 以降: 解析要求など）。

import type {
  AuthTestPayload,
  FileContentPayload,
  GithubResult,
  PendingReviewPayload,
  PrFilesPayload,
  PrInfo,
  ReviewSubmitPayload,
} from './github';
import type { GraphPayload } from './graph';

/** PR を一意に指すリファレンス */
export interface PrRef {
  owner: string;
  repo: string;
  pr: number;
}

/** 疎通確認。 */
export interface PingRequest {
  type: 'PING';
  pr: PrRef;
}

export interface PongResponse {
  type: 'PONG';
  /** SW 側で受信した時刻 (epoch ms)。SW が生きていることの証左 */
  receivedAt: number;
}

/** PR のメタ情報（head SHA 等）を取得 */
export interface GetPrInfoRequest {
  type: 'GET_PR_INFO';
  pr: PrRef;
}

/** PR の変更ファイル一覧を取得（pagination は background 側で吸収） */
export interface GetPrFilesRequest {
  type: 'GET_PR_FILES';
  pr: PrRef;
}

/** 指定 ref のファイル内容を取得（Phase 3 の analyzer が使う想定） */
export interface GetFileContentRequest {
  type: 'GET_FILE_CONTENT';
  /** fork PR では head 側リポジトリを指定する（GET_PR_INFO の headRepo） */
  owner: string;
  repo: string;
  path: string;
  /** 取得するコミット SHA（通常は PR の head SHA） */
  ref: string;
}

/**
 * PR のコールグラフを構築する（Phase 3）。
 * 解析は SW 内の tree-sitter で行い、結果は headSha をキーに SW メモリにキャッシュされる。
 */
export interface BuildGraphRequest {
  type: 'BUILD_GRAPH';
  pr: PrRef;
}

/**
 * 現在の PR の pending review（GitHub ネイティブの下書きレビュー）を取得する。
 * pending review は認証ユーザー本人にしか見えないため、PAT 未設定時はエラーではなく
 * 「pending review なし」（reviewId: null, comments: []）の ok 応答が返る。
 */
export interface GetPendingReviewRequest {
  type: 'GET_PENDING_REVIEW';
  pr: PrRef;
}

/**
 * pending review に下書きコメントを 1 件追加する。pending review が無ければ
 * POST /pulls/{n}/reviews（event なし = PENDING）でレビューごと作成し、あれば
 * GraphQL の addPullRequestReviewThread で追記する。応答は更新後の pending review 全体。
 * line は patch の RIGHT サイド（head）に含まれる行であること（GraphNode.commentableLines）。
 * PAT 未設定時は kind: 'pat_required' のエラーが返る（UI 側のボタン無効化と二重防御）。
 */
export interface AddPendingCommentRequest {
  type: 'ADD_PENDING_COMMENT';
  pr: PrRef;
  /** コメントを紐づけるコミット SHA（解析に使った headSha） */
  commitId: string;
  /** リポジトリルートからのファイルパス */
  path: string;
  /** RIGHT サイドの行番号（1 始まり） */
  line: number;
  /** コメント本文（Markdown） */
  body: string;
}

/**
 * pending review 上の下書きコメントの本文を更新する（GraphQL
 * updatePullRequestReviewComment。pending コメントは REST から触れない）。
 * 行の変更はできない（呼び出し側で削除 → 追加し直す）。応答は更新後の pending review 全体。
 */
export interface UpdatePendingCommentRequest {
  type: 'UPDATE_PENDING_COMMENT';
  pr: PrRef;
  /** 対象コメントの GraphQL ノード ID */
  commentId: string;
  /** 新しいコメント本文（Markdown） */
  body: string;
}

/**
 * pending review 上の下書きコメントを削除する（GraphQL deletePullRequestReviewComment）。
 * 最後の 1 件を消したときは空になった pending review 自体も削除する。
 * 応答は更新後の pending review 全体。
 */
export interface DeletePendingCommentRequest {
  type: 'DELETE_PENDING_COMMENT';
  pr: PrRef;
  /** 対象コメントの GraphQL ノード ID */
  commentId: string;
}

/**
 * pending review を event: COMMENT で submit する（GraphQL submitPullRequestReview）。
 * これで初めて下書きが PR の相手に見える状態になる。approve / request changes にはならない。
 */
export interface SubmitPendingReviewRequest {
  type: 'SUBMIT_PENDING_REVIEW';
  pr: PrRef;
  /** pending review の GraphQL ノード ID */
  reviewId: string;
}

/** PAT の有効性確認。PAT があれば GET /user、なければ GET /rate_limit */
export interface TestAuthRequest {
  type: 'TEST_AUTH';
}

/** options ページを開く（content script からは直接開けないため SW に依頼） */
export interface OpenOptionsRequest {
  type: 'OPEN_OPTIONS';
}

/** content / options → background の全リクエスト */
export type RequestMessage =
  | PingRequest
  | GetPrInfoRequest
  | GetPrFilesRequest
  | GetFileContentRequest
  | BuildGraphRequest
  | GetPendingReviewRequest
  | AddPendingCommentRequest
  | UpdatePendingCommentRequest
  | DeletePendingCommentRequest
  | SubmitPendingReviewRequest
  | TestAuthRequest
  | OpenOptionsRequest;

/** リクエスト型からレスポンス型を引く */
export type ResponseFor<M extends RequestMessage> = M extends PingRequest
  ? PongResponse
  : M extends GetPrInfoRequest
    ? GithubResult<PrInfo>
    : M extends GetPrFilesRequest
      ? GithubResult<PrFilesPayload>
      : M extends GetFileContentRequest
        ? GithubResult<FileContentPayload>
        : M extends BuildGraphRequest
          ? GithubResult<GraphPayload>
          : M extends
                | GetPendingReviewRequest
                | AddPendingCommentRequest
                | UpdatePendingCommentRequest
                | DeletePendingCommentRequest
            ? GithubResult<PendingReviewPayload>
            : M extends SubmitPendingReviewRequest
              ? GithubResult<ReviewSubmitPayload>
              : M extends TestAuthRequest
                ? GithubResult<AuthTestPayload>
                : M extends OpenOptionsRequest
                  ? { ok: true }
                  : never;

/** 型付き sendMessage ラッパ。SW 休止からの再起動も chrome 側が面倒を見る */
export function sendToBackground<M extends RequestMessage>(
  message: M
): Promise<ResponseFor<M>> {
  return chrome.runtime.sendMessage(message);
}
