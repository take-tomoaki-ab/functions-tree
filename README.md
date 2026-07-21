# functions-tree

GitHub の PR ページ上で、関数の依存関係グラフを mermaid で表示する Chrome 拡張機能（Manifest V3）。

- 関数の依存関係抽出は tree-sitter（WASM）による静的解析で行う
- ノードクリックで関数の中身の表示・レビューコメントの入力（GitHub のインラインコメントに同期）
