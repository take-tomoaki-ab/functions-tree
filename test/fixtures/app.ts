// テスト用フィクスチャ: PR の変更ファイル想定。
// default import（NodeNext 形式 ./greet.js → 実体 greet.tsx）、named import（alias 込み）、
// namespace import と、各種の呼び出し解決パターンを含む。

import greet from './greet.js';
import { toUpper, helperFn as shorten } from './util';
import * as logger from './logger';

export function main(): void {
  const message = toUpper('hello');
  shorten(message);
  logger.write(message);
  greet(message);
  render();
  missingFn(); // どこにも定義がない → 未解決
  console.log(message); // namespace import でない member 呼び出し → 未解決
}

function render(): void {
  // 無名コールバック内の呼び出しは外側の関数（render）に帰属する
  const items = [1, 2, 3].map((n) => toUpper(String(n)));
  logger.write(items.join(','));
  logger.write('twice'); // 同一関数への 2 回目の呼び出し → エッジは 1 本に畳まれる
}
