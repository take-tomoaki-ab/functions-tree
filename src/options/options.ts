// options ページ。PAT の保存・削除と接続テスト。
// PAT そのものは表示せず、保存済みかどうかだけを示す。

import { describeGithubError } from '../shared/github';
import { LANGUAGE_METADATA } from '../shared/languages';
import { sendToBackground } from '../shared/messages';
import { clearPat, getPat, setPat } from '../shared/settings';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`element not found: #${id}`);
  return found as T;
}

const patInput = el<HTMLInputElement>('pat-input');
const patStatus = el<HTMLParagraphElement>('pat-status');
const testResult = el<HTMLParagraphElement>('test-result');

async function refreshStatus(): Promise<void> {
  const pat = await getPat();
  if (pat) {
    // 先頭 4 文字だけ見せて種別（ghp_ / github_pat_）が分かる程度に留める
    patStatus.dataset.state = 'saved';
    patStatus.textContent = `保存済み（${pat.slice(0, 4)}…・${pat.length} 文字）`;
  } else {
    patStatus.dataset.state = 'empty';
    patStatus.textContent =
      '未設定 — 未認証モードで動作します（公開リポジトリのみ・レート制限 60 req/h）';
  }
}

async function onSave(): Promise<void> {
  const pat = patInput.value.trim();
  if (!pat) {
    testResult.dataset.state = 'error';
    testResult.textContent = 'PAT が入力されていません。';
    return;
  }
  await setPat(pat);
  patInput.value = '';
  testResult.textContent = '';
  await refreshStatus();
}

async function onDelete(): Promise<void> {
  await clearPat();
  testResult.textContent = '';
  await refreshStatus();
}

async function onTest(): Promise<void> {
  testResult.dataset.state = 'loading';
  testResult.textContent = '接続テスト中…';
  try {
    const res = await sendToBackground({ type: 'TEST_AUTH' });
    if (!res.ok) {
      testResult.dataset.state = 'error';
      testResult.textContent = describeGithubError(res.error);
      return;
    }
    const rate = res.value.rateLimit
      ? `残りレート: ${res.value.rateLimit.remaining}/${res.value.rateLimit.limit}（リセット: ${new Date(res.value.rateLimit.reset * 1000).toLocaleTimeString()}）`
      : '';
    testResult.dataset.state = 'ok';
    testResult.textContent = res.value.authenticated
      ? `接続 OK — @${res.value.login} として認証済み。${rate}`
      : `接続 OK — 未認証モード。${rate}`;
  } catch (e) {
    testResult.dataset.state = 'error';
    testResult.textContent = `background との通信に失敗: ${e instanceof Error ? e.message : String(e)}`;
  }
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
el<HTMLButtonElement>('delete').addEventListener('click', () => void onDelete());
el<HTMLButtonElement>('test').addEventListener('click', () => void onTest());

renderLanguages();
void refreshStatus();
