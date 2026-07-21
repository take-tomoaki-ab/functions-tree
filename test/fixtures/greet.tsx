// テスト用フィクスチャ: TSX（tree-sitter-tsx.wasm でパースされる）+ default export。

import { toUpper } from './util';

export default function Greeting(name: string) {
  const label = toUpper(name);
  return <div title={label}>{label}</div>;
}
