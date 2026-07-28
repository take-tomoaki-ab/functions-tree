// テスト用フィクスチャ: default export のコンポーネント（`<Layout>...</Layout>` で参照される）。

export default function Layout({ children }: { children?: unknown }) {
  return <main>{children}</main>;
}
