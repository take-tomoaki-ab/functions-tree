// テスト用フィクスチャ: .jsx も tsx 文法でパースされる（拡張子違いの回帰確認用）。

import { Card } from './card';

export function Legacy() {
  return <Card title="legacy" />;
}
