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
npm run e2e            # 実 PR ページでボタン注入 / パネル開閉 / PING-PONG / SPA 遷移を確認
```

## 構成

```
manifest.json          # MV3。wasm-unsafe-eval CSP（Phase 3 の tree-sitter に必須）
src/
├── content/           # content script（github.com/* に注入、PR ページ判定はコード側）
│   ├── index.ts       # エントリポイント
│   ├── detector.ts    # PR ページ検出（turbo / popstate / ポーリングで SPA 遷移に追従）
│   └── panel.ts       # トグルボタン注入 + Shadow DOM パネル
├── background/
│   └── sw.ts          # service worker（メッセージハンドラの骨組み）
└── shared/
    └── messages.ts    # content ⇔ background のメッセージ型定義
scripts/e2e.mjs        # Playwright Chromium での自動動作確認
```
