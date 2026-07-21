# functions-tree

GitHub の PR ページ上で、関数の依存関係グラフを mermaid で表示する Chrome 拡張機能（Manifest V3）。

- 関数の依存関係抽出は tree-sitter（WASM）による静的解析で行う
- ノードクリックで関数の中身の表示・レビューコメントの入力（GitHub のインラインコメントに同期）

## 開発

```sh
npm ci --include=dev   # NODE_ENV=production な環境でも devDependencies を入れる
npm run build          # typecheck + バンドル + manifest / wasm コピー → dist/
```

`dist/` を `chrome://extensions` の「パッケージ化されていない拡張機能を読み込む」で読み込む。

### ユニットテスト

tree-sitter の解析コア（`src/background/analyzer-core.ts`）は GitHub API に依存しないため、
`test/fixtures/` の小さな TS プロジェクトに対して Node 上で検証する（レート制限を消費しない）:

```sh
npm test               # esbuild でコアをバンドル → node --test
```

### 自動動作確認 (E2E)

branded Chrome 137+ は `--load-extension` を無視するため、Playwright の Chromium
（open-source ビルド）に拡張をロードして実 PR ページで確認する:

```sh
npx playwright install chromium
npm run e2e -- --repo honojs/hono --pr 5140
# 実 PR ページでボタン注入 / コールグラフのサマリ + 関数一覧表示 / SW キャッシュ /
# options の PAT 保存・削除 / SPA 遷移を確認
```

E2E は未認証レート制限（60 req/h、IP 単位）を消費する。`--pr` で TypeScript ファイルを
含む小さめの PR を指定するとリクエスト数を抑えられる（未指定なら PR 一覧の先頭を使う）。

## 設定 (PAT)

拡張の options ページ（`chrome://extensions` → 詳細 → 拡張機能のオプション、
またはパネル内「PAT を設定する」）で GitHub Personal Access Token を設定できる。

- 未設定でも公開リポジトリなら動く（未認証モード。レート制限 60 req/h）
- PAT は `chrome.storage.local` にのみ保存。fine-grained PAT なら
  `Contents` / `Pull requests` の Read 権限で十分

## 構成

```
manifest.json            # MV3。CSP に wasm-unsafe-eval（tree-sitter WASM に必須）
src/
├── content/             # content script（github.com/* に注入、PR ページ判定はコード側）
│   ├── index.ts         # エントリポイント
│   ├── detector.ts      # PR ページ検出（turbo / popstate / ポーリングで SPA 遷移に追従）
│   └── panel.ts         # トグルボタン注入 + Shadow DOM パネル（グラフサマリ + 関数一覧の暫定表示）
├── background/
│   ├── sw.ts            # service worker（メッセージハンドラ）
│   ├── github-api.ts    # GitHub REST API クライアント（pulls / files / contents、型付きエラー）
│   ├── analyzer-core.ts # tree-sitter によるコールグラフ抽出（環境非依存。テストはこれを直接検証）
│   └── analyzer.ts      # SW 統合: GitHub API 配線 + headSha キーのメモリキャッシュ
├── options/             # PAT の設定ページ（保存・削除・接続テスト）
└── shared/
    ├── messages.ts      # content / options ⇔ background のメッセージ型定義
    ├── github.ts        # GitHub API の共有型 + エラーの日本語化
    ├── graph.ts         # コールグラフの共有型（ノード / エッジ / スキップ情報）
    └── settings.ts      # PAT の chrome.storage.local 読み書き
test/                    # analyzer-core のユニットテスト + fixtures/（小さな TS プロジェクト）
scripts/e2e.mjs          # Playwright Chromium での自動動作確認
wasm/ (dist 内)          # web-tree-sitter + tree-sitter-{typescript,tsx} の wasm（ビルド時にコピー）
```

## コールグラフ解析（Phase 3 時点）

- 対象: PR の変更ファイルのうち `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs`（`.tsx` / `.jsx` は tsx 文法）
- 抽出: 関数宣言 / アロー関数・関数式（変数代入）/ クラスメソッドと、本体内の呼び出し・import
- 解決: 同一ファイル / 相対 import（named・alias・namespace・default）/ `this.method()` / 自己再帰
- 依存は深さ 1 まで contents API で取得（`DEFAULT_DEPENDENCY_DEPTH`）。外部パッケージはノード化しない
- 解析結果は SW メモリに `owner/repo#pr@headSha` キーでキャッシュ（レート制限保護）
