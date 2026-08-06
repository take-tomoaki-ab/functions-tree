// options ページ。owner ごとの GitHub トークンの登録・削除と、対象リポジトリへの疎通確認。
// トークンそのものは表示せず、先頭数文字と長さだけを示す。

import type { AuthTestPayload } from '../shared/github';
import { describeGithubError } from '../shared/github';
import { LANGUAGE_METADATA } from '../shared/languages';
import { sendToBackground } from '../shared/messages';
import type { TokenEntry } from '../shared/settings';
import {
  clearLegacyPat,
  daysUntilExpiry,
  getLegacyPat,
  getTokenFor,
  getTokenStore,
  migrateLegacyPat,
  normalizeOwner,
  removeToken,
  setToken,
} from '../shared/settings';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`element not found: #${id}`);
  return found as T;
}

const legacyBanner = el<HTMLDivElement>('legacy-banner');
const tokensList = el<HTMLUListElement>('tokens');
const tokensEmpty = el<HTMLParagraphElement>('tokens-empty');
const repoInput = el<HTMLInputElement>('repo-input');
const labelInput = el<HTMLInputElement>('label-input');
const tokenInput = el<HTMLInputElement>('token-input');
const saveResult = el<HTMLParagraphElement>('save-result');

/** `owner/repo` を分解する。owner だけの入力は repo が無いので疎通確認できない */
function parseRepoRef(raw: string): { owner: string; repo: string } | null {
  const trimmed = raw.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)/.exec(trimmed);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/** トークンは先頭 4 文字だけ見せて種別（ghp_ / github_pat_）が分かる程度に留める */
function maskToken(token: string): string {
  return `${token.slice(0, 4)}…・${token.length} 文字`;
}

/** 「確認済みリポジトリ」の表示文字列 */
function formatVerifiedRepos(owner: string, entry: TokenEntry): string {
  const repos = entry.verifiedRepos ?? [];
  return repos.length > 0 ? repos.map((r) => `${owner}/${r}`).join(', ') : 'なし';
}

function formatExpiry(entry: TokenEntry): { text: string; state: string } {
  const days = daysUntilExpiry(entry.expiresAt);
  if (days === null) {
    return {
      text: entry.expiresAt ? entry.expiresAt : '不明（API 呼び出し後に表示されます）',
      state: 'unknown',
    };
  }
  const date = new Date(entry.expiresAt as string).toLocaleDateString();
  if (days < 0) return { text: `${date}（期限切れ）`, state: 'expired' };
  if (days <= 7) return { text: `${date}（残り ${days} 日）`, state: 'soon' };
  return { text: `${date}（残り ${days} 日）`, state: 'ok' };
}

/** 疎通確認の結果を 1 つのテキストに畳む */
function formatCheckResult(v: AuthTestPayload): { text: string; state: string } {
  const rows: string[] = [];
  const items = [
    ['Metadata: Read', v.checks.metadata],
    ['Pull requests: Read', v.checks.pullRequests],
    ['Contents: Read', v.checks.contents],
  ] as const;
  for (const [name, check] of items) {
    rows.push(check.ok ? `✓ ${name}` : `✗ ${name} — ${check.message ?? '失敗'}`);
  }
  const failed = items.filter(([, c]) => !c.ok);
  const rate = v.rateLimit
    ? `\n残りレート: ${v.rateLimit.remaining}/${v.rateLimit.limit}`
    : '';

  if (failed.length === 0) {
    return { text: `${v.owner}/${v.repo} への疎通 OK\n${rows.join('\n')}${rate}`, state: 'ok' };
  }
  // Metadata が通らない = そもそもこの repo がトークンのスコープに入っていない
  if (!v.checks.metadata.ok) {
    return {
      text:
        `${v.owner}/${v.repo} に到達できません。トークンの Repository access に` +
        `このリポジトリが含まれているか確認してください。\n${rows.join('\n')}${rate}`,
      state: 'error',
    };
  }
  return {
    text:
      `${v.owner}/${v.repo} には到達できましたが、一部の権限が足りません。\n${rows.join('\n')}\n` +
      '（書き込み権限 Pull requests: write は副作用なしに確認できないため、ここでは検証していません）' +
      rate,
    state: 'partial',
  };
}

/** 指定 owner / repo へ疎通確認し、結果を出力要素へ書く */
async function verify(
  owner: string,
  repo: string,
  out: HTMLElement
): Promise<'ok' | 'partial' | 'error'> {
  out.dataset.state = 'loading';
  out.textContent = `${owner}/${repo} へ疎通確認中…`;
  try {
    const res = await sendToBackground({ type: 'TEST_AUTH', owner, repo });
    if (!res.ok) {
      out.dataset.state = 'error';
      out.textContent = describeGithubError(res.error);
      return 'error';
    }
    const { text, state } = formatCheckResult(res.value);
    out.dataset.state = state;
    out.textContent = text;
    return state === 'ok' ? 'ok' : state === 'partial' ? 'partial' : 'error';
  } catch (e) {
    out.dataset.state = 'error';
    out.textContent = `background との通信に失敗: ${e instanceof Error ? e.message : String(e)}`;
    return 'error';
  }
}

function renderTokenEntry(owner: string, entry: TokenEntry): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.owner = owner;

  const head = document.createElement('div');
  head.className = 'token-head';
  const ownerEl = document.createElement('span');
  ownerEl.className = 'token-owner';
  ownerEl.textContent = owner;
  head.appendChild(ownerEl);
  if (entry.label) {
    const label = document.createElement('span');
    label.className = 'token-label';
    label.textContent = entry.label;
    head.appendChild(label);
  }
  const actions = document.createElement('div');
  actions.className = 'token-actions';
  const del = document.createElement('button');
  del.className = 'danger';
  del.type = 'button';
  del.textContent = '削除';
  actions.appendChild(del);
  head.appendChild(actions);

  const meta = document.createElement('div');
  meta.className = 'token-meta';
  const dl = document.createElement('dl');
  const addRow = (term: string, value: Node | string): HTMLElement => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    if (typeof value === 'string') dd.textContent = value;
    else dd.appendChild(value);
    dl.append(dt, dd);
    return dd;
  };
  addRow('トークン', maskToken(entry.token));

  const expiry = formatExpiry(entry);
  const expirySpan = document.createElement('span');
  expirySpan.className = 'expiry';
  expirySpan.dataset.state = expiry.state;
  expirySpan.textContent = expiry.text;
  addRow('有効期限', expirySpan);

  const verifiedDd = addRow('確認済みリポジトリ', formatVerifiedRepos(owner, entry));
  const lastVerifiedDd = addRow(
    '最終確認',
    entry.lastVerifiedAt ? new Date(entry.lastVerifiedAt).toLocaleString() : 'なし'
  );
  meta.appendChild(dl);

  // 同じ owner 配下の別リポジトリも個別に確認できるようにする
  // （owner のトークンがあっても Repository access に入っていない repo は 404 になる）
  const verifyRow = document.createElement('div');
  verifyRow.className = 'row verify-row';
  const repoField = document.createElement('input');
  repoField.type = 'text';
  repoField.placeholder = 'repo 名';
  repoField.autocomplete = 'off';
  repoField.value = entry.verifiedRepos?.[0] ?? '';
  const verifyBtn = document.createElement('button');
  verifyBtn.type = 'button';
  verifyBtn.textContent = '疎通確認';
  verifyRow.append(repoField, verifyBtn);

  const verifyOut = document.createElement('p');
  verifyOut.className = 'verify-result';

  verifyBtn.addEventListener('click', () => {
    const repo = repoField.value.trim();
    if (!repo) {
      verifyOut.dataset.state = 'error';
      verifyOut.textContent = 'repo 名を入力してください。';
      return;
    }
    verifyBtn.disabled = true;
    void verify(owner, repo, verifyOut).then(async () => {
      verifyBtn.disabled = false;
      // 一覧ごと作り直すと結果表示が消えてしまうので、変わる行だけ差し替える
      const updated = await getTokenFor(owner);
      if (!updated) return;
      verifiedDd.textContent = formatVerifiedRepos(owner, updated);
      lastVerifiedDd.textContent = updated.lastVerifiedAt
        ? new Date(updated.lastVerifiedAt).toLocaleString()
        : 'なし';
    });
  });

  del.addEventListener('click', () => {
    void (async () => {
      await removeToken(owner);
      await refresh();
    })();
  });

  li.append(head, meta, verifyRow, verifyOut);
  return li;
}

async function refresh(): Promise<void> {
  const store = await getTokenStore();
  const owners = Object.keys(store).sort();
  tokensList.replaceChildren(...owners.map((o) => renderTokenEntry(o, store[o])));
  tokensEmpty.hidden = owners.length > 0;

  const legacy = await getLegacyPat();
  legacyBanner.dataset.visible = legacy ? 'true' : 'false';
}

async function onSave(): Promise<void> {
  const token = tokenInput.value.trim();
  const ref = parseRepoRef(repoInput.value);
  if (!ref) {
    saveResult.dataset.state = 'error';
    saveResult.textContent =
      '対象リポジトリを owner/repo の形式で入力してください（例: octocat/hello-world）。';
    return;
  }
  if (!token) {
    saveResult.dataset.state = 'error';
    saveResult.textContent = 'トークンが入力されていません。';
    return;
  }

  const owner = normalizeOwner(ref.owner);
  await setToken(owner, token, labelInput.value.trim() || undefined);
  tokenInput.value = '';
  await refresh();

  // 保存しただけでは使えるか分からないので、そのまま疎通確認まで走らせる
  const state = await verify(owner, ref.repo, saveResult);
  if (state === 'ok') {
    saveResult.textContent = `${owner} 用のトークンを保存しました。\n${saveResult.textContent ?? ''}`;
  }
  await refresh();
}

/** 対応言語の一覧（shared/languages.ts の登録内容をそのまま表示する） */
function renderLanguages(): void {
  const list = el<HTMLUListElement>('languages');
  for (const lang of LANGUAGE_METADATA) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = lang.displayName;
    const ext = document.createElement('span');
    ext.className = 'ext';
    ext.textContent = lang.extensions.join(' ');
    li.append(name, ext);
    list.appendChild(li);
  }
}

el<HTMLButtonElement>('save').addEventListener('click', () => void onSave());
el<HTMLButtonElement>('legacy-delete').addEventListener('click', () => {
  void (async () => {
    await clearLegacyPat();
    await refresh();
  })();
});

renderLanguages();
// options を直接開いたときも旧 PAT の退避が走るようにする（SW 起動待ちにしない）
void migrateLegacyPat()
  .catch(() => undefined)
  .then(() => refresh());
