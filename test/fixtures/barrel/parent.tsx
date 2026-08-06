// テスト用フィクスチャ: barrel（re-export だけの index.ts）経由の import（issue #28 D）。
// Card は名前付き re-export、Badge は `export * from` 経由、Chip は多段 barrel 経由。

import { Card, Badge, Chip } from './components';

export function Parent() {
  return (
    <div>
      <Card />
      <Badge />
      <Chip />
    </div>
  );
}
