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

tree-sitter の解析コア（`src/background/analyzer-core.ts` + `languages/`）と
diff 行マッピング（`src/background/diff-lines.ts`）は GitHub API に依存しないため、
`test/fixtures/`（TS）・`test/fixtures-go/`（Go）・`test/fixtures-py/`（Python）の
小さなプロジェクトや patch 文字列に対して Node 上で検証する（レート制限を消費しない）:

```sh
npm test               # esbuild でコアをバンドル → node --test
```

### 自動動作確認 (E2E)

branded Chrome 137+ は `--load-extension` を無視するため、Playwright の Chromium
（open-source ビルド）に拡張をロードして実 PR ページで確認する:

```sh
npx playwright install chromium
npm run e2e -- --repo honojs/hono --pr 5140
# 実 PR ページでボタン注入 / mermaid グラフ描画（色分け・凡例）/ ノードクリック → 詳細 /
# フィルタトグル / SW キャッシュ / options の PAT 保存・削除 / SPA 遷移 /
# コメント UI（未認証で無効 + PAT 導線、pat_required、無効 PAT での 401 表示）を確認
# ※ 実 PR へのコメント投稿は行わない（無効 PAT の 401 経路までを自動確認する）
```

E2E は未認証レート制限（60 req/h、IP 単位）を消費する。`--pr` で対応言語のファイルを
含む小さめの PR を指定するとリクエスト数を抑えられる（未指定なら PR 一覧の先頭を使う）。
Go / Python の例: `--repo gorilla/mux --pr 760`（Go、約 15 リクエスト）/
`--repo pallets/flask --pr 6013`（Python、依存 fetch 上限まで使い約 45 リクエスト）。

## 設定 (PAT)

拡張の options ページ（`chrome://extensions` → 詳細 → 拡張機能のオプション、
またはパネル内「PAT を設定する」）で GitHub Personal Access Token を設定できる。

- 未設定でも公開リポジトリなら動く（未認証モード。レート制限 60 req/h、コメント投稿は不可）
- PAT は `chrome.storage.local` にのみ保存
- 権限: 閲覧だけなら fine-grained PAT の `Contents` / `Pull requests` Read で十分。
  レビューコメントを投稿するには `Pull requests` の **Read and write**
  （classic PAT なら `repo` スコープ、公開リポジトリのみなら `public_repo`）が必要

## 構成

```
manifest.json            # MV3。CSP に wasm-unsafe-eval（tree-sitter WASM に必須）
src/
├── content/             # content script（github.com/* に注入、PR ページ判定はコード側）
│   ├── index.ts         # エントリポイント
│   ├── detector.ts      # PR ページ検出（turbo / popstate / ポーリングで SPA 遷移に追従）
│   ├── panel.ts         # トグルボタン注入 + Shadow DOM パネル（グラフ + 詳細サイドペインの 2 ペイン）
│   ├── mermaid-source.ts# グラフ JSON → mermaid 記法変換 + 表示フィルタ（純粋ロジック、テスト対象）
│   └── mermaid-view.ts  # GraphRenderer インターフェース + mermaid 実装（別バンドルで遅延ロード）
├── background/
│   ├── sw.ts            # service worker（メッセージハンドラ）
│   ├── github-api.ts    # GitHub REST API クライアント（pulls / files / contents / ディレクトリ一覧 / コメント投稿）
│   ├── analyzer-core.ts # コールグラフ組み立ての言語非依存コア（環境非依存。テストはこれを直接検証）
│   ├── languages/       # 言語定義（抽出クエリ・import 解決・呼び出し解決を言語ごとにカプセル化）
│   │   ├── types.ts     # LanguageDefinition インターフェース + 共通ヘルパ
│   │   ├── typescript.ts / go.ts / python.ts
│   │   └── index.ts     # 登録簿（言語追加はここに 1 つ足す）
│   ├── diff-lines.ts    # patch → コメント可能行集合（RIGHT サイド）の純粋ロジック（テスト対象）
│   └── analyzer.ts      # SW 統合: GitHub API 配線 + headSha キーのメモリキャッシュ
├── options/             # PAT の設定ページ（保存・削除・接続テスト）+ 対応言語の一覧表示
└── shared/
    ├── messages.ts      # content / options ⇔ background のメッセージ型定義
    ├── github.ts        # GitHub API の共有型 + エラーの日本語化
    ├── graph.ts         # コールグラフの共有型（ノード / エッジ / スキップ情報）
    ├── languages.ts     # 対応言語のメタデータ（id / 表示名 / 拡張子）
    └── settings.ts      # PAT の chrome.storage.local 読み書き
test/                    # analyzer-core（TS/Go/Python）/ diff-lines / mermaid-source のテスト + fixtures*/
scripts/e2e.mjs          # Playwright Chromium での自動動作確認
wasm/ (dist 内)          # web-tree-sitter + tree-sitter-{typescript,tsx,go,python} の wasm（ビルド時にコピー）
```

## コールグラフ解析（Phase 3 時点、Phase 6 で多言語化）

- 抽出: 関数宣言 / アロー関数・関数式（変数代入）/ クラスメソッドと、本体内の呼び出し・import
- 解決: 同一ファイル / 相対 import（named・alias・namespace・default）/ `this.method()` / 自己再帰
- 依存は深さ 1 まで contents API で取得（`DEFAULT_DEPENDENCY_DEPTH`）。外部パッケージはノード化しない
- 解析結果は SW メモリに `owner/repo#pr@headSha` キーでキャッシュ（レート制限保護）

## 多言語対応（Phase 6 時点）

言語ごとの処理は `src/background/languages/` の `LanguageDefinition` にカプセル化されており、
言語追加は「定義を 1 つ書いて登録簿に足す + wasm を copy-wasm / analyzer.ts に足す」だけでよい。

| 言語 | 拡張子 | 抽出 | import / 呼び出し解決 |
|---|---|---|---|
| TypeScript / JavaScript | .ts .tsx .js .jsx .mjs .cjs | 関数宣言 / アロー / メソッド | 相対 import（named / alias / namespace / default）、`this.method()` |
| Go | .go | 関数 / メソッド（表示名 `Receiver.Method`） | 同一パッケージ（= ディレクトリ。兄弟ファイルを自動展開）、go.mod の module パス基準のパッケージ import、`x.Method()` はパッケージ内で一意なときのみ |
| Python | .py | 関数 / ネスト関数 / メソッド（表示名 `Class.method`、デコレータ含む範囲） | 相対 import（`.` / `..`）、絶対 import（リポジトリルート + src レイアウト推定、標準ライブラリは除外）、`self.method()` |

- Go の「ディレクトリ = パッケージ」解決のため、contents API のディレクトリ一覧
  （`listDirectory`）を使う。go.mod がリポジトリルートにない場合（モノレポ等）は
  パッケージ間解決を諦め、同一パッケージ内のみ解決する
- 行レベルのコメント可否判定・投稿 UI は言語非依存（patch と行範囲しか見ない）

## グラフ表示（Phase 4 時点）

- パネルはグラフ表示エリア + サイドペイン（関数詳細）の 2 ペイン。右下ハンドルでリサイズ可能
- mermaid（flowchart LR）で描画。行レベルのコメント可否で 3 区分に色分け（凡例つき）:
  コメント可 = 緑・実線 / 変更ファイル内だが関数無変更 = 黄 / diff 外の依存先 = グレー・破線
- フィルタトグル: 「エッジのあるノードのみ」（デフォルト ON。孤立ノードを隠す）/「変更ファイル内のみ」
- ノードクリックでサイドペインに関数名 / パス:行範囲 / ソース全文 / コメント欄を表示
- mermaid（約 3.3MB）は `dist/mermaid-view.js` に分離し、初回描画時に動的 import
  （content.js 本体は約 23KB のまま）。レンダラーは `GraphRenderer` インターフェースで
  差し替え可能（将来の Cytoscape.js 移行口）

## レビューコメント投稿（Phase 5 時点）

- `GET /pulls/{n}/files` の patch をパースし、**RIGHT サイド（head）でコメント可能な
  行番号集合**（追加行 + 文脈行）を作成（`diff-lines.ts`）。関数の行範囲と突き合わせて
  各ノードに `commentableLines` / `commentLine`（推奨行 = 範囲内の最初の追加行、
  なければ最初の文脈行）を載せる
- コメント可能ノードは対象行を表示（複数候補があれば select で選択可）し、
  `POST /repos/{owner}/{repo}/pulls/{n}/comments`（`commit_id` = 解析に使った headSha、
  `side: 'RIGHT'`）で通常のインラインコメントとして投稿。成功時は `html_url` へのリンクを表示
- 投稿不可の理由を UI に明示: diff 外 / 変更ファイル内だが関数無変更 / PAT 未設定
  （ボタン無効 + 「PAT を設定する」導線。PAT を保存すると `storage.onChanged` で自動活性化）
- PAT 未設定時は background 側でも `pat_required` の型付きエラーで拒否（二重防御）
