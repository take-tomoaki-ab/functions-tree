// GitHub API まわりの共有型と、エラーの人間向け説明。
// content / options / background のどこからでも import できるよう純粋な型・関数のみ。

/** リクエスト時の認証状態。PAT 未設定なら anonymous（公開リポジトリのみ・低レート制限） */
export type AuthMode = 'pat' | 'anonymous';

export type GithubErrorKind =
  | 'unauthorized' // 401: PAT が無効・失効
  | 'forbidden' // 403: 権限不足（レート制限以外）
  | 'rate_limited' // 403/429 かつレート残量 0
  | 'not_found' // 404: PR やファイルが存在しない / private で権限なし
  | 'too_large' // contents API の 1MB 上限超え
  | 'network' // fetch 自体の失敗（オフライン等）
  | 'unexpected'; // その他

export interface GithubApiError {
  kind: GithubErrorKind;
  status?: number;
  /** GitHub API が返した message（あれば） */
  message: string;
  /** レート制限のリセット時刻 (epoch ms)。kind === 'rate_limited' のとき */
  rateLimitReset?: number;
}

/** background の GitHub API 呼び出し結果。呼び出し側は authMode で未認証表示を出し分ける */
export type GithubResult<T> =
  | { ok: true; authMode: AuthMode; value: T }
  | { ok: false; authMode: AuthMode; error: GithubApiError };

export interface PrInfo {
  title: string;
  state: string;
  headSha: string;
  baseSha: string;
  /** head 側リポジトリ。fork からの PR では owner が異なるため contents 取得はこちらを使う */
  headRepo: { owner: string; repo: string };
}

export interface PrFile {
  path: string;
  /** status === 'renamed' のときの旧パス */
  previousPath?: string;
  status: string; // added | removed | modified | renamed | copied | changed | unchanged
  additions: number;
  deletions: number;
}

export interface PrFilesPayload {
  files: PrFile[];
  /** ページ取得上限に達して打ち切った場合 true */
  truncated: boolean;
}

export interface FileContentPayload {
  path: string;
  ref: string;
  size: number;
  /** base64 デコード済みの UTF-8 テキスト */
  content: string;
}

export interface AuthTestPayload {
  authenticated: boolean;
  /** PAT 認証時のユーザー名 */
  login?: string;
  rateLimit?: { limit: number; remaining: number; reset: number };
}

/** エラーをそのまま UI に出せる日本語メッセージにする */
export function describeGithubError(error: GithubApiError): string {
  switch (error.kind) {
    case 'unauthorized':
      return 'PAT が無効です（401）。設定ページで PAT を確認してください。';
    case 'rate_limited': {
      const reset = error.rateLimitReset
        ? `（リセット: ${new Date(error.rateLimitReset).toLocaleTimeString()}）`
        : '';
      return `GitHub API のレート制限に達しました${reset}。PAT を設定すると上限が緩和されます。`;
    }
    case 'forbidden':
      return `アクセスが拒否されました（403）。${error.message}`;
    case 'not_found':
      return '見つかりませんでした（404）。PR 番号が正しいか、プライベートリポジトリの場合は PAT が設定されているか確認してください。';
    case 'too_large':
      return 'ファイルが大きすぎて取得できません（contents API の 1MB 上限）。';
    case 'network':
      return `GitHub API に接続できませんでした: ${error.message}`;
    default:
      return `GitHub API エラー${error.status ? `（${error.status}）` : ''}: ${error.message}`;
  }
}
