// GitHub トークンの保存・取得・削除。options ページと background の双方から使う。
// 保存先は chrome.storage.local（プラン確定事項。sync には載せない）。
//
// fine-grained personal access token は「1 トークン = 1 owner」が GitHub 側で
// 強制されている（Each token is limited to access resources owned by a single
// user or organization）ため、ストアのキーは owner 単位にする。owner/repo 単位に
// 切ってもトークン実体が重複するだけで表現力は増えない。
// owner は GitHub 上 case-insensitive なので lowercase に正規化して引く。

/** chrome.storage.local 上のキー。storage.onChanged で登録変更を検知する用途にも使う */
export const TOKENS_KEY = 'githubTokens';

/** 旧・単一 PAT のキー（廃止）。起動時に LEGACY_STASH_KEY へ退避してから消す */
export const LEGACY_PAT_KEY = 'githubPat';

/**
 * 旧 PAT の退避先。黙って消すと「動かなくなった」の切り分けが困難になるため、
 * options に「旧形式のトークンが残っています」バナーを出して明示的に削除させる。
 * 動作は新ストアのみを参照し、この値へフォールバックすることは絶対にしない
 * （fallback すると Classic PAT で通ってしまい fine-grained 化の検証が成立しない）。
 */
export const LEGACY_STASH_KEY = 'legacyPat';

/** owner ごとに保存するトークンとその付随情報 */
export interface TokenEntry {
  token: string;
  /** ユーザーが付ける識別名（複数トークンの見分け用） */
  label?: string;
  /** GitHub-Authentication-Token-Expiration から採取した有効期限（ISO8601） */
  expiresAt?: string;
  /** 疎通確認が取れた時刻 (epoch ms) */
  lastVerifiedAt?: number;
  /** 疎通確認が取れた repo 名（owner を除いた部分。lowercase 正規化） */
  verifiedRepos?: string[];
}

/** owner（lowercase 正規化）→ トークン */
export type TokenStore = Record<string, TokenEntry>;

/** owner / repo は GitHub 上 case-insensitive。キー引きは常にこれを通す */
export function normalizeOwner(owner: string): string {
  return owner.trim().toLowerCase();
}

/**
 * `GitHub-Authentication-Token-Expiration` ヘッダを ISO8601 に正規化する。
 * 実測値は `2026-08-12 06:13:53 UTC` 形式で ISO8601 ではないため、
 * Date に直接食わせると環境依存になる。パースできなければ undefined を返す
 * （無期限トークンではヘッダ自体が返らない）。
 */
export function parseTokenExpiration(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*(UTC|Z)?$/.exec(header.trim());
  if (!m) return undefined;
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6])
  );
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** 有効期限までの残日数（切り捨て）。期限切れは負値、期限なしは null */
export function daysUntilExpiry(expiresAt: string | undefined, now = Date.now()): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now) / 86_400_000);
}

export async function getTokenStore(): Promise<TokenStore> {
  const items = await chrome.storage.local.get(TOKENS_KEY);
  const store = items[TOKENS_KEY] as unknown;
  if (!store || typeof store !== 'object' || Array.isArray(store)) return {};
  // 壊れた値が紛れ込んでも全体を捨てず、正しい形のエントリだけ通す
  const out: TokenStore = {};
  for (const [owner, entry] of Object.entries(store as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const token = (entry as { token?: unknown }).token;
    if (typeof token !== 'string' || token.length === 0) continue;
    out[normalizeOwner(owner)] = entry as TokenEntry;
  }
  return out;
}

/**
 * ストアへの read-modify-write を直列化する。SW / options の中では同一コンテキストの
 * ため、この promise チェーンで有効期限の書き戻しとユーザー操作の競合を防げる
 * （chrome.storage にトランザクションは無い）。
 */
let writeChain: Promise<unknown> = Promise.resolve();

function withStore<T>(fn: (store: TokenStore) => Promise<T> | T): Promise<T> {
  const next = writeChain.then(async () => {
    const store = await getTokenStore();
    return fn(store);
  });
  // 失敗しても後続の書き込みを止めない
  writeChain = next.catch(() => undefined);
  return next;
}

/** owner に対応するトークンを引く。無ければ null（旧 PAT へはフォールバックしない） */
export async function getTokenFor(owner: string): Promise<TokenEntry | null> {
  const store = await getTokenStore();
  return store[normalizeOwner(owner)] ?? null;
}

export async function hasTokenFor(owner: string): Promise<boolean> {
  return (await getTokenFor(owner)) !== null;
}

/** トークンを登録・更新する。既存の付随情報（有効期限・確認済み repo）は引き継がない */
export async function setToken(
  owner: string,
  token: string,
  label?: string
): Promise<void> {
  const key = normalizeOwner(owner);
  await withStore(async (store) => {
    const current = store[key];
    // トークン文字列が変わったら過去の有効期限・確認結果は当てにならないので捨てる
    const carryOver = current?.token === token ? current : undefined;
    const entry: TokenEntry = { ...carryOver, token };
    const nextLabel = label ?? carryOver?.label;
    if (nextLabel) entry.label = nextLabel;
    else delete entry.label;
    await chrome.storage.local.set({ [TOKENS_KEY]: { ...store, [key]: entry } });
  });
}

export async function removeToken(owner: string): Promise<void> {
  const key = normalizeOwner(owner);
  await withStore(async (store) => {
    if (!(key in store)) return;
    const next = { ...store };
    delete next[key];
    await chrome.storage.local.set({ [TOKENS_KEY]: next });
  });
}

/**
 * 既存エントリの付随情報だけを更新する（有効期限の書き戻し・疎通確認の記録）。
 * 対象 owner のトークンが無ければ何もしない（削除直後の書き戻しで復活させないため）。
 */
export async function updateTokenMeta(
  owner: string,
  patch: Partial<Omit<TokenEntry, 'token'>>
): Promise<void> {
  const key = normalizeOwner(owner);
  await withStore(async (store) => {
    const current = store[key];
    if (!current) return;
    const merged: TokenEntry = { ...current, ...patch };
    // 変化が無ければ書かない（storage.onChanged の空振りを避ける）
    if (JSON.stringify(merged) === JSON.stringify(current)) return;
    await chrome.storage.local.set({ [TOKENS_KEY]: { ...store, [key]: merged } });
  });
}

/** 疎通確認が取れた repo を記録する */
export async function recordVerifiedRepo(owner: string, repo: string): Promise<void> {
  const key = normalizeOwner(owner);
  const name = normalizeOwner(repo);
  const current = await getTokenFor(key);
  if (!current) return;
  const repos = new Set(current.verifiedRepos ?? []);
  repos.add(name);
  await updateTokenMeta(key, {
    verifiedRepos: [...repos].sort(),
    lastVerifiedAt: Date.now(),
  });
}

// ------------------------------------------------------------ 旧 PAT の移行

/**
 * 旧 `githubPat` が残っていれば `legacyPat` へ退避して元キーを消す。
 * owner に紐づかない Classic PAT を owner キーのマップへ機械的に移すと
 * 「どの owner のキーに入れるか」が決まらないため、自動移行はしない。
 * 冪等なので SW 起動のたびに呼んでよい。
 */
export async function migrateLegacyPat(): Promise<void> {
  const items = await chrome.storage.local.get([LEGACY_PAT_KEY, LEGACY_STASH_KEY]);
  const old = items[LEGACY_PAT_KEY];
  if (typeof old !== 'string' || old.length === 0) return;
  await chrome.storage.local.set({ [LEGACY_STASH_KEY]: old });
  await chrome.storage.local.remove(LEGACY_PAT_KEY);
}

/** 退避済みの旧 PAT（options のバナー表示用）。動作には一切使わない */
export async function getLegacyPat(): Promise<string | null> {
  const items = await chrome.storage.local.get(LEGACY_STASH_KEY);
  const v = items[LEGACY_STASH_KEY];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export async function clearLegacyPat(): Promise<void> {
  await chrome.storage.local.remove([LEGACY_STASH_KEY, LEGACY_PAT_KEY]);
}
