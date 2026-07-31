// テスト用フィクスチャ（issue #27 A）: 値として import される子コンポーネント。
// 型と値を同じ source から import されるケース（値側があるので取得対象に残る）も兼ねる。
export type Variant = 'a' | 'b';

export function Badge({ label }: { label: string }) {
  return <span className="badge">{label}</span>;
}
