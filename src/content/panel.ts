// PR ページへのトグルボタン注入と、Shadow DOM に隔離したパネルの開閉。
// パネルを開くと background に BUILD_GRAPH を依頼し、コールグラフを mermaid で描画する。
// レイアウトはグラフ表示エリア + サイドペイン（関数詳細）の 2 ペイン構成。
// mermaid 本体（約 3MB）は dist/mermaid-view.js に別バンドルしてあり、
// 初回描画時に動的 import する（content.js 自体は軽いまま）。

import type { PendingComment, PendingReviewPayload } from '../shared/github';
import { describeGithubError } from '../shared/github';
import type { FunctionGraph, GraphNode, HighlightToken } from '../shared/graph';
import type {
  AddPendingCommentRequest,
  DeletePendingCommentRequest,
  PrRef,
  UpdatePendingCommentRequest,
} from '../shared/messages';
import { sendToBackground } from '../shared/messages';
import { draftNodeIds, findCommentForNode } from '../shared/review-drafts';
import { getPat, PAT_KEY } from '../shared/settings';
import type { GraphFilter } from './mermaid-source';
import { filterGraph } from './mermaid-source';
import type { GraphRenderer, RenderHandle } from './mermaid-view';
import {
  anchoredScroll,
  clampZoom,
  formatZoom,
  wheelZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomIn,
  zoomOut,
} from './zoom';

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
.legend-chip.chip-draft {
  background: #fff1e5;
  border: 2px solid #bc4c00;
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
  min-width: 0;
  position: relative;
  overflow: hidden;
  /* mermaid の SVG はライトテーマ配色で生成するため背景は常に白 */
  background: #ffffff;
}
.graph-scroll {
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
  padding: 12px;
}
/* ズームコントロール（グラフ領域右上のオーバーレイ）。グラフ領域は常に白背景なので
   ダークテーマでもライト配色のままにする */
.zoom-controls {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #d1d9e0;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(140, 149, 159, 0.25);
}
.zoom-button {
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  font-size: 13px;
  line-height: 1;
  color: #25292e;
  background: #f6f8fa;
  border: 1px solid #d1d9e0;
  border-radius: 6px;
  cursor: pointer;
}
.zoom-button:hover:enabled {
  background: #eef1f4;
}
.zoom-button:disabled {
  color: #8c959f;
  cursor: not-allowed;
}
.zoom-reset {
  font-size: 12px;
}
.zoom-level {
  min-width: 40px;
  text-align: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #59636e;
}
.graph-empty {
  margin: 0;
  color: #59636e;
  font-size: 12px;
}
/* 下書きノード / 選択ノードの強調。実際の描画は mermaid-view の applyHighlights が
   インラインスタイルで当てる（mermaid の classDef が #svgId + !important の CSS を
   SVG 内に埋めるため、ここからは specificity で勝てない）。以下はレンダラーを
   差し替えたとき用のフォールバック */
.graph-area g.node.has-draft rect,
.graph-area g.node.has-draft polygon,
.graph-area g.node.has-draft path {
  stroke: #bc4c00 !important;
  stroke-width: 3px !important;
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
/* シンタックスハイライト（GitHub のライト / ダーク配色に合わせる） */
.source .tok-keyword { color: #cf222e; }
.source .tok-string { color: #0a3069; }
.source .tok-comment { color: #59636e; }
.source .tok-number { color: #0550ae; }
.source .tok-constant { color: #0550ae; }
.source .tok-function { color: #8250df; }
.source .tok-type { color: #953800; }
@media (prefers-color-scheme: dark) {
  .source .tok-keyword { color: #ff7b72; }
  .source .tok-string { color: #a5d6ff; }
  .source .tok-comment { color: #9198a1; }
  .source .tok-number { color: #79c0ff; }
  .source .tok-constant { color: #79c0ff; }
  .source .tok-function { color: #d2a8ff; }
  .source .tok-type { color: #ffa657; }
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
.draft-remove {
  margin-top: 6px;
  margin-left: 6px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid rgba(209, 36, 47, 0.5);
  border-radius: 6px;
  background: transparent;
  color: #d1242f;
  cursor: pointer;
}
.draft-remove[hidden] { display: none; }
@media (prefers-color-scheme: dark) {
  .draft-remove { color: #f85149; }
}
.drafts-pane {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  max-height: 200px;
  padding: 8px 12px;
  border-top: 1px solid rgba(140, 149, 159, 0.3);
  font-size: 12px;
}
.drafts-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.drafts-title {
  font-weight: 600;
}
.drafts-count {
  min-width: 18px;
  padding: 0 5px;
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  color: #ffffff;
  background: #bc4c00;
  border-radius: 999px;
}
.drafts-count[data-empty="true"] { background: rgba(140, 149, 159, 0.6); }
.drafts-refresh {
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid rgba(140, 149, 159, 0.5);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.drafts-refresh:hover:enabled {
  background: rgba(140, 149, 159, 0.2);
}
.drafts-refresh:disabled {
  color: #59636e;
  cursor: not-allowed;
}
.review-submit {
  margin-left: auto;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid rgba(31, 136, 61, 0.6);
  border-radius: 6px;
  background: #1f883d;
  color: #ffffff;
  cursor: pointer;
}
.review-submit:disabled {
  border-color: rgba(140, 149, 159, 0.5);
  background: rgba(140, 149, 159, 0.15);
  color: #59636e;
  cursor: not-allowed;
}
.drafts-auth {
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
.drafts-auth[data-visible="true"] { display: flex; }
.review-status {
  margin: 6px 0 0;
}
.review-status:empty { display: none; }
.review-status[data-state="posting"] { color: #59636e; }
.review-status[data-state="ok"] { color: #1a7f37; }
.review-status[data-state="error"] { color: #d1242f; }
.review-status a { color: #0969da; }
@media (prefers-color-scheme: dark) {
  .drafts-auth { color: #d29922; }
  .review-status[data-state="posting"] { color: #9198a1; }
  .review-status[data-state="ok"] { color: #3fb950; }
  .review-status[data-state="error"] { color: #f85149; }
  .review-status a { color: #4493f8; }
}
.drafts-list {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
.drafts-empty {
  color: #59636e;
}
@media (prefers-color-scheme: dark) {
  .drafts-empty { color: #9198a1; }
}
.draft-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.draft-item + .draft-item {
  border-top: 1px dashed rgba(140, 149, 159, 0.3);
}
.draft-node-name {
  flex-shrink: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
  word-break: break-all;
}
.draft-loc {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #59636e;
}
.draft-preview {
  flex: 1;
  min-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #59636e;
}
@media (prefers-color-scheme: dark) {
  .draft-loc { color: #9198a1; }
  .draft-preview { color: #9198a1; }
}
.draft-edit,
.draft-delete {
  flex-shrink: 0;
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid rgba(140, 149, 159, 0.5);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.draft-edit:hover,
.draft-delete:hover {
  background: rgba(140, 149, 159, 0.2);
}
.draft-edit:disabled {
  color: #59636e;
  cursor: not-allowed;
}
.draft-delete {
  border-color: rgba(209, 36, 47, 0.5);
  color: #d1242f;
}
@media (prefers-color-scheme: dark) {
  .draft-delete { color: #f85149; }
}
`;

let panelHost: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let authNoticeEl: HTMLElement | null = null;
let graphAreaEl: HTMLElement | null = null;
/** グラフのスクロールコンテナ（.graph-scroll）。レンダラーの描画先はこちら */
let graphCanvasEl: HTMLElement | null = null;
let sidePaneEl: HTMLElement | null = null;
let nodeCountEl: HTMLElement | null = null;
let draftsListEl: HTMLElement | null = null;
let draftsCountEl: HTMLElement | null = null;
let draftsRefreshEl: HTMLButtonElement | null = null;
let reviewSubmitEl: HTMLButtonElement | null = null;
let reviewStatusEl: HTMLElement | null = null;
let draftsAuthEl: HTMLElement | null = null;
let currentPr: PrRef | null = null;

// GitHub の pending review（ネイティブの下書きレビュー）の状態。GitHub 側が正で、
// 取得・変更のたびに background 応答の内容へ丸ごと置き換える（ローカル退避はしない。
// 下書きは GitHub の PR 画面からも見え、ブラウザを閉じても消えない）。
let pendingReviewId: string | null = null;
let drafts: PendingComment[] = [];
// pending review への操作（取得・追加・更新・削除）の実行中フラグ。
// GitHub 側の状態が正なので、並行して変更しないよう 1 操作ずつに絞る
let draftsBusy = false;
// SUBMIT_PENDING_REVIEW の送信中フラグ（二重送信防止）
let submitting = false;

let currentGraph: FunctionGraph | null = null;
/** 解析に使った head コミット SHA（コメント投稿の commit_id に使う） */
let currentHeadSha: string | null = null;
let selectedNode: GraphNode | null = null;
let renderHandle: RenderHandle | null = null;
// グラフの表示倍率（1 = 実寸）。フィルタ切り替えの再描画でも維持し、
// パネルを開き直したら 1 に戻す
let zoomLevel = 1;
// ズームコントロールの表示更新関数（倍率表示・ボタン活性）。パネル構築時に差し込む
let zoomUiUpdater: (() => void) | null = null;
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
  // PAT が設定されたら pending review を取りに行く（その PAT の下書きが既にあるかも
  // しれない）。外されたら pending review は見えなくなるので表示を空にする
  if (panelHost && currentPr) {
    if (patConfigured) {
      void loadPendingReview(currentPr);
    } else {
      pendingReviewId = null;
      drafts = [];
    }
  }
  renderDrafts(); // 送信ボタンの活性・PAT 導線も追従させる
});
/**
 * パネル表示中の Esc キー処理。document の capture で拾う
 * （パネル host は GitHub ショートカット誤発動対策で keydown の伝播を止めるため、
 * バブリングでは document に届かない。capture なら host より先に受け取れる）。
 * - パネル内のコメント入力中（textarea フォーカス中）の Esc はフォーカス解除に留め、
 *   書きかけの本文を閉じ損ないで失わないようにする（もう一度 Esc で閉じる）
 * - パネル外の入力欄（GitHub のファイル検索等）にフォーカスがあるときは
 *   GitHub 側の Esc 動作（検索を閉じる等）を優先し、パネルは閉じない
 */
function handleEscapeKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !panelHost) return;
  if (e.composedPath().includes(panelHost)) {
    const active = panelHost.shadowRoot?.activeElement;
    if (active instanceof HTMLTextAreaElement) {
      active.blur();
    } else {
      closePanel();
    }
    e.stopPropagation();
    return;
  }
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  ) {
    return;
  }
  closePanel();
  e.stopPropagation();
}

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

// ヘッダーが画面外にスクロールしたときの浮遊表示（sticky ツールバーに Submit
// ボタンが見つからないときのフォールバック）。GitHub の sticky ヘッダー
// （PR タイトルバー、高さ約 60px）の下に重ならない位置
const FLOATING_BUTTON_STYLE =
  'position:fixed;top:64px;right:16px;z-index:2147483646;' +
  'box-shadow:0 3px 8px rgba(31, 35, 40, 0.25);';

// sticky ツールバー内に並べるときのサイズ調整（Submit ボタンは data-size="small"）
const STICKY_TOOLBAR_BUTTON_STYLE = 'height:28px;font-size:12px;margin-right:8px;';

/**
 * Files changed タブの sticky ツールバーにある「Submit review / comments」
 * ボタンを探す。スクロール追従時はこのボタンの左に並べる。
 */
function findStickySubmitButton(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('button[class*="ReviewMenuButton"]')) {
    if (isVisible(el)) return el;
  }
  return null;
}

/**
 * 浮遊表示の切り替え。追従時は sticky ツールバーの Submit ボタンの左へ移動し、
 * Submit ボタンがないタブ（Conversation 等）では右上に fixed で浮かせる。
 * ヘッダーが見える位置に戻ったら元のアンカーへ戻す。
 */
function applyFloating(button: HTMLButtonElement, anchor: HTMLElement, floated: boolean): void {
  if (!floated) {
    button.style.cssText = BUTTON_STYLE;
    if (button.parentElement !== anchor) anchor.prepend(button);
    return;
  }
  const submit = findStickySubmitButton();
  if (submit?.parentElement) {
    button.style.cssText = BUTTON_STYLE + STICKY_TOOLBAR_BUTTON_STYLE;
    submit.parentElement.insertBefore(button, submit);
  } else {
    button.style.cssText = BUTTON_STYLE + FLOATING_BUTTON_STYLE;
  }
}

// ボタン注入先アンカーの可視監視（スクロール追従用）。再注入のたびに張り替える
let anchorObserver: IntersectionObserver | null = null;

/**
 * アンカー（PR ヘッダーのアクション領域）を監視し、上方向へ画面外に出たら
 * ボタンを浮遊表示に切り替え、ヘッダーが戻ったら元のインライン表示に戻す。
 */
function watchAnchorVisibility(button: HTMLButtonElement, anchor: HTMLElement): void {
  anchorObserver?.disconnect();
  anchorObserver = new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1];
    const floated = !entry.isIntersecting && entry.boundingClientRect.bottom <= 0;
    applyFloating(button, anchor, floated);
  });
  anchorObserver.observe(anchor);
}

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
    watchAnchorVisibility(button, anchor);
  } else {
    // ヘッダー構造が変わっていても最低限使えるように固定表示で出す
    anchorObserver?.disconnect();
    anchorObserver = null;
    button.style.cssText = BUTTON_STYLE + FLOATING_BUTTON_STYLE;
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

/**
 * 表示倍率を変更し、SVG のサイズとスクロール位置・コントロール表示へ反映する。
 * anchor は .graph-scroll のビューポート内座標で、その真下のコンテンツが
 * ズーム後も動かないようスクロールを合わせる（省略時はビューポート中央）。
 */
function setZoomLevel(next: number, anchor?: { x: number; y: number }): void {
  const clamped = clampZoom(next);
  const prev = zoomLevel;
  zoomLevel = clamped;
  zoomUiUpdater?.();
  if (!graphCanvasEl || !renderHandle || clamped === prev) return;
  renderHandle.setZoom(clamped);
  const ratio = clamped / prev;
  const a = anchor ?? {
    x: graphCanvasEl.clientWidth / 2,
    y: graphCanvasEl.clientHeight / 2,
  };
  graphCanvasEl.scrollLeft = anchoredScroll(graphCanvasEl.scrollLeft, a.x, ratio);
  graphCanvasEl.scrollTop = anchoredScroll(graphCanvasEl.scrollTop, a.y, ratio);
}

/** グラフ領域右上のズームコントロール（− / 倍率 / ＋ / リセット）を組み立てる */
function buildZoomControls(): HTMLElement {
  const controls = document.createElement('div');
  controls.className = 'zoom-controls';
  controls.title = 'Ctrl/Cmd + ホイールでもズームできます';

  const out = document.createElement('button');
  out.className = 'zoom-button zoom-out';
  out.type = 'button';
  out.textContent = '−';
  out.setAttribute('aria-label', 'ズームアウト');
  out.addEventListener('click', () => setZoomLevel(zoomOut(zoomLevel)));

  const level = document.createElement('span');
  level.className = 'zoom-level';

  const zin = document.createElement('button');
  zin.className = 'zoom-button zoom-in';
  zin.type = 'button';
  zin.textContent = '＋';
  zin.setAttribute('aria-label', 'ズームイン');
  zin.addEventListener('click', () => setZoomLevel(zoomIn(zoomLevel)));

  const reset = document.createElement('button');
  reset.className = 'zoom-button zoom-reset';
  reset.type = 'button';
  reset.textContent = 'リセット';
  reset.setAttribute('aria-label', '倍率をリセット');
  reset.addEventListener('click', () => setZoomLevel(1));

  zoomUiUpdater = (): void => {
    level.textContent = formatZoom(zoomLevel);
    zin.disabled = zoomLevel >= ZOOM_MAX;
    out.disabled = zoomLevel <= ZOOM_MIN;
    reset.disabled = zoomLevel === 1;
  };
  zoomUiUpdater();

  controls.append(out, level, zin, reset);
  return controls;
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
  // GitHub はキーボードショートカット（例: 't' = ファイル検索）を document で listen
  // しており、Shadow DOM 内の textarea 等で打ったキーも composed イベントとして host を
  // 経由し document まで伝播して誤発動する。host で伝播だけ止める（preventDefault は
  // しないので、パネル内の文字入力・Tab 移動などのデフォルト動作はそのまま生きる）。
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
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
  close.title = '閉じる（Esc）';
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
    createLegendItem('chip-dep', '依存先（diff 外）'),
    createLegendItem('chip-draft', '下書きあり')
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
  graphCanvasEl = document.createElement('div');
  graphCanvasEl.className = 'graph-scroll';
  // Ctrl/Cmd + ホイールでカーソル位置を基準にズーム（トラックパッドのピンチも
  // Chrome は ctrlKey 付き wheel として通知するのでそのまま効く）。
  // 修飾キーなしのホイールは通常のスクロールとして素通しする
  graphCanvasEl.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (!graphCanvasEl) return;
      const rect = graphCanvasEl.getBoundingClientRect();
      setZoomLevel(wheelZoom(zoomLevel, e.deltaY), {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    },
    { passive: false }
  );
  graphAreaEl.append(graphCanvasEl, buildZoomControls());
  sidePaneEl = document.createElement('div');
  sidePaneEl.className = 'side-pane';
  main.append(graphAreaEl, sidePaneEl);
  renderSidePlaceholder();

  panel.append(header, toolbar, authNoticeEl, statusEl, main, buildDraftsPane());
  shadow.appendChild(panel);
  return host;
}

/** パネル下部の下書き一覧ペイン（件数バッジ / 一覧 / まとめて送信）を組み立てる */
function buildDraftsPane(): HTMLElement {
  const pane = document.createElement('div');
  pane.className = 'drafts-pane';

  const header = document.createElement('div');
  header.className = 'drafts-header';
  const title = document.createElement('span');
  title.className = 'drafts-title';
  title.textContent = '下書き';
  draftsCountEl = document.createElement('span');
  draftsCountEl.className = 'drafts-count';
  // GitHub の PR 画面で作った下書きをパネルを開いたまま反映するための再取得ボタン
  draftsRefreshEl = document.createElement('button');
  draftsRefreshEl.className = 'drafts-refresh';
  draftsRefreshEl.type = 'button';
  draftsRefreshEl.textContent = '再読み込み';
  draftsRefreshEl.title = 'GitHub から下書き（pending review）を取得し直す';
  draftsRefreshEl.addEventListener('click', () => {
    if (draftsBusy || !patConfigured || !currentPr) return;
    void loadPendingReview(currentPr);
  });
  reviewSubmitEl = document.createElement('button');
  reviewSubmitEl.className = 'review-submit';
  reviewSubmitEl.type = 'button';
  reviewSubmitEl.addEventListener('click', submitAllDrafts);
  header.append(title, draftsCountEl, draftsRefreshEl, reviewSubmitEl);

  draftsAuthEl = document.createElement('div');
  draftsAuthEl.className = 'drafts-auth';
  const authText = document.createElement('span');
  authText.textContent =
    '下書きは GitHub の pending review に保存されるため、利用には PAT が必要です。';
  const openOptions = document.createElement('button');
  openOptions.className = 'open-options';
  openOptions.type = 'button';
  openOptions.textContent = 'PAT を設定する';
  openOptions.addEventListener('click', () => {
    void sendToBackground({ type: 'OPEN_OPTIONS' });
  });
  draftsAuthEl.append(authText, openOptions);

  reviewStatusEl = document.createElement('p');
  reviewStatusEl.className = 'review-status';

  draftsListEl = document.createElement('ul');
  draftsListEl.className = 'drafts-list';

  pane.append(header, draftsAuthEl, reviewStatusEl, draftsListEl);
  renderDrafts();
  return pane;
}

/** 下書き一覧・件数バッジ・送信ボタン・グラフ上のマークを現在の drafts に同期する */
function renderDrafts(): void {
  if (!draftsListEl || !draftsCountEl || !reviewSubmitEl || !draftsAuthEl) return;
  draftsCountEl.textContent = String(drafts.length);
  draftsCountEl.dataset.empty = drafts.length === 0 ? 'true' : 'false';
  reviewSubmitEl.textContent = submitting
    ? '送信中…'
    : `${drafts.length} 件の下書きをレビューとして送信`;
  reviewSubmitEl.disabled =
    submitting ||
    draftsBusy ||
    drafts.length === 0 ||
    pendingReviewId === null ||
    !patConfigured;
  if (draftsRefreshEl) draftsRefreshEl.disabled = draftsBusy || !patConfigured;
  // 下書きは GitHub の pending review に保存するため、追加の時点から PAT が必要
  draftsAuthEl.dataset.visible = patConfigured ? 'false' : 'true';
  if (drafts.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'drafts-empty';
    empty.textContent = draftsBusy
      ? 'GitHub の pending review を確認中…'
      : '下書きはありません。コメント可（緑）のノードから「下書きに追加」すると、' +
        'GitHub の pending review として保存されます（PR 画面からも見えます）。';
    draftsListEl.replaceChildren(empty);
  } else {
    draftsListEl.replaceChildren(...drafts.map(buildDraftItem));
  }
  renderHandle?.setDraftMarks(draftNodeIds(drafts, currentGraph?.nodes ?? []));
}

/** 下書きコメントに対応するグラフノードを探す（コメント可能行に一致するもの） */
function nodeForComment(comment: PendingComment): GraphNode | undefined {
  if (comment.line === null) return undefined;
  return currentGraph?.nodes.find(
    (n) =>
      n.filePath === comment.path &&
      comment.line !== null &&
      n.commentableLines.includes(comment.line)
  );
}

/** 下書き一覧の 1 行（ノード名 / path:line / 本文プレビュー / 編集 / 削除） */
function buildDraftItem(comment: PendingComment): HTMLElement {
  const item = document.createElement('li');
  item.className = 'draft-item';

  const node = nodeForComment(comment);

  const name = document.createElement('span');
  name.className = 'draft-node-name';
  // GitHub の PR 画面で作られた下書きなど、グラフのノードに対応しないものもある
  name.textContent = node?.name ?? '（グラフ外）';

  const locText = `${comment.path}:L${comment.line ?? '?'}`;
  const loc = document.createElement('span');
  loc.className = 'draft-loc';
  loc.textContent = locText;
  loc.title = locText;

  const preview = document.createElement('span');
  preview.className = 'draft-preview';
  preview.textContent = comment.body.replace(/\s+/g, ' ');
  preview.title = comment.body;

  const edit = document.createElement('button');
  edit.className = 'draft-edit';
  edit.type = 'button';
  edit.textContent = '編集';
  if (node) {
    // 編集 = 対象ノードを選択してフォームに下書きをプリフィルする
    edit.addEventListener('click', () => selectNode(node));
  } else {
    edit.disabled = true;
    edit.title =
      'このコメントに対応するノードがグラフにありません（GitHub の PR 画面で編集できます）';
  }

  const del = document.createElement('button');
  del.className = 'draft-delete';
  del.type = 'button';
  del.textContent = '削除';
  del.disabled = draftsBusy;
  del.addEventListener('click', () => {
    if (draftsBusy || !currentPr) return;
    const message: DeletePendingCommentRequest = {
      type: 'DELETE_PENDING_COMMENT',
      pr: currentPr,
      commentId: comment.id,
    };
    draftsBusy = true;
    if (reviewStatusEl) {
      reviewStatusEl.dataset.state = 'posting';
      reviewStatusEl.textContent = '下書きを削除中…';
    }
    renderDrafts();
    void requestPendingMutation(message).then((result) => {
      draftsBusy = false;
      if (!panelHost) return;
      if (reviewStatusEl) {
        if (result.ok) {
          delete reviewStatusEl.dataset.state;
          reviewStatusEl.textContent = '';
        } else {
          reviewStatusEl.dataset.state = 'error';
          reviewStatusEl.textContent = result.message;
        }
      }
      renderDrafts();
      // 対象ノードのフォームを開いていたらボタン表示（追加/更新・削除）を追従させる
      commentUiUpdater?.();
    });
  });

  item.append(name, loc, preview, edit, del);
  return item;
}

/**
 * pending review を submit する（SUBMIT_PENDING_REVIEW = POST /reviews/{id}/events）。
 * 成功すると下書きが PR の相手に見えるレビューになる。失敗時（push で行が
 * outdated になった等の 422）は pending review が GitHub 側に残るので、
 * ユーザーは下書きを直して再送できる。
 */
function submitAllDrafts(): void {
  if (submitting || draftsBusy || drafts.length === 0 || !currentPr) return;
  if (pendingReviewId === null || !reviewStatusEl) return;
  const pr = currentPr;
  const reviewId = pendingReviewId;
  submitting = true;
  reviewStatusEl.dataset.state = 'posting';
  reviewStatusEl.textContent = `${drafts.length} 件の下書きを 1 つのレビューとして送信中…`;
  renderDrafts();
  void sendToBackground({ type: 'SUBMIT_PENDING_REVIEW', pr, reviewId })
    .then((res) => {
      submitting = false;
      if (!reviewStatusEl) return; // パネルが閉じられた
      if (res.ok) {
        pendingReviewId = null;
        drafts = [];
        reviewStatusEl.dataset.state = 'ok';
        reviewStatusEl.textContent = 'レビューを投稿しました: ';
        const link = document.createElement('a');
        link.href = res.value.htmlUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'PR で見る';
        reviewStatusEl.appendChild(link);
        // 選択中ノードのフォームのボタン表示（更新 → 追加）も戻す
        commentUiUpdater?.();
      } else {
        reviewStatusEl.dataset.state = 'error';
        reviewStatusEl.textContent = describeGithubError(res.error);
      }
      renderDrafts();
    })
    .catch((e: unknown) => {
      submitting = false;
      if (!reviewStatusEl) return;
      reviewStatusEl.dataset.state = 'error';
      reviewStatusEl.textContent = `background との通信に失敗: ${e instanceof Error ? e.message : String(e)}`;
      renderDrafts();
    });
}

/** background 応答の pending review 状態でローカル表示を丸ごと置き換える */
function applyPendingState(value: PendingReviewPayload): void {
  pendingReviewId = value.reviewId;
  drafts = value.comments;
}

/**
 * pending review への変更要求（追加・更新・削除）を送り、成功なら応答の状態に同期する。
 * 呼び出し側は draftsBusy の管理と表示更新（renderDrafts / commentUiUpdater）を行うこと。
 */
async function requestPendingMutation(
  message:
    | AddPendingCommentRequest
    | UpdatePendingCommentRequest
    | DeletePendingCommentRequest
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await sendToBackground(message);
    if (res.ok) {
      applyPendingState(res.value);
      return { ok: true };
    }
    return { ok: false, message: describeGithubError(res.error) };
  } catch (e) {
    return {
      ok: false,
      message: `background との通信に失敗: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * GitHub から現在の PR の pending review を取得して表示に反映する。
 * パネルを開いたとき・PAT が設定されたときに呼ぶ。PAT 未設定時は background が
 * 「pending review なし」を返すのでエラーにはならない。
 */
async function loadPendingReview(pr: PrRef): Promise<void> {
  draftsBusy = true;
  renderDrafts();
  try {
    const res = await sendToBackground({ type: 'GET_PENDING_REVIEW', pr });
    // 取得中にパネルが閉じられた / 別 PR に移っていたら捨てる
    if (!panelHost || currentPr !== pr) return;
    if (res.ok) {
      applyPendingState(res.value);
      if (reviewStatusEl) {
        delete reviewStatusEl.dataset.state;
        reviewStatusEl.textContent = '';
      }
    } else if (reviewStatusEl) {
      reviewStatusEl.dataset.state = 'error';
      reviewStatusEl.textContent = `下書きの取得に失敗: ${describeGithubError(res.error)}`;
    }
  } catch (e) {
    if (panelHost && currentPr === pr && reviewStatusEl) {
      reviewStatusEl.dataset.state = 'error';
      reviewStatusEl.textContent = `background との通信に失敗: ${e instanceof Error ? e.message : String(e)}`;
    }
  } finally {
    if (panelHost && currentPr === pr) {
      draftsBusy = false;
      renderDrafts();
      commentUiUpdater?.();
      // 選択中ノードのフォームがあればプリフィル状態を追従させる。
      // ただし入力中の本文があるときは作り直さない（書きかけを消さない）
      const input =
        panelHost.shadowRoot?.querySelector<HTMLTextAreaElement>('.comment-input');
      if (selectedNode && (input?.value.trim() ?? '') === '') {
        renderNodeDetail(selectedNode);
      }
    }
  }
}

function renderSidePlaceholder(): void {
  if (!sidePaneEl) return;
  commentUiUpdater = null;
  const p = document.createElement('p');
  p.className = 'side-placeholder';
  p.textContent = 'グラフのノードをクリックすると、関数の詳細をここに表示します。';
  sidePaneEl.replaceChildren(p);
}

/**
 * sourceText をハイライトトークンに沿って span に分割し code 要素へ流し込む。
 * トークン間の隙間（識別子・記号・空白）は無装飾のテキストノードで出す。
 * innerHTML は使わない（sourceText はリポジトリ由来の任意文字列）。
 */
function renderHighlightedSource(
  code: HTMLElement,
  text: string,
  tokens: HighlightToken[]
): void {
  let pos = 0;
  for (const [start, end, kind] of tokens) {
    // 範囲外・逆順のトークンは無視して残りを素のテキストで出す（描画を壊さない）
    if (start < pos || end > text.length || start >= end) continue;
    if (start > pos) code.append(text.slice(pos, start));
    const span = document.createElement('span');
    span.className = `tok-${kind}`;
    span.textContent = text.slice(start, end);
    code.appendChild(span);
    pos = end;
  }
  if (pos < text.length) code.append(text.slice(pos));
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
  renderHighlightedSource(code, node.sourceText, node.highlightTokens ?? []);
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
 * コメント可能ノード用の下書きフォームを組み立てる。
 * - 「下書きに追加」は GitHub の pending review に下書きコメントとして保存する
 *   （PR の相手にはまだ見えない。送信はパネル下部の「n 件の下書きをレビューとして送信」）。
 *   GitHub 側への保存なので、追加の時点から PAT が必要
 * - 対象行の表示（commentableLines が複数なら select で選択可能。既定は commentLine =
 *   関数範囲内の最初の追加行、なければ最初のコメント可能行）
 * - このノードの下書きが既にあれば本文・行をプリフィルし、「下書きを更新」「下書きを削除」になる。
 *   行を変えた更新は PATCH でできないため、削除 → 追加し直しで実現する
 */
function buildCommentForm(node: GraphNode): HTMLElement {
  const form = document.createElement('div');
  form.className = 'comment-form';

  const existing = findCommentForNode(drafts, node);
  const defaultLine =
    existing?.line != null && node.commentableLines.includes(existing.line)
      ? existing.line
      : (node.commentLine ?? node.commentableLines[0]);
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
  input.placeholder =
    'この関数へのレビューコメント…（Markdown 可。GitHub の pending review に下書きとして保存されます）';
  if (existing) input.value = existing.body;

  const submit = document.createElement('button');
  submit.className = 'comment-submit draft-add';
  submit.type = 'button';

  const remove = document.createElement('button');
  remove.className = 'draft-remove';
  remove.type = 'button';
  remove.textContent = '下書きを削除';

  // PAT 導線（下書きが GitHub 側に保存されるため、追加の時点から PAT が必要）
  const auth = document.createElement('div');
  auth.className = 'comment-auth';
  const authText = document.createElement('span');
  authText.textContent = '下書きの保存（pending review）には PAT が必要です。';
  const openOptions = document.createElement('button');
  openOptions.className = 'open-options';
  openOptions.type = 'button';
  openOptions.textContent = 'PAT を設定する';
  openOptions.addEventListener('click', () => {
    void sendToBackground({ type: 'OPEN_OPTIONS' });
  });
  auth.append(authText, openOptions);

  const status = document.createElement('p');
  status.className = 'comment-status';

  const update = (): void => {
    const hasDraft = findCommentForNode(drafts, node) !== undefined;
    submit.textContent = hasDraft ? '下書きを更新' : '下書きに追加';
    submit.disabled = input.value.trim() === '' || !patConfigured || draftsBusy;
    remove.hidden = !hasDraft;
    remove.disabled = draftsBusy;
    auth.dataset.visible = patConfigured ? 'false' : 'true';
  };
  input.addEventListener('input', update);

  submit.addEventListener('click', () => {
    const body = input.value.trim();
    if (body === '' || draftsBusy || !patConfigured) return;
    if (!currentPr || !currentHeadSha) return;
    const pr = currentPr;
    const commitId = currentHeadSha;
    const current = findCommentForNode(drafts, node);
    draftsBusy = true;
    status.dataset.state = 'posting';
    status.textContent = current ? '下書きを更新中…' : '下書きを追加中…';
    update();
    renderDrafts();
    void (async () => {
      let result: { ok: true } | { ok: false; message: string };
      if (current && current.line === selectedLine) {
        result = await requestPendingMutation({
          type: 'UPDATE_PENDING_COMMENT',
          pr,
          commentId: current.id,
          body,
        });
      } else {
        // 行の変更は PATCH でできないため、旧コメントを消してから追加し直す
        result = current
          ? await requestPendingMutation({
              type: 'DELETE_PENDING_COMMENT',
              pr,
              commentId: current.id,
            })
          : { ok: true };
        if (result.ok) {
          result = await requestPendingMutation({
            type: 'ADD_PENDING_COMMENT',
            pr,
            commitId,
            path: node.filePath,
            line: selectedLine,
            body,
          });
        }
      }
      draftsBusy = false;
      if (!panelHost) return;
      if (result.ok) {
        status.dataset.state = 'ok';
        status.textContent = current
          ? '下書きを更新しました（GitHub の pending review・まだ送信されていません）'
          : '下書きを追加しました（GitHub の pending review・まだ送信されていません）';
      } else {
        status.dataset.state = 'error';
        status.textContent = result.message;
      }
      renderDrafts();
      update();
    })();
  });

  remove.addEventListener('click', () => {
    const current = findCommentForNode(drafts, node);
    if (!current || draftsBusy || !currentPr) return;
    const pr = currentPr;
    draftsBusy = true;
    status.dataset.state = 'posting';
    status.textContent = '下書きを削除中…';
    update();
    renderDrafts();
    void requestPendingMutation({
      type: 'DELETE_PENDING_COMMENT',
      pr,
      commentId: current.id,
    }).then((result) => {
      draftsBusy = false;
      if (!panelHost) return;
      if (result.ok) {
        delete status.dataset.state;
        status.textContent = '下書きを削除しました';
      } else {
        status.dataset.state = 'error';
        status.textContent = result.message;
      }
      renderDrafts();
      update();
    });
  });

  commentUiUpdater = update;
  update();
  form.append(target, input, submit, remove, auth, status);
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
  if (!currentGraph || !graphCanvasEl || !nodeCountEl) return;
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
    graphCanvasEl.replaceChildren(empty);
    return;
  }
  try {
    const renderer = await getRenderer();
    const handle = await renderer.render(graphCanvasEl, filtered, {
      onNodeClick: selectNode,
    });
    // 描画中にパネルが閉じられた / 別の描画が始まっていたら反映しない
    if (token !== renderToken || !panelHost) return;
    renderHandle = handle;
    if (selectedNode) handle.setSelected(selectedNode.id);
    handle.setDraftMarks(draftNodeIds(drafts, filtered.nodes));
    // フィルタ切り替え等の再描画でも現在の倍率を維持する
    handle.setZoom(zoomLevel);
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
  // パネルを開くたびにフィルタ・選択状態・倍率は初期値に戻す
  graphFilter = { connectedOnly: true, inDiffOnly: false };
  selectedNode = null;
  currentGraph = null;
  currentHeadSha = null;
  renderHandle = null;
  zoomLevel = 1;
  pendingReviewId = null;
  drafts = [];
  draftsBusy = false;
  submitting = false;
  // 送信ボタン・下書き追加の活性条件。以後の変更は storage.onChanged が追従する
  const pr = currentPr;
  void getPat().then((pat) => {
    patConfigured = pat !== null;
    commentUiUpdater?.();
    renderDrafts();
    // 下書きは GitHub の pending review が正。パネルを開くたびに取得する
    // （PR 画面で作った下書きも拾える。PAT 未設定なら「なし」が返るだけ）
    if (panelHost && currentPr === pr) void loadPendingReview(pr);
  });
  panelHost = buildPanel();
  // トグルボタンを覆ってしまわないよう、パネルはボタンの下端から開く
  const button = document.getElementById(BUTTON_ID);
  if (button) {
    const bottom = button.getBoundingClientRect().bottom;
    panelHost.style.setProperty('--functions-tree-panel-top', `${Math.round(bottom) + 8}px`);
  }
  document.body.appendChild(panelHost);
  document.addEventListener('keydown', handleEscapeKeydown, true);
  void loadGraph(currentPr);
}

function closePanel(): void {
  document.removeEventListener('keydown', handleEscapeKeydown, true);
  panelHost?.remove();
  panelHost = null;
  statusEl = null;
  authNoticeEl = null;
  graphAreaEl = null;
  graphCanvasEl = null;
  sidePaneEl = null;
  nodeCountEl = null;
  draftsListEl = null;
  draftsCountEl = null;
  draftsRefreshEl = null;
  reviewSubmitEl = null;
  reviewStatusEl = null;
  draftsAuthEl = null;
  currentGraph = null;
  currentHeadSha = null;
  selectedNode = null;
  renderHandle = null;
  zoomLevel = 1;
  zoomUiUpdater = null;
  commentUiUpdater = null;
  // 下書きは GitHub の pending review に保存済み。次に開いたとき取得し直す
  pendingReviewId = null;
  drafts = [];
  draftsBusy = false;
  submitting = false;
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
  anchorObserver?.disconnect();
  anchorObserver = null;
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
