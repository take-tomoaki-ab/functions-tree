// PR ページへのトグルボタン注入と、Shadow DOM に隔離したパネルの開閉。

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
`;

let panelHost: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
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
  placeholder.textContent = 'グラフは Phase 4 で実装予定です。';
  statusEl = document.createElement('p');
  statusEl.className = 'status';
  statusEl.textContent = 'background と疎通確認中…';
  body.append(placeholder, statusEl);

  panel.append(header, body);
  shadow.appendChild(panel);
  return host;
}

async function checkBackground(pr: PrRef): Promise<void> {
  if (!statusEl) return;
  try {
    const res = await sendToBackground({ type: 'PING', pr });
    if (res?.type === 'PONG') {
      statusEl.dataset.state = 'ok';
      statusEl.textContent = `background 疎通 OK (PONG, ${new Date(res.receivedAt).toLocaleTimeString()})`;
    } else {
      statusEl.dataset.state = 'error';
      statusEl.textContent = `background から想定外の応答: ${JSON.stringify(res)}`;
    }
  } catch (e) {
    statusEl.dataset.state = 'error';
    statusEl.textContent = `background 疎通失敗: ${e instanceof Error ? e.message : String(e)}`;
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
  void checkBackground(currentPr);
}

function closePanel(): void {
  panelHost?.remove();
  panelHost = null;
  statusEl = null;
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
