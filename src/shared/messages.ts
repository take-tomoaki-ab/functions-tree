// content / options ⇔ background service worker 間のメッセージ型定義。
// リクエストは type 判別のユニオンで増やしていく（Phase 3 以降: 解析要求など）。

import type {
  AuthTestPayload,
  FileContentPayload,
  GithubResult,
  PrFilesPayload,
  PrInfo,
} from './github';

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
