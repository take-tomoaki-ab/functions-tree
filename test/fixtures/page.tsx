// テスト用フィクスチャ: PR の変更ファイル想定（JSX でのコンポーネント呼び出し）。
// default import / named import / namespace import のメンバー形式、自己閉じタグと
// 開始・終了タグのペア、無名コールバック内の JSX、組み込み要素と Fragment を含む。

import Layout from './layout';
import { Card, CardTitle } from './card';
import * as UI from './ui';
import { toUpper } from './util';

export function Page({ items }: { items: string[] }) {
  return (
    <Layout>
      <UI.Panel />
      <Card title={toUpper('top')}>
        <CardTitle text="hi" />
      </Card>
      {items.map((i) => (
        <Card key={i} title={i} />
      ))}
      <div className="footer">
        <>{null}</>
      </div>
    </Layout>
  );
}
