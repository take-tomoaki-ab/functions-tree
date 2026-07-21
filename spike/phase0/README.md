# Phase 0 spike: tree-sitter WASM × Chrome 拡張 MV3

tree-sitter（web-tree-sitter + tree-sitter-typescript の WASM）が
Manifest V3 の background service worker / offscreen document 上で動くかの検証コード。

**結論: MV3 service worker 上でそのまま動く**（CSP に `'wasm-unsafe-eval'` が必須）。
詳細は toride memory の `phase0_result.md` を参照。

## 構成

```
spike/phase0/
├── src/
│   ├── analyzer.js      # tree-sitter query による関数/呼び出し/import 抽出（コンテキスト非依存）
│   ├── sample-code.js   # パース対象のサンプル TypeScript
│   ├── run-spike.js     # SW / offscreen 共通のテスト実行
│   ├── sw.js            # background service worker（SW → offscreen の順に実行して結果集約）
│   └── offscreen.js     # offscreen document 側
├── ext/                 # ビルド済み拡張（このディレクトリを Chrome に読み込む）
│   ├── manifest.json
│   ├── sw.js / offscreen.js   # esbuild バンドル（生成物）
│   ├── wasm/                  # web-tree-sitter.wasm + tree-sitter-typescript.wasm（コピー）
│   └── result.html / result.js # 結果表示ページ（chrome.storage から読む）
├── manifests/           # CSP あり/なしの manifest（'wasm-unsafe-eval' 必須のエビデンス用）
├── results/             # 実測エビデンス JSON
├── node-test.mjs        # Node でのサニティチェック
└── test-runner.mjs      # Playwright Chromium で拡張を実際にロードして結果回収
```

## 実行方法

```bash
# NODE_ENV=production な環境では --include=dev が必要（playwright が devDependency のため）
npm install --include=dev

# 1. Node サニティチェック
npm run node-test

# 2. 拡張のビルド（wasm コピー + esbuild バンドル）
npm run build

# 3. 実ブラウザ検証（Playwright の Chromium、new headless。拡張対応のため channel: 'chromium'）
node test-runner.mjs /tmp/phase0-profile
```

CSP なし（失敗エビデンス）を再現する場合は
`cp manifests/manifest.no-csp.json ext/manifest.json` してから 3 を実行する。

## 注意

- Chrome 137+ の branded Chrome は `--load-extension` を無視するため、
  自動検証は Playwright の Chromium（open-source ビルド、実測 145.0.7632.6）で行っている。
  拡張ランタイムは branded Chrome と同一実装。
- web-tree-sitter 0.26 系はランタイム wasm のファイル名が `web-tree-sitter.wasm`
  （旧 `tree-sitter.wasm` から変更）。`Parser.init({ locateFile })` で URL を渡す。
