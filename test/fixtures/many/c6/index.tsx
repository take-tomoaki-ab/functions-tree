// テスト用フィクスチャ（issue #27）: ディレクトリ import の解決先。
// c5 だけ index.jsx にして、index の .jsx 候補漏れ（#24 ×-6）の回帰も兼ねる。
export function C6() {
  return <div className="c6" />;
}
