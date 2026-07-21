// PR ページへのトグルボタン注入と、Shadow DOM に隔離したパネルの開閉。
// パネルを開くと background 経由で PR の変更ファイル一覧を取得して表示する
// （Phase 4 でグラフ描画に置き換わるまでの暫定表示 + GitHub API 経路の動作確認を兼ねる）。

import type { PrFile } from '../shared/github';
import { describeGithubError } from '../shared/github';
import type { PrRef } from '../shared/messages';
import { sendToBackground } from '../shared/messages';

const BUTTON_ID = 'functions-tree-toggle';
const PANEL_HOST_ID = 'functions-tree-panel-host';

const PANEL_CSS = `
:host {
  all: initial;
}
.panel {
  position: fixed;
  top: var(--functions-tree-panel-top, 64px);
  right: 16px;
  width: 380px;
  max-height: calc(100vh - var(--functions-tree-panel-top, 64px) - 32px);
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  color: #1f2328;
  border: 1px solid #d1d9e0;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(140, 149, 159, 0.2);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  .panel {
    background: #151b23;
    color: #f0f6fc;
    border-color: #3d444d;
    box-shadow: 0 8px 24px rgba(1, 4, 9, 0.8);
  }
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #d1d9e0;
  font-weight: 600;
}
@media (prefers-color-scheme: dark) {
  .panel-header { border-bottom-color: #3d444d; }
}
.close-button {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
}
.close-button:hover {
  background: rgba(140, 149, 159, 0.2);
}
.panel-body {
  padding: 12px;
  overflow-y: auto;
}
.placeholder {
  color: #59636e;
  margin: 0 0 12px;
}
@media (prefers-color-scheme: dark) {
  .placeholder { color: #9198a1; }
}
.status {
  margin: 0;
  font-size: 12px;
  color: #59636e;
}
@media (prefers-color-scheme: dark) {
  .status { color: #9198a1; }
}
.status[data-state="ok"] { color: #1a7f37; }
.status[data-state="error"] { color: #d1242f; }
@media (prefers-color-scheme: dark) {
  .status[data-state="ok"] { color: #3fb950; }
  .status[data-state="error"] { color: #f85149; }
}
.auth-notice {
  display: none;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  padding: 6px 8px;
  font-size: 12px;
  color: #9a6700;
  background: rgba(212, 167, 44, 0.15);
  border: 1px solid rgba(212, 167, 44, 0.4);
  border-radius: 6px;
}
.auth-notice[data-visible="true"] { display: flex; }
@media (prefers-color-scheme: dark) {
  .auth-notice { color: #d29922; }
}
.open-options {
  border: none;
  background: transparent;
  color: #0969da;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}
@media (prefers-color-scheme: dark) {
  .open-options { color: #4493f8; }
}
.file-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.file-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 4px 0;
  border-bottom: 1px solid rgba(140, 149, 159, 0.2);
  font-size: 12px;
}
.file-path {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
.file-diffstat { white-space: nowrap; }
.additions { color: #1a7f37; }
.deletions { color: #d1242f; }
@media (prefers-color-scheme: dark) {
  .additions { color: #3fb950; }
  .deletions { color: #f85149; }
}
`;

let panelHost: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let authNoticeEl: HTMLElement | null = null;
let fileListEl: HTMLUListElement | null = null;
let currentPr: PrRef | null = null;

function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

/**
 * PR ヘッダーのアクション領域を探す。
 * - [data-component="PH_Actions"]: 現行の React 版 PR ページ（Primer PageHeader）
 * - .gh-header-actions: 旧レイアウトのフォールバック
 * 未ログイン時などアクション領域が空で d-none になっているケースがあるため、
 * 見えているものだけをアンカーとして採用する。
 */
function findButtonAnchor(): HTMLElement | null {
  for (const selector of ['[data-component="PH_Actions"]', '.gh-header-actions']) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && isVisible(el)) return el;
  }
  return null;
}

// GitHub の CSS 変数を参照して純正ボタンの見た目に寄せる（ダークテーマにも追従）
const BUTTON_STYLE =
  'padding:0 12px;height:32px;font-size:14px;font-weight:500;cursor:pointer;' +
  'font-family:inherit;border-radius:6px;' +
  'border:1px solid var(--button-default-borderColor-rest, #d1d9e0);' +
  'background:var(--button-default-bgColor-rest, #f6f8fa);' +
  'color:var(--button-default-fgColor-rest, #25292e);';

function createButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.textContent = '関数依存グラフ';
  button.style.cssText = BUTTON_STYLE;
  button.addEventListener('click', togglePanel);
  return button;
}

/** トグルボタンを PR ヘッダー付近に注入する */
function injectButton(): void {
  const existing = document.getElementById(BUTTON_ID);
  if (existing) {
    // 注入先コンテナごと非表示になった場合は置き直す（React の再レンダリング対策）
    if (isVisible(existing)) return;
    existing.remove();
  }
  const button = createButton();
  const anchor = findButtonAnchor();
  if (anchor) {
    anchor.prepend(button);
  } else {
    // ヘッダー構造が変わっていても最低限使えるように固定表示で出す
    button.style.cssText =
      BUTTON_STYLE + 'position:fixed;top:64px;right:16px;z-index:2147483646;';
    document.body.appendChild(button);
  }
}

function buildPanel(): HTMLElement {
  const host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel';

  const header = document.createElement('div');
  header.className = 'panel-header';
  const title = document.createElement('span');
  title.textContent = '関数依存グラフ';
  const close = document.createElement('button');
  close.className = 'close-button';
  close.type = 'button';
  close.setAttribute('aria-label', 'パネルを閉じる');
  close.textContent = '✕';
  close.addEventListener('click', closePanel);
  header.append(title, close);

  const body = document.createElement('div');
  body.className = 'panel-body';
  const placeholder = document.createElement('p');
  placeholder.className = 'placeholder';
  placeholder.textContent = '変更ファイル一覧（Phase 4 でグラフ表示に置き換え予定）';

  authNoticeEl = document.createElement('div');
  authNoticeEl.className = 'auth-notice';
  const noticeText = document.createElement('span');
  noticeText.textContent = '未認証モード（レート制限あり）';
  const openOptions = document.createElement('button');
  openOptions.className = 'open-options';
  openOptions.type = 'button';
  openOptions.textContent = 'PAT を設定する';
  openOptions.addEventListener('click', () => {
    void sendToBackground({ type: 'OPEN_OPTIONS' });
  });
  authNoticeEl.append(noticeText, openOptions);

  statusEl = document.createElement('p');
  statusEl.className = 'status';
  statusEl.textContent = '変更ファイルを取得中…';
  fileListEl = document.createElement('ul');
  fileListEl.className = 'file-list';
  body.append(placeholder, authNoticeEl, statusEl, fileListEl);

  panel.append(header, body);
  shadow.appendChild(panel);
  return host;
}

function renderFileItem(file: PrFile): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'file-item';
  const path = document.createElement('span');
  path.className = 'file-path';
  path.textContent = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  const diffstat = document.createElement('span');
  diffstat.className = 'file-diffstat';
  const additions = document.createElement('span');
  additions.className = 'additions';
  additions.textContent = `+${file.additions}`;
  const deletions = document.createElement('span');
  deletions.className = 'deletions';
  deletions.textContent = ` −${file.deletions}`;
  diffstat.append(additions, deletions);
  li.append(path, diffstat);
  return li;
}

async function loadPrFiles(pr: PrRef): Promise<void> {
  if (!statusEl || !fileListEl) return;
  delete statusEl.dataset.state;
  statusEl.textContent = '変更ファイルを取得中…';
  try {
    const res = await sendToBackground({ type: 'GET_PR_FILES', pr });
    // パネルが閉じられていたら描画しない
    if (!statusEl || !fileListEl || !authNoticeEl) return;
    authNoticeEl.dataset.visible = res.authMode === 'anonymous' ? 'true' : 'false';
    if (!res.ok) {
      statusEl.dataset.state = 'error';
      statusEl.textContent = describeGithubError(res.error);
      return;
    }
    const { files, truncated } = res.value;
    statusEl.dataset.state = 'ok';
    statusEl.textContent = `変更ファイル ${files.length} 件${truncated ? '（上限に達したため一部のみ）' : ''}`;
    fileListEl.replaceChildren(...files.map(renderFileItem));
  } catch (e) {
    if (!statusEl) return;
    statusEl.dataset.state = 'error';
    statusEl.textContent = `background との通信に失敗: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function openPanel(): void {
  if (panelHost || !currentPr) return;
  panelHost = buildPanel();
  // トグルボタンを覆ってしまわないよう、パネルはボタンの下端から開く
  const button = document.getElementById(BUTTON_ID);
  if (button) {
    const bottom = button.getBoundingClientRect().bottom;
    panelHost.style.setProperty('--functions-tree-panel-top', `${Math.round(bottom) + 8}px`);
  }
  document.body.appendChild(panelHost);
  void loadPrFiles(currentPr);
}

function closePanel(): void {
  panelHost?.remove();
  panelHost = null;
  statusEl = null;
  authNoticeEl = null;
  fileListEl = null;
}

function togglePanel(): void {
  if (panelHost) {
    closePanel();
  } else {
    openPanel();
  }
}

/** PR ページに入ったとき: ボタンを注入する */
export function mountUi(pr: PrRef): void {
  currentPr = pr;
  injectButton();
}

/** PR ページを離れたとき: ボタンとパネルを除去する */
export function unmountUi(): void {
  currentPr = null;
  document.getElementById(BUTTON_ID)?.remove();
  closePanel();
}

/**
 * turbo 遷移は PR ページ内でも DOM を差し替えるため（例: Conversation ⇔ Files changed）、
 * ボタンが消えていたら注入し直す。detector の onEnter だけでは拾えないケースの保険。
 */
export function ensureButton(): void {
  if (currentPr) injectButton();
}
