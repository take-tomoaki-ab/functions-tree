// テスト用フィクスチャ（issue #27 A）: 型だけの import が依存取得の予算を食わないこと。
// `import type` 文と、インラインの `{ type X }` specifier の両方を含む。

import type { Props } from './props';
import { type Variant, Badge } from './badge';

export function Parent(p: Props, v: Variant) {
  return <Badge label={p.label} />;
}
