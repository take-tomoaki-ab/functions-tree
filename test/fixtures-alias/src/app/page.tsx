// テスト用フィクスチャ: tsconfig paths エイリアス経由の import（issue #28 G）。
import { Card } from '@/components/Card';
import { Badge } from '~components/Badge';
import { external } from 'some-package';

export function Page() {
  return (
    <main>
      <Card />
      <Badge />
      {external}
    </main>
  );
}
