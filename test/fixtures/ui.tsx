// テスト用フィクスチャ: namespace import（import * as UI）経由で `<UI.Panel />` と
// 参照されるコンポーネント。

export function Panel({ children }: { children?: unknown }) {
  return <div className="panel">{children}</div>;
}
