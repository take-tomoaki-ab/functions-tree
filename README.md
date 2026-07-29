# functions-tree

GitHub の PR ページ上で、関数の依存関係グラフを表示する Chrome 拡張機能（Manifest V3）。

PR の diff はファイル単位の変更しか見せてくれず、変更された関数がどこから呼ばれ、どこを呼んでいるのかは追いにくい。
functions-tree は変更ファイルとその依存先を tree-sitter（WASM）で静的解析し、関数を頂点、呼び出しを辺とするコールグラフを PR ページ上に描画する。
ノードをクリックすると関数本体をその場で読め、レビューコメントの下書きを GitHub の pending review として書き溜めて、1 つのレビューとしてまとめて投稿できる。

解析は LLM を使わない決定的な静的解析で、すべてブラウザ内で完結する。
外部と通信するのは GitHub API（REST と、pending review の取得・操作に限り GraphQL）だけで、コードの取得と下書き・レビュー投稿にのみ使う。

## 主な機能

- **コールグラフ表示**：mermaid（flowchart）で描画。コメント可否で 3 区分に色分けする（コメント可・変更あり = 緑、コメント可・差分なし（hunk の文脈行内） = 黄、コメント不可・diff 外 = グレー破線）。「エッジのあるノードのみ」「変更ファイル内のみ」のフィルタつき
- **関数詳細**：ノードクリックでサイドペインに関数名、パスと行範囲、ソースを git diff 風の行単位ビューで表示する（行番号ガター、+/- マーカー、追加行は緑・削除行は赤の背景、関数名の横に `+n -m` の変更行数バッジ）。ソースは解析に使った tree-sitter の構文木からシンタックスハイライトされる（ハイライトライブラリは不使用）
- **識別子の選択**：コード内の変数名・関数名をクリックすると選択され、同じ識別子が使われている箇所すべてがハイライトされる。もう一度クリック（または識別子以外をクリック）で解除。選択はノードを切り替えても保たれる
- **レビューコメントの一括投稿**：ノードごとにコメントを「下書きに追加」すると GitHub ネイティブの pending review に下書きとして保存され、「n 件の下書きをレビューとして送信」で 1 つのレビュー（インラインコメント群）として投稿する。下書きは GitHub 側に保存されるため、PR 画面（Files changed の pending コメント）からも確認・編集でき、ブラウザを閉じても消えない。PR 画面で作った下書きもパネルの一覧に表示される
- **解析結果のキャッシュ**：`owner/repo#pr@headSha` 単位で `chrome.storage.session` に永続化され、MV3 の service worker が再起動してもキャッシュヒットする。パネルヘッダーの「再解析」ボタンでキャッシュを無視して強制的に再計算できる
- **リサイズ可能なレイアウト**：グラフ領域とサイドペインの間のスプリッターをドラッグして幅を調整できる。幅は `chrome.storage.local` に保存され、パネルを開き直しても復元される
- **多言語対応**：TypeScript / JavaScript、Go、Python

| 言語 | 拡張子 | 解決できる呼び出し |
|---|---|---|
| TypeScript / JavaScript | .ts .tsx .js .jsx .mjs .cjs | 同一ファイル、相対 import（named / alias / namespace / default）、`this.method()`、JSX の関数コンポーネント呼び出し（`<Component />` / `<UI.Panel />`。小文字始まりの組み込み要素は除外、閉じタグは二重計上しない） |
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
3. 緑のノードをクリックし、コメントを書いて「下書きに追加」する（GitHub の pending review に下書きとして保存される。この時点では相手に見えない）
4. 複数のノードやファイルに下書きを追加したら、「n 件の下書きをレビューとして送信」で 1 つのレビューとして投稿する（GitHub の PR 画面から pending review を submit してもよい）

## PAT の設定

拡張の options ページ（`chrome://extensions` → 詳細 → 拡張機能のオプション、またはパネル内の「PAT を設定する」）で GitHub Personal Access Token を設定する。

- 未設定でも公開リポジトリの閲覧は動く（未認証モード。レート制限 60 req/h、下書きの追加・レビュー投稿は不可）
- 閲覧だけなら fine-grained PAT の `Contents` と `Pull requests` の Read で足りる。下書き（pending review）を作ってレビューを投稿するには `Pull requests` の Read and write（classic PAT なら `repo` スコープ、公開リポジトリのみなら `public_repo`）が必要
- PAT は `chrome.storage.local` にのみ保存され、GitHub API 以外には送られない

## 制限事項

- コメントできるのは diff に含まれる行だけ（GitHub API の仕様）。グラフ上では色分けで区別され、コメント不可のノードには理由が表示される
- コメントは単一行のみで、パネルから編集できる下書きは 1 ノードにつき 1 件
- 下書きの追加・編集・削除・送信には PAT が必要（GitHub の pending review として保存されるため）
- 依存を辿る深さは 1 に固定している（API リクエスト数と描画量を抑えるため）
- 解析後に PR へ push があると、下書きの追加や送信が 422 で失敗することがある（作成済みの下書きは pending review として残る。パネルを開き直すと新しいコミットで再解析される）
- 外部パッケージの呼び出しや動的な呼び出しはグラフに含めない（未解決件数として集計のみ）

## 仕組み

content script は表示専任で、GitHub API の呼び出しと tree-sitter による解析はすべて background service worker が担う。
UI は Shadow DOM に隔離し、GitHub 側の CSS やキーボードショートカットと干渉しない。

1. PR ページでパネルを開くと、background が `GET /pulls/{n}/files` で変更ファイル一覧を取得する
2. 変更ファイルと、相対 import 等で辿れる深さ 1 の依存ファイルを `GET /contents` で取得し、tree-sitter でパースして関数、呼び出し、import を抽出する
3. 呼び出しを import 情報と突き合わせてコールグラフ（JSON）を組み立て、`owner/repo#pr@headSha` キーで `chrome.storage.session` にキャッシュする（SW の再起動・サスペンドをまたいでも有効。パネルの「再解析」ボタンでキャッシュを無視して強制再計算できる）
4. あわせて各ファイルの patch から「コメント可能な行集合」を作り、関数の行範囲と突き合わせて行レベルのコメント可否を判定する
5. content script がグラフを mermaid 記法に変換して描画する
6. 下書きは GitHub ネイティブの pending review に統合されている。「下書きに追加」は pending review が無ければ `POST /pulls/{n}/reviews`（`event` なし = PENDING）で作成し、あれば GraphQL の `addPullRequestReviewThread` で追記する。pending 状態のコメントは REST API からは見えない（一覧が空になり PATCH / DELETE も効かない）ため、取得は GraphQL の `reviews(states: PENDING)`、編集・削除・投稿も GraphQL（`updatePullRequestReviewComment` / `deletePullRequestReviewComment` / `submitPullRequestReview`）で行う

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

解析コア（`analyzer-core.ts` と `languages/`）、diff 行マッピング（`diff-lines.ts`）、解析結果キャッシュの判定（`graph-cache.ts`）、mermaid 記法変換（`mermaid-source.ts`）、ズーム倍率計算（`zoom.ts`）、ソースの diff 行分解（`source-diff.ts`）、pending review まわりのロジック（`review-drafts.ts`）は GitHub API や `chrome.storage` に依存しない純粋ロジックとして分離してあり、`test/fixtures*/` の小さなプロジェクトに対して Node 上で検証する（レート制限を消費しない）。

```sh
npm test               # esbuild でコアをバンドル → node --test
```

`src/content/*.ts` や `src/background/*.ts` に `chrome.storage` 等に依存しない純粋ロジックを新しく切り出したときは、`package.json` の `pretest` に esbuild でのバンドル行を追記すること（`chrome.storage` を直接使う非純粋モジュールは対象外）。

### 自動動作確認（E2E）

branded Chrome 137+ は `--load-extension` を無視するため、Playwright の Chromium（open-source ビルド）に拡張をロードして実 PR ページで確認する。

`npm run e2e` は `dist/` を自動リビルドしない（`pree2e` は無い）ため、ソースを変更した後は必ず `npm run build` を先に実行すること。

```sh
npx playwright install chromium
npm run build
npm run e2e -- --repo honojs/hono --pr 5140
```

`--pr` は明示的に指定すること。未指定だと PR 一覧の先頭を使うため、対応言語のファイルを含まない PR だとノード 0 件で無関係な失敗をする（`--repo` 省略時のデフォルトは `microsoft/TypeScript`）。

ボタン注入、グラフ描画と色分け、ノードクリック、フィルタ、options の PAT 保存と削除、SPA 遷移への追従、下書き（pending review）まわりの PAT 必須ガードとエラー経路までを自動確認する。
実 PR への下書き作成・レビュー投稿は行わない（無効 PAT での 401 経路までを確認する）。

E2E は未認証レート制限（60 req/h、IP 単位）を消費する。用途別の推奨 PR:

- `--repo honojs/hono --pr 4200`（追加行・削除行・文脈行が揃う）
- `--repo honojs/hono --pr 5140`（新規関数のみ）
- `--repo excalidraw/excalidraw --pr 11681`（tsx・JSX の関数コンポーネント依存の確認）
- `--repo gorilla/mux --pr 760`（Go、約 15 リクエスト）
- `--repo pallets/flask --pr 6013`（Python、約 45 リクエスト）

### ディレクトリ構成

```
manifest.json            # MV3。CSP に wasm-unsafe-eval
src/
├── content/             # content script（github.com/* に注入、PR ページ判定はコード側）
│   ├── index.ts         # エントリポイント
│   ├── detector.ts      # PR ページ検出（turbo / popstate / ポーリングで SPA 遷移に追従）
│   ├── panel.ts         # トグルボタン注入 + Shadow DOM パネル（グラフ + 詳細サイドペイン + リサイズ可能なスプリッター）
│   ├── mermaid-source.ts# グラフ JSON → mermaid 記法変換 + 表示フィルタ（純粋ロジック）
│   ├── mermaid-view.ts  # GraphRenderer インターフェース + mermaid 実装（別バンドルで遅延ロード）
│   ├── source-diff.ts   # ソース全文 → git diff 風の行単位ビュー（純粋ロジック）
│   ├── source-segments.ts# ソース 1 行 → 描画単位（ハイライト種別 + 識別子）へ分割（純粋ロジック）
│   └── zoom.ts          # mermaid グラフのズーム倍率計算（純粋ロジック）
├── background/
│   ├── sw.ts            # service worker（メッセージハンドラ）
│   ├── github-api.ts    # GitHub REST API クライアント
│   ├── analyzer-core.ts # コールグラフ組み立ての言語非依存コア
│   ├── languages/       # 言語定義（typescript / go / python。追加は index.ts の登録簿へ）
│   ├── diff-lines.ts    # patch → コメント可能行集合の純粋ロジック
│   ├── graph-cache.ts   # キャッシュヒット判定（headSha 一致 / forceRefresh）の純粋ロジック
│   └── analyzer.ts      # SW 統合（GitHub API 配線 + headSha キーの chrome.storage.session キャッシュ）
├── options/             # PAT の設定ページ + 対応言語の一覧表示
└── shared/              # メッセージ型、グラフ型、pending review ロジック、設定、サイドペイン幅などの共有コード
test/                    # 上記純粋ロジックのテスト + fixtures*/（TS / Go / Python の小プロジェクト）
scripts/e2e.mjs          # Playwright Chromium での自動動作確認
```
