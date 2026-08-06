// テスト用フィクスチャ: memo / forwardRef / HOC でラップされた子（issue #28 E）。

import { Card } from './card';
import { Input } from './input';
import Panel from './panel';

export function Parent() {
  return (
    <div>
      <Card />
      <Input />
      <Panel />
    </div>
  );
}
