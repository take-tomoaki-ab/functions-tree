// テスト用フィクスチャ（issue #27 A）: many/parent.tsx と同じ構成で import 順だけ逆。
// 連結結果が import の並び順に左右されないことの回帰テストに使う。

import { C6 } from './c6';
import { C5 } from './c5';
import { C4 } from './c4';
import { C3 } from './c3';
import { C2 } from './c2';
import { C1 } from './c1';

export function ParentReversed() {
  return (
    <div>
      <C6 />
      <C5 />
      <C4 />
      <C3 />
      <C2 />
      <C1 />
    </div>
  );
}
