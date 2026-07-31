// テスト用フィクスチャ（issue #27 A）: 拡張子なしのディレクトリ import を 6 件持つ親。
// 1 件あたり最大 10 個の候補パスを 404 プローブしていた頃は fetch 予算が
// 途中で尽き、末尾の子だけ連結されないという import 順依存の不安定さがあった。

import { C1 } from './c1';
import { C2 } from './c2';
import { C3 } from './c3';
import { C4 } from './c4';
import { C5 } from './c5';
import { C6 } from './c6';

export function Parent() {
  return (
    <div>
      <C1 />
      <C2 />
      <C3 />
      <C4 />
      <C5 />
      <C6 />
    </div>
  );
}
