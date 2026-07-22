# functions-tree

GitHub の PR ページ上で、関数の依存関係グラフを表示する Chrome 拡張機能（Manifest V3）。

PR の diff はファイル単位の変更しか見せてくれず、変更された関数がどこから呼ばれ、どこを呼んでいるのかは追いにくい。
functions-tree は変更ファイルとその依存先を tree-sitter（WASM）で静的解析し、関数を頂点、呼び出しを辺とするコールグラフを PR ページ上に描画する。
ノードをクリックすると関数本体をその場で読め、レビューコメントの下書きを書き溜めて、1 つのレビューとしてまとめて投稿できる。

解析は LLM を使わない決定的な静的解析で、すべてブラウザ内で完結する。
外部と通信するのは GitHub REST API だけで、コードの取得とレビュー投稿にのみ使う。

## 主な機能

- **コールグラフ表示**：mermaid（flowchart）で描画。コメント可否で 3 区分に色分けする（コメント可 = 緑、変更ファイル内だが関数は無変更 = 黄、diff 外の依存先 = グレー破線）。「エッジのあるノードのみ」「変更ファイル内のみ」のフィルタつき
- **関数詳細**：ノードクリックでサイドペインに関数名、パスと行範囲、ソース全文を表示
- **レビューコメントの一括投稿**：ノードごとにコメントを「下書きに追加」してキューに溜め、「n 件の下書きをまとめて送信」で 1 つのレビュー（インラインコメント群）として投稿する。下書きは PR 単位で保持され、パネルの開き直しやページリロードでも消えない
- **多言語対応**：TypeScript / JavaScript、Go、Python

| 言語 | 拡張子 | 解決できる呼び出し |
|---|---|---|
| TypeScript / JavaScript | .ts .tsx .js .jsx .mjs .cjs | 同一ファイル、相対 import（named / alias / namespace / default）、`this.method()` |
| Go | .go | 同一パッケージ（ディレクトリ内の兄弟ファイルを自動展開）、go.mod の module パス基準のパッケージ import |
| Python | .py | 同一ファイル、相対 import と絶対 import（src レイアウト推定つき、標準ライブラリは除外）、`self.method()` |

## インストール

ストア配布はしていないため、手元でビルドして読み込む。

```sh
npm ci --include=dev
npm run build
```

`chrome://extensions` で「デベロッパー モード」を有効にし、「パッケージ化されていない拡張機能を読み込む」で `dist/` を選択する。

## 使い方

1. GitHub の PR ページを開くと、ヘッダー付近に「関数依存グラフ」ボタンが注入される
2. ボタンを押すとパネルが開き、変更ファイルと深さ 1 の依存先を解析してグラフを描画する
3. 緑のノードをクリックし、コメントを書いて「下書きに追加」する（この時点では投稿されない）
4. 複数のノードやファイルに下書きを追加したら、「n 件の下書きをまとめて送信」で 1 つのレビューとして投稿する

## PAT の設定

拡張の options ページ（`chrome://extensions` → 詳細 → 拡張機能のオプション、またはパネル内の「PAT を設定する」）で GitHub Personal Access Token を設定する。

- 未設定でも公開リポジトリの閲覧は動く（未認証モード。レート制限 60 req/h、レビュー投稿は不可）
- 閲覧だけなら fine-grained PAT の `Contents` と `Pull requests` の Read で足りる。レビューを投稿するには `Pull requests` の Read and write（classic PAT なら `repo` スコープ、公開リポジトリのみなら `public_repo`）が必要
- PAT は `chrome.storage.local` にのみ保存され、GitHub API 以外には送られない

## 制限事項

- コメントできるのは diff に含まれる行だけ（GitHub API の仕様）。グラフ上では色分けで区別され、コメント不可のノードには理由が表示される
- コメントは単一行のみで、下書きは 1 ノードにつき 1 件
- 依存を辿る深さは 1 に固定している（API リクエスト数と描画量を抑えるため）
- 下書きの寿命はブラウザセッション（`chrome.storage.session`）。ブラウザを終了すると消える
- 解析後に PR へ push があると、投稿時に 422 で失敗することがある（下書きは消えない。パネルを開き直すと新しいコミットで再解析される）
- 外部パッケージの呼び出しや動的な呼び出しはグラフに含めない（未解決件数として集計のみ）

## 仕組み

content script は表示専任で、GitHub API の呼び出しと tree-sitter による解析はすべて background service worker が担う。
UI は Shadow DOM に隔離し、GitHub 側の CSS やキーボードショートカットと干渉しない。

1. PR ページでパネルを開くと、background が `GET /pulls/{n}/files` で変更ファイル一覧を取得する
2. 変更ファイルと、相対 import 等で辿れる深さ 1 の依存ファイルを `GET /contents` で取得し、tree-sitter でパースして関数、呼び出し、import を抽出する
3. 呼び出しを import 情報と突き合わせてコールグラフ（JSON）を組み立て、`owner/repo#pr@headSha` キーで service worker のメモリにキャッシュする
4. あわせて各ファイルの patch から「コメント可能な行集合」を作り、関数の行範囲と突き合わせて行レベルのコメント可否を判定する
5. content script がグラフを mermaid 記法に変換して描画する
6. レビュー投稿は `POST /pulls/{n}/reviews` に全下書きを載せ、1 回の API 呼び出しで行う

言語ごとの処理（抽出クエリ、import 解決、呼び出し解決）は `src/background/languages/` の `LanguageDefinition` にカプセル化してある。
言語の追加は、定義を 1 つ書いて登録簿に足し、文法 wasm をビルドに含めるだけでよい。

## 開発者向け

### ビルド

```sh
npm ci --include=dev   # NODE_ENV=production な環境でも devDependencies を入れる
npm run build          # typecheck + esbuild バンドル + manifest / wasm コピー → dist/
```

mermaid（約 3.3MB）は `dist/mermaid-view.js` に分離し、初回描画時に動的 import する（content script 本体は約 23KB）。
manifest の CSP には tree-sitter WASM の実行に必須の `wasm-unsafe-eval` を指定している。

### ユニットテスト

解析コア（`analyzer-core.ts` と `languages/`）、diff 行マッピング（`diff-lines.ts`）、mermaid 記法変換（`mermaid-source.ts`）、下書きキュー（`review-drafts.ts`）は GitHub API に依存しない純粋ロジックとして分離してあり、`test/fixtures*/` の小さなプロジェクトに対して Node 上で検証する（レート制限を消費しない）。

```sh
npm test               # esbuild でコアをバンドル → node --test
```

### 自動動作確認（E2E）

branded Chrome 137+ は `--load-extension` を無視するため、Playwright の Chromium（open-source ビルド）に拡張をロードして実 PR ページで確認する。

```sh
npx playwright install chromium
npm run e2e -- --repo honojs/hono --pr 5140
```

ボタン注入、グラフ描画と色分け、ノードクリック、フィルタ、options の PAT 保存と削除、SPA 遷移への追従、下書きキューの操作と復元、まとめて送信のエラー経路までを自動確認する。
実 PR へのレビュー投稿は行わない（無効 PAT での 401 経路までを確認する）。

E2E は未認証レート制限（60 req/h、IP 単位）を消費する。
`--repo gorilla/mux --pr 760`（Go、約 15 リクエスト）や `--repo pallets/flask --pr 6013`（Python、約 45 リクエスト）のように、対応言語のファイルを含む小さめの PR を指定するとよい。

### ディレクトリ構成

```
manifest.json            # MV3。CSP に wasm-unsafe-eval
src/
├── content/             # content script（github.com/* に注入、PR ページ判定はコード側）
│   ├── index.ts         # エントリポイント
│   ├── detector.ts      # PR ページ検出（turbo / popstate / ポーリングで SPA 遷移に追従）
│   ├── panel.ts         # トグルボタン注入 + Shadow DOM パネル（グラフ + 詳細サイドペイン）
│   ├── mermaid-source.ts# グラフ JSON → mermaid 記法変換 + 表示フィルタ（純粋ロジック）
│   └── mermaid-view.ts  # GraphRenderer インターフェース + mermaid 実装（別バンドルで遅延ロード）
├── background/
│   ├── sw.ts            # service worker（メッセージハンドラ）
│   ├── github-api.ts    # GitHub REST API クライアント
│   ├── analyzer-core.ts # コールグラフ組み立ての言語非依存コア
│   ├── languages/       # 言語定義（typescript / go / python。追加は index.ts の登録簿へ）
│   ├── diff-lines.ts    # patch → コメント可能行集合の純粋ロジック
│   └── analyzer.ts      # SW 統合（GitHub API 配線 + headSha キーのメモリキャッシュ）
├── options/             # PAT の設定ページ + 対応言語の一覧表示
└── shared/              # メッセージ型、グラフ型、下書きキュー、設定などの共有コード
test/                    # 上記純粋ロジックのテスト + fixtures*/（TS / Go / Python の小プロジェクト）
scripts/e2e.mjs          # Playwright Chromium での自動動作確認
```
