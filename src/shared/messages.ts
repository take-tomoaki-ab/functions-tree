// content script ⇔ background service worker 間のメッセージ型定義。
// リクエストは type 判別のユニオンで増やしていく（Phase 2 以降: PR ファイル取得、解析要求など）。

/** PR を一意に指すリファレンス */
export interface PrRef {
  owner: string;
  repo: string;
  pr: number;
}

/** 疎通確認。パネルを開いたときに content → background へ送る */
export interface PingRequest {
  type: 'PING';
  pr: PrRef;
}

export interface PongResponse {
  type: 'PONG';
  /** SW 側で受信した時刻 (epoch ms)。SW が生きていることの証左 */
  receivedAt: number;
}

/** content → background の全リクエスト */
export type RequestMessage = PingRequest;

/** リクエスト型からレスポンス型を引く */
export type ResponseFor<M extends RequestMessage> = M extends PingRequest
  ? PongResponse
  : never;

/** 型付き sendMessage ラッパ。SW 休止からの再起動も chrome 側が面倒を見る */
export function sendToBackground<M extends RequestMessage>(
  message: M
): Promise<ResponseFor<M>> {
  return chrome.runtime.sendMessage(message);
}
