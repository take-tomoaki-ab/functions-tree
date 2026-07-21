// 対応言語の登録簿。新しい言語への対応はここに定義を 1 つ足す
// （+ package.json の copy-wasm と analyzer.ts の grammars に wasm を 1 行ずつ）。

import type { LanguageDefinition } from './types';
import { goLanguage } from './go';
import { pythonLanguage } from './python';
import { typescriptLanguage } from './typescript';

export const LANGUAGE_DEFINITIONS: LanguageDefinition[] = [
  typescriptLanguage,
  goLanguage,
  pythonLanguage,
];

const byExtension = new Map<string, LanguageDefinition>();
for (const def of LANGUAGE_DEFINITIONS) {
  for (const ext of def.extensions) byExtension.set(ext, def);
}

/** パスの拡張子から言語定義を引く。未対応の拡張子は undefined */
export function languageForPath(path: string): LanguageDefinition | undefined {
  const m = /\.[^./]+$/.exec(path);
  return m ? byExtension.get(m[0]) : undefined;
}
