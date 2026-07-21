# functions-tree

GitHub の PR ページ上で、関数の依存関係グラフを mermaid で表示する Chrome 拡張機能（Manifest V3）。

- 関数の依存関係抽出は tree-sitter（WASM）による静的解析で行う
- ノードクリックで関数の中身の表示・レビューコメントの入力（GitHub のインラインコメントに同期）

## 開発

```sh
npm ci --include=dev   # NODE_ENV=production な環境でも devDependencies を入れる
npm run build          # typecheck + バンドル + manifest コピー → dist/
```

`dist/` を `chrome://extensions` の「パッケージ化されていない拡張機能を読み込む」で読み込む。

### 自動動作確認 (E2E)

branded Chrome 137+ は `--load-extension` を無視するため、Playwright の Chromium
（open-source ビルド）に拡張をロードして実 PR ページで確認する:

```sh
npx playwright install chromium
npm run e2e            # 実 PR ページでボタン注入 / パネルのファイル一覧表示 / options の PAT 保存・削除 / SPA 遷移を確認
```

## 設定 (PAT)

拡張の options ページ（`chrome://extensions` → 詳細 → 拡張機能のオプション、
またはパネル内「PAT を設定する」）で GitHub Personal Access Token を設定できる。

- 未設定でも公開リポジトリなら動く（未認証モード。レート制限 60 req/h）
- PAT は `chrome.storage.local` にのみ保存。fine-grained PAT なら
  `Contents` / `Pull requests` の Read 権限で十分

## 構成

```
manifest.json          # MV3。storage permission + api.github.com host_permissions + options_ui
src/
├── content/           # content script（github.com/* に注入、PR ページ判定はコード側）
│   ├── index.ts       # エントリポイント
│   ├── detector.ts    # PR ページ検出（turbo / popstate / ポーリングで SPA 遷移に追従）
│   └── panel.ts       # トグルボタン注入 + Shadow DOM パネル（変更ファイル一覧の暫定表示）
├── background/
│   ├── sw.ts          # service worker（メッセージハンドラ）
│   └── github-api.ts  # GitHub REST API クライアント（pulls / files / contents、型付きエラー）
├── options/           # PAT の設定ページ（保存・削除・接続テスト）
└── shared/
    ├── messages.ts    # content / options ⇔ background のメッセージ型定義
    ├── github.ts      # GitHub API の共有型 + エラーの日本語化
    └── settings.ts    # PAT の chrome.storage.local 読み書き
scripts/e2e.mjs        # Playwright Chromium での自動動作確認
```
