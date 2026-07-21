// PR ページへのトグルボタン注入と、Shadow DOM に隔離したパネルの開閉。
// パネルを開くと background に BUILD_GRAPH を依頼し、コールグラフを mermaid で描画する。
// レイアウトはグラフ表示エリア + サイドペイン（関数詳細）の 2 ペイン構成。
// mermaid 本体（約 3MB）は dist/mermaid-view.js に別バンドルしてあり、
// 初回描画時に動的 import する（content.js 自体は軽いまま）。

import { describeGithubError } from '../shared/github';
import type { FunctionGraph, GraphNode } from '../shared/graph';
import type { PrRef } from '../shared/messages';
import { sendToBackground } from '../shared/messages';
import { getPat, PAT_KEY } from '../shared/settings';
import type { GraphFilter } from './mermaid-source';
import { filterGraph } from './mermaid-source';
import type { GraphRenderer, RenderHandle } from './mermaid-view';

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
  width: min(1080px, calc(100vw - 48px));
  height: min(680px, calc(100vh - var(--functions-tree-panel-top, 64px) - 24px));
  min-width: 520px;
  min-height: 360px;
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
  /* 右下ハンドルでリサイズ可能（right 固定なので幅は左方向に広がる） */
  resize: both;
  overflow: hidden;
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
  flex-shrink: 0;
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
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  flex-shrink: 0;
  padding: 6px 12px;
  border-bottom: 1px solid rgba(140, 149, 159, 0.3);
  font-size: 12px;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}
.toggle input {
  accent-color: #0969da;
  cursor: pointer;
}
.node-count {
  color: #59636e;
}
@media (prefers-color-scheme: dark) {
  .node-count { color: #9198a1; }
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.legend-chip {
  width: 14px;
  height: 14px;
  border-radius: 3px;
}
.legend-chip.chip-commentable {
  background: #dafbe1;
  border: 2px solid #1a7f37;
}
.legend-chip.chip-in-diff {
  background: #fff8c5;
  border: 1px solid #9a6700;
}
.legend-chip.chip-dep {
  background: #f6f8fa;
  border: 1px dashed #8c959f;
}
.auth-notice {
  display: none;
  align-items: center;
  gap: 8px;
  margin: 8px 12px 0;
  padding: 6px 8px;
  font-size: 12px;
  color: #9a6700;
  background: rgba(212, 167, 44, 0.15);
  border: 1px solid rgba(212, 167, 44, 0.4);
  border-radius: 6px;
  flex-shrink: 0;
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
.status {
  margin: 0;
  padding: 6px 12px;
  flex-shrink: 0;
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
.main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.graph-area {
  flex: 1;
  overflow: auto;
  padding: 12px;
  /* mermaid の SVG はライトテーマ配色で生成するため背景は常に白 */
  background: #ffffff;
}
.graph-empty {
  margin: 0;
  color: #59636e;
  font-size: 12px;
}
/* 選択中ノードの強調（mermaid が生成した SVG の g.node に .selected を付ける） */
.graph-area g.node.selected rect,
.graph-area g.node.selected polygon,
.graph-area g.node.selected path {
  stroke: #0969da !important;
  stroke-width: 3px !important;
  stroke-dasharray: none !important;
}
.side-pane {
  width: 320px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 12px;
  border-left: 1px solid rgba(140, 149, 159, 0.3);
  font-size: 12px;
}
.side-placeholder {
  margin: 0;
  color: #59636e;
}
@media (prefers-color-scheme: dark) {
  .side-placeholder { color: #9198a1; }
}
.detail-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
}
.detail-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  font-weight: 600;
  word-break: break-all;
}
.detail-meta {
  margin: 0 0 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #59636e;
  word-break: break-all;
}
@media (prefers-color-scheme: dark) {
  .detail-meta { color: #9198a1; }
}
.source {
  margin: 0 0 12px;
  padding: 8px;
  max-height: 45%;
  overflow: auto;
  background: rgba(140, 149, 159, 0.1);
  border: 1px solid rgba(140, 149, 159, 0.3);
  border-radius: 6px;
}
.source code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre;
}
.comment-label {
  display: block;
  margin: 0 0 4px;
  font-weight: 600;
}
.comment-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 64px;
  padding: 6px 8px;
  font-family: inherit;
  font-size: 12px;
  color: inherit;
  background: transparent;
  border: 1px solid rgba(140, 149, 159, 0.5);
  border-radius: 6px;
  resize: vertical;
}
.comment-target {
  margin: 0 0 6px;
  color: #59636e;
}
.comment-line-select {
  margin-left: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: inherit;
  background: transparent;
  border: 1px solid rgba(140, 149, 159, 0.5);
  border-radius: 6px;
  padding: 1px 4px;
}
.comment-line-select option {
  color: initial;
}
.comment-submit {
  margin-top: 6px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid rgba(31, 136, 61, 0.6);
  border-radius: 6px;
  background: #1f883d;
  color: #ffffff;
  cursor: pointer;
}
.comment-submit:disabled {
  border-color: rgba(140, 149, 159, 0.5);
  background: rgba(140, 149, 159, 0.15);
  color: #59636e;
  cursor: not-allowed;
}
.comment-status {
  margin: 6px 0 0;
}
.comment-status[data-state="posting"] { color: #59636e; }
.comment-status[data-state="ok"] { color: #1a7f37; }
.comment-status[data-state="error"] { color: #d1242f; }
@media (prefers-color-scheme: dark) {
  .comment-status[data-state="posting"] { color: #9198a1; }
  .comment-status[data-state="ok"] { color: #3fb950; }
  .comment-status[data-state="error"] { color: #f85149; }
}
.comment-status a {
  color: #0969da;
}
@media (prefers-color-scheme: dark) {
  .comment-status a { color: #4493f8; }
}
.comment-note {
  margin: 4px 0 0;
  color: #59636e;
}
.comment-auth {
  display: none;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 6px 0 0;
  padding: 6px 8px;
  color: #9a6700;
  background: rgba(212, 167, 44, 0.15);
  border: 1px solid rgba(212, 167, 44, 0.4);
  border-radius: 6px;
}
.comment-auth[data-visible="true"] { display: flex; }
.comment-disabled {
  margin: 0;
  padding: 6px 8px;
  color: #9a6700;
  background: rgba(212, 167, 44, 0.15);
  border: 1px solid rgba(212, 167, 44, 0.4);
  border-radius: 6px;
}
@media (prefers-color-scheme: dark) {
  .comment-target { color: #9198a1; }
  .comment-note { color: #9198a1; }
  .comment-auth { color: #d29922; }
  .comment-disabled { color: #d29922; }
}
.in-diff-badge {
  flex-shrink: 0;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: #1a7f37;
  background: rgba(31, 136, 61, 0.15);
  border: 1px solid rgba(31, 136, 61, 0.4);
  border-radius: 999px;
  white-space: nowrap;
}
@media (prefers-color-scheme: dark) {
  .in-diff-badge { color: #3fb950; }
}
.out-diff-badge {
  flex-shrink: 0;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: #59636e;
  background: rgba(140, 149, 159, 0.15);
  border: 1px solid rgba(140, 149, 159, 0.4);
  border-radius: 999px;
  white-space: nowrap;
}
@media (prefers-color-scheme: dark) {
  .out-diff-badge { color: #9198a1; }
}
`;

let panelHost: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let authNoticeEl: HTMLElement | null = null;
let graphAreaEl: HTMLElement | null = null;
let sidePaneEl: HTMLElement | null = null;
let nodeCountEl: HTMLElement | null = null;
let currentPr: PrRef | null = null;

let currentGraph: FunctionGraph | null = null;
/** 解析に使った head コミット SHA（コメント投稿の commit_id に使う） */
let currentHeadSha: string | null = null;
let selectedNode: GraphNode | null = null;
let renderHandle: RenderHandle | null = null;
// PAT が設定されているか（コメント投稿ボタンの活性条件）。
// パネルを開いたときに読み、storage.onChanged で追従する
// （パネルの「PAT を設定する」から options で保存 → 戻るとボタンが自動で活きる）
let patConfigured = false;
// 表示中のコメントフォームの状態更新関数（PAT 設定変更時に呼ぶ）
let commentUiUpdater: (() => void) | null = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(PAT_KEY in changes)) return;
  const v = changes[PAT_KEY].newValue as unknown;
  patConfigured = typeof v === 'string' && v.length > 0;
  commentUiUpdater?.();
});
// フィルタ初期値: 孤立ノード（エッジなし）が多いグラフでも見やすいよう、
// 「エッジのあるノードのみ」をデフォルト ON にする
let graphFilter: GraphFilter = { connectedOnly: true, inDiffOnly: false };
// 描画の競合対策（フィルタ連打時など、古い非同期描画の結果を捨てる）
let renderToken = 0;

// mermaid を含む重量級モジュールの遅延ロード（初回のみ fetch、以後キャッシュ）
type MermaidViewModule = typeof import('./mermaid-view');
let viewModulePromise: Promise<MermaidViewModule> | null = null;
let rendererInstance: GraphRenderer | null = null;

async function getRenderer(): Promise<GraphRenderer> {
  if (rendererInstance) return rendererInstance;
  viewModulePromise ??= import(
    chrome.runtime.getURL('mermaid-view.js')
  ) as Promise<MermaidViewModule>;
  const mod = await viewModulePromise;
  rendererInstance = mod.createRenderer();
  return rendererInstance;
}

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

function createToggle(
  className: string,
  labelText: string,
  checked: boolean,
  onChange: (checked: boolean) => void
): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = className;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(input, text);
  return label;
}

function createLegendItem(chipClass: string, text: string): HTMLElement {
  const item = document.createElement('span');
  item.className = 'legend-item';
  const chip = document.createElement('span');
  chip.className = `legend-chip ${chipClass}`;
  const label = document.createElement('span');
  label.textContent = text;
  item.append(chip, label);
  return item;
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

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.append(
    createToggle('filter-connected', 'エッジのあるノードのみ', graphFilter.connectedOnly, (checked) => {
      graphFilter = { ...graphFilter, connectedOnly: checked };
      void renderGraph();
    }),
    createToggle('filter-indiff', '変更ファイル内のみ', graphFilter.inDiffOnly, (checked) => {
      graphFilter = { ...graphFilter, inDiffOnly: checked };
      void renderGraph();
    })
  );
  nodeCountEl = document.createElement('span');
  nodeCountEl.className = 'node-count';
  toolbar.append(nodeCountEl);
  const legend = document.createElement('span');
  legend.className = 'legend';
  legend.append(
    createLegendItem('chip-commentable', 'コメント可（diff の行）'),
    createLegendItem('chip-in-diff', '変更ファイル内（関数は無変更）'),
    createLegendItem('chip-dep', '依存先（diff 外）')
  );
  toolbar.append(legend);

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
  statusEl.textContent = 'コールグラフを解析中…';

  const main = document.createElement('div');
  main.className = 'main';
  graphAreaEl = document.createElement('div');
  graphAreaEl.className = 'graph-area';
  sidePaneEl = document.createElement('div');
  sidePaneEl.className = 'side-pane';
  main.append(graphAreaEl, sidePaneEl);
  renderSidePlaceholder();

  panel.append(header, toolbar, authNoticeEl, statusEl, main);
  shadow.appendChild(panel);
  return host;
}

function renderSidePlaceholder(): void {
  if (!sidePaneEl) return;
  commentUiUpdater = null;
  const p = document.createElement('p');
  p.className = 'side-placeholder';
  p.textContent = 'グラフのノードをクリックすると、関数の詳細をここに表示します。';
  sidePaneEl.replaceChildren(p);
}

/** サイドペインに関数詳細（名前 / 位置 / ソース / コメント欄）を描画する */
function renderNodeDetail(node: GraphNode): void {
  if (!sidePaneEl) return;

  const titleRow = document.createElement('div');
  titleRow.className = 'detail-title';
  const name = document.createElement('span');
  name.className = 'detail-name';
  name.textContent = node.name;
  const badge = document.createElement('span');
  badge.className = node.inDiff ? 'in-diff-badge' : 'out-diff-badge';
  badge.textContent = node.inDiff ? 'diff 内' : 'diff 外';
  titleRow.append(name, badge);

  const location = document.createElement('p');
  location.className = 'detail-meta';
  location.textContent = `${node.filePath}:${node.startLine}-${node.endLine}`;

  const meta = document.createElement('p');
  meta.className = 'detail-meta';
  meta.textContent =
    node.exportName !== undefined
      ? `${node.kind} / export: ${node.exportName}`
      : `${node.kind} / 非 export`;

  const source = document.createElement('pre');
  source.className = 'source';
  const code = document.createElement('code');
  code.textContent = node.sourceText;
  source.appendChild(code);

  const commentArea = document.createElement('div');
  commentArea.className = 'comment-area';
  const commentLabel = document.createElement('span');
  commentLabel.className = 'comment-label';
  commentLabel.textContent = 'レビューコメント';
  commentArea.appendChild(commentLabel);
  commentUiUpdater = null;
  if (node.commentableLines.length > 0) {
    commentArea.appendChild(buildCommentForm(node));
  } else {
    const disabled = document.createElement('p');
    disabled.className = 'comment-disabled';
    disabled.textContent = node.inDiff
      ? '関数は変更されていません（diff に含まれる行がないためコメントできません）'
      : 'diff 外のためコメント不可（GitHub は diff に含まれる行にのみコメントできます）';
    commentArea.appendChild(disabled);
  }

  sidePaneEl.replaceChildren(titleRow, location, meta, source, commentArea);
}

/**
 * コメント可能ノード用の投稿フォームを組み立てる。
 * - 対象行の表示（commentableLines が複数なら select で選択可能。既定は commentLine =
 *   関数範囲内の最初の追加行、なければ最初のコメント可能行）
 * - 投稿ボタンは「PAT 設定済み かつ 本文が空でない」ときだけ活性
 *   （PAT 未設定時は background 側でも pat_required で拒否する二重防御）
 * - 成功時は作成されたコメントの html_url リンク、失敗時は人間可読エラーを表示
 */
function buildCommentForm(node: GraphNode): HTMLElement {
  const form = document.createElement('div');
  form.className = 'comment-form';

  const defaultLine = node.commentLine ?? node.commentableLines[0];
  let selectedLine = defaultLine;

  const target = document.createElement('p');
  target.className = 'comment-target';
  const targetText = document.createElement('span');
  const renderTargetText = (): void => {
    targetText.textContent = `${node.filePath} の L${selectedLine} にコメントされます`;
  };
  renderTargetText();
  target.appendChild(targetText);
  if (node.commentableLines.length > 1) {
    const select = document.createElement('select');
    select.className = 'comment-line-select';
    select.setAttribute('aria-label', 'コメント先の行を選択');
    for (const line of node.commentableLines) {
      const option = document.createElement('option');
      option.value = String(line);
      option.textContent = `L${line}`;
      option.selected = line === defaultLine;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      selectedLine = Number(select.value);
      renderTargetText();
    });
    target.appendChild(select);
  }

  const input = document.createElement('textarea');
  input.className = 'comment-input';
  input.placeholder = 'この関数へのレビューコメント…（Markdown 可）';

  const submit = document.createElement('button');
  submit.className = 'comment-submit';
  submit.type = 'button';
  submit.textContent = 'コメント投稿';

  const authNotice = document.createElement('div');
  authNotice.className = 'comment-auth';
  const authText = document.createElement('span');
  authText.textContent = 'コメント投稿には PAT が必要です。';
  const openOptions = document.createElement('button');
  openOptions.className = 'open-options';
  openOptions.type = 'button';
  openOptions.textContent = 'PAT を設定する';
  openOptions.addEventListener('click', () => {
    void sendToBackground({ type: 'OPEN_OPTIONS' });
  });
  authNotice.append(authText, openOptions);

  const status = document.createElement('p');
  status.className = 'comment-status';

  let posting = false;
  const update = (): void => {
    submit.disabled = posting || !patConfigured || input.value.trim() === '';
    submit.textContent = posting ? '投稿中…' : 'コメント投稿';
    authNotice.dataset.visible = patConfigured ? 'false' : 'true';
  };
  input.addEventListener('input', update);

  submit.addEventListener('click', () => {
    if (posting || !currentPr || !currentHeadSha) return;
    const body = input.value.trim();
    if (body === '') return;
    posting = true;
    status.dataset.state = 'posting';
    status.textContent = '投稿中…';
    update();
    void sendToBackground({
      type: 'POST_REVIEW_COMMENT',
      pr: currentPr,
      commitId: currentHeadSha,
      path: node.filePath,
      line: selectedLine,
      body,
    })
      .then((res) => {
        posting = false;
        if (!form.isConnected) return; // 投稿中にノード切替 / パネルが閉じられた
        if (res.ok) {
          status.dataset.state = 'ok';
          status.textContent = 'コメントを投稿しました: ';
          const link = document.createElement('a');
          link.href = res.value.htmlUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'PR で見る';
          status.appendChild(link);
          input.value = '';
        } else {
          status.dataset.state = 'error';
          status.textContent = describeGithubError(res.error);
        }
        update();
      })
      .catch((e: unknown) => {
        posting = false;
        if (!form.isConnected) return;
        status.dataset.state = 'error';
        status.textContent = `background との通信に失敗: ${e instanceof Error ? e.message : String(e)}`;
        update();
      });
  });

  commentUiUpdater = update;
  update();
  form.append(target, input, submit, authNotice, status);
  return form;
}

function selectNode(node: GraphNode | null): void {
  selectedNode = node;
  renderHandle?.setSelected(node?.id ?? null);
  if (node) {
    renderNodeDetail(node);
  } else {
    renderSidePlaceholder();
  }
}

/** 現在のグラフ + フィルタ状態で mermaid を描画し直す */
async function renderGraph(): Promise<void> {
  if (!currentGraph || !graphAreaEl || !nodeCountEl) return;
  const token = ++renderToken;
  const filtered = filterGraph(currentGraph, graphFilter);
  nodeCountEl.textContent = `表示 ${filtered.nodes.length} / 全 ${currentGraph.nodes.length} ノード`;
  // 選択中のノードがフィルタで非表示になったら選択を解除する
  if (selectedNode && !filtered.nodes.some((n) => n.id === selectedNode?.id)) {
    selectNode(null);
  }
  if (filtered.nodes.length === 0) {
    renderHandle = null;
    const empty = document.createElement('p');
    empty.className = 'graph-empty';
    empty.textContent = '表示できるノードがありません（フィルタを緩めてください）。';
    graphAreaEl.replaceChildren(empty);
    return;
  }
  try {
    const renderer = await getRenderer();
    const handle = await renderer.render(graphAreaEl, filtered, {
      onNodeClick: selectNode,
    });
    // 描画中にパネルが閉じられた / 別の描画が始まっていたら反映しない
    if (token !== renderToken || !panelHost) return;
    renderHandle = handle;
    if (selectedNode) handle.setSelected(selectedNode.id);
  } catch (e) {
    if (token !== renderToken || !statusEl) return;
    statusEl.dataset.state = 'error';
    statusEl.textContent = `グラフ描画に失敗: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadGraph(pr: PrRef): Promise<void> {
  if (!statusEl) return;
  delete statusEl.dataset.state;
  statusEl.textContent = 'コールグラフを解析中…';
  try {
    const res = await sendToBackground({ type: 'BUILD_GRAPH', pr });
    // パネルが閉じられていたら描画しない
    if (!statusEl || !authNoticeEl || !panelHost) return;
    authNoticeEl.dataset.visible = res.authMode === 'anonymous' ? 'true' : 'false';
    if (!res.ok) {
      statusEl.dataset.state = 'error';
      statusEl.textContent = describeGithubError(res.error);
      return;
    }
    const { graph, headSha, fromCache } = res.value;
    currentHeadSha = headSha;
    statusEl.dataset.state = 'ok';
    statusEl.textContent =
      `関数 ${graph.nodes.length} / 呼び出し ${graph.edges.length} / ` +
      `解析 ${graph.analyzedFiles.length} ファイル / スキップ ${graph.skippedFiles.length}` +
      `${graph.unresolvedCallCount > 0 ? ` / 未解決呼び出し ${graph.unresolvedCallCount}` : ''}` +
      `${fromCache ? '（キャッシュ）' : ''}`;
    currentGraph = graph;
    await renderGraph();
  } catch (e) {
    if (!statusEl) return;
    statusEl.dataset.state = 'error';
    statusEl.textContent = `background との通信に失敗: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function openPanel(): void {
  if (panelHost || !currentPr) return;
  // パネルを開くたびにフィルタ・選択状態は初期値に戻す
  graphFilter = { connectedOnly: true, inDiffOnly: false };
  selectedNode = null;
  currentGraph = null;
  currentHeadSha = null;
  renderHandle = null;
  // コメント投稿ボタンの活性条件。以後の変更は storage.onChanged が追従する
  void getPat().then((pat) => {
    patConfigured = pat !== null;
    commentUiUpdater?.();
  });
  panelHost = buildPanel();
  // トグルボタンを覆ってしまわないよう、パネルはボタンの下端から開く
  const button = document.getElementById(BUTTON_ID);
  if (button) {
    const bottom = button.getBoundingClientRect().bottom;
    panelHost.style.setProperty('--functions-tree-panel-top', `${Math.round(bottom) + 8}px`);
  }
  document.body.appendChild(panelHost);
  void loadGraph(currentPr);
}

function closePanel(): void {
  panelHost?.remove();
  panelHost = null;
  statusEl = null;
  authNoticeEl = null;
  graphAreaEl = null;
  sidePaneEl = null;
  nodeCountEl = null;
  currentGraph = null;
  currentHeadSha = null;
  selectedNode = null;
  renderHandle = null;
  commentUiUpdater = null;
  renderToken++;
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
