// テスト用フィクスチャ（issue #27 C）: ネストした同名 const が import を shadow する構成。
// helper の中のローカル Card は別物なので、Parent の <Card /> は import 先へ繋がるべき。

import { Card } from './card';

function helper() {
  const Card = () => <em />;
  return <Card />;
}

export function Parent() {
  return (
    <div>
      {helper()}
      <Card />
    </div>
  );
}
