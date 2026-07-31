// テスト用フィクスチャ（issue #27 A）: 型だけを提供するモジュール。
// `import type` 経由でしか参照されないので、依存ファイルとして取得されないのが期待動作。
export interface Props {
  label: string;
}
