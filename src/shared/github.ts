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
  | 'pat_required' // PAT 未設定で書き込み系 API（下書き操作・レビュー投稿）を呼ぼうとした
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
  /** unified diff（コメント可能行の算出に使う）。バイナリ / 巨大ファイルでは無い */
  patch?: string;
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

/** pending review に載せるインラインコメント 1 件分（side は常に RIGHT） */
export interface ReviewCommentInput {
  /** リポジトリルートからのファイルパス */
  path: string;
  /** RIGHT サイドの行番号（1 始まり） */
  line: number;
  /** コメント本文（Markdown） */
  body: string;
}

/**
 * pending review（GitHub ネイティブの下書きレビュー）上のコメント 1 件。
 * pending 状態のコメントは REST API からは見えない（一覧が空になり
 * PATCH / DELETE も効かない）ため、取得・操作はすべて GraphQL API で行い、
 * ID も GraphQL のノード ID（文字列）で持つ。
 * 拡張が作るコメントのほか、GitHub の PR 画面で作られた下書きも
 * 同じ pending review に載ってくる（outdated で行が取れないものもあり得る）。
 */
export interface PendingComment {
  /** GraphQL のノード ID（updatePullRequestReviewComment 等に渡す） */
  id: string;
  /** リポジトリルートからのファイルパス */
  path: string;
  /** コメント先の行（1 始まり）。outdated 等で取れない場合は null */
  line: number | null;
  /** コメント本文（Markdown） */
  body: string;
}

/**
 * pending review の現在の状態。reviewId === null は「pending review なし」
 * （このとき comments は空）。
 */
export interface PendingReviewPayload {
  /** pending review の GraphQL ノード ID */
  reviewId: string | null;
  comments: PendingComment[];
}

/** submitPullRequestReview（レビュー投稿）の成功応答（UI 表示に必要な分だけ） */
export interface ReviewSubmitPayload {
  /** 投稿されたレビューの PR ページ上の URL */
  htmlUrl: string;
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
    case 'pat_required':
      return '下書き（pending review）の操作には PAT が必要です。設定ページで PAT を設定してください。';
    case 'network':
      return `GitHub API に接続できませんでした: ${error.message}`;
    default:
      return `GitHub API エラー${error.status ? `（${error.status}）` : ''}: ${error.message}`;
  }
}
