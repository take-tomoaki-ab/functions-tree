// GitHub API まわりの共有型と、エラーの人間向け説明。
// content / options / background のどこからでも import できるよう純粋な型・関数のみ。

/** リクエスト時の認証状態。トークン未登録なら anonymous（公開リポジトリのみ・低レート制限） */
export type AuthMode = 'pat' | 'anonymous';

export type GithubErrorKind =
  | 'unauthorized' // 401: トークンが無効・失効
  | 'forbidden' // 403: 権限不足（レート制限以外）
  | 'rate_limited' // 403/429 かつレート残量 0
  | 'not_found' // 404: 存在しない / トークンのスコープ外（fine-grained は権限不足を 404 に潰す）
  | 'too_large' // contents API の 1MB 上限超え
  | 'token_required' // トークン未登録で書き込み系 API（下書き操作・レビュー投稿）を呼ぼうとした
  | 'fork_unreadable' // fork PR の head 側リポジトリが読めない（トークンのスコープ外）
  | 'network' // fetch 自体の失敗（オフライン等）
  | 'unexpected'; // その他

export interface GithubApiError {
  kind: GithubErrorKind;
  status?: number;
  /** GitHub API が返した message（あれば） */
  message: string;
  /** レート制限のリセット時刻 (epoch ms)。kind === 'rate_limited' のとき */
  rateLimitReset?: number;
  /**
   * `X-Accepted-GitHub-Permissions` の値（例: `pull_requests=write,contents=read`）。
   * 実測では 200 / 404 にも載るためステータスを問わず拾うが、**GraphQL の応答には
   * 載らない**ので、下書き操作・レビュー投稿の失敗では取れないことが多い。
   */
  requiredPermissions?: string;
  /** アクセスしようとしたリポジトリの owner（メッセージの出し分けに使う） */
  owner?: string;
  /** 上記 owner のトークンが登録済みだったか */
  tokenRegistered?: boolean;
  /** kind === 'fork_unreadable' のとき、読めなかった head 側リポジトリ（owner/repo） */
  forkRepo?: string;
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

/** 疎通確認 1 項目分の結果 */
export interface TokenCheckResult {
  ok: boolean;
  status?: number;
  message?: string;
}

/**
 * 対象リポジトリへの疎通確認の結果。fine-grained token では `GET /user` が
 * 権限不要で通ってしまい何も保証しないため、確認は必ずリポジトリ単位で行う。
 * write 権限は非破壊に検証できない（レビュー作成は副作用がある）ので確認しない。
 */
export interface AuthTestPayload {
  /** 対象 owner のトークンが登録されていたか */
  authenticated: boolean;
  owner: string;
  repo: string;
  checks: {
    /** GET /repos/{o}/{r} — Metadata: Read。トークンがこの repo に届いているか */
    metadata: TokenCheckResult;
    /** GET /repos/{o}/{r}/pulls?per_page=1 — Pull requests: Read */
    pullRequests: TokenCheckResult;
    /** GET /repos/{o}/{r}/contents/ — Contents: Read */
    contents: TokenCheckResult;
  };
  /** GitHub-Authentication-Token-Expiration から採取した有効期限（ISO8601） */
  expiresAt?: string;
  rateLimit?: { limit: number; remaining: number; reset: number };
}

/** `pull_requests=write,contents=read` を「Pull requests: write / Contents: read」に直す */
export function describeRequiredPermissions(raw: string | undefined): string | null {
  if (!raw) return null;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('allows_permissionless_access'))
    .map((s) => {
      const [name, level] = s.split('=');
      const label = name
        .split('_')
        .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join(' ');
      return level ? `${label}: ${level}` : label;
    });
  return parts.length > 0 ? parts.join(' / ') : null;
}

/** そのリポジトリの owner 用トークンを登録するよう促す一文 */
function registerHint(owner: string | undefined): string {
  return owner
    ? `設定ページで \`${owner}\` 用のトークンを登録してください。`
    : '設定ページでこのリポジトリの owner 用トークンを登録してください。';
}

/** エラーをそのまま UI に出せる日本語メッセージにする */
export function describeGithubError(error: GithubApiError): string {
  const perms = describeRequiredPermissions(error.requiredPermissions);
  const permsHint = perms ? `必要な権限: ${perms}。` : '';

  switch (error.kind) {
    case 'unauthorized':
      return `トークンが無効です（401）。期限切れの可能性があります。${registerHint(error.owner)}`;
    case 'rate_limited': {
      const reset = error.rateLimitReset
        ? `（リセット: ${new Date(error.rateLimitReset).toLocaleTimeString()}）`
        : '';
      return `GitHub API のレート制限に達しました${reset}。トークンを登録すると上限が緩和されます。`;
    }
    case 'forbidden':
      // fine-grained token はスコープ外を 404 に潰すため、403 は権限そのものの不足で出る
      return `アクセスが拒否されました（403）。${permsHint}${error.message}`;
    case 'not_found':
      // fine-grained token は「トークンのスコープ外」も 404 "Not Found" で返すため、
      // 存在しないのかスコープ外なのかを API だけでは区別できない。
      // 登録状態はこちらで分かるので、そこで文言を出し分ける。
      return error.tokenRegistered === false
        ? `見つかりませんでした（404）。${registerHint(error.owner)}` +
            'プライベートリポジトリはトークンが無いと存在しない扱いになります。'
        : '見つかりませんでした（404）。PR 番号が正しいか、' +
            `${error.owner ? `\`${error.owner}\` 用トークンの` : 'トークンの'} Repository access に` +
            `このリポジトリが含まれているか確認してください。${permsHint}`;
    case 'too_large':
      return 'ファイルが大きすぎて取得できません（contents API の 1MB 上限）。';
    case 'token_required':
      return `下書き（pending review）の操作にはトークンが必要です。${registerHint(error.owner)}`;
    case 'fork_unreadable':
      // fork 元が private + 別 owner のときだけ起きる（public な fork は常に読める）
      return (
        `fork 元リポジトリ${error.forkRepo ? ` \`${error.forkRepo}\`` : ''}のファイルを読めないため解析できません。` +
        'fine-grained token は明示的に選択したリポジトリしかアクセスできないため、' +
        `${error.forkRepo ? `\`${error.forkRepo.split('/')[0]}\` 用の` : 'fork 側 owner 用の'}` +
        'トークンを登録すると解析できるようになります。'
      );
    case 'network':
      return `GitHub API に接続できませんでした: ${error.message}`;
    default:
      return `GitHub API エラー${error.status ? `（${error.status}）` : ''}: ${error.message}`;
  }
}
