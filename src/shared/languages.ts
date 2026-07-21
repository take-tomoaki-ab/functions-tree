// 対応言語のメタデータ。options ページの一覧表示と、background の言語定義
// （src/background/languages/）の両方から参照する。web-tree-sitter には依存しない。

export interface LanguageMetadata {
  /** 言語 id（LanguageDefinition.id と一致させる） */
  id: string;
  /** options ページ等での表示名 */
  displayName: string;
  /** この言語として解析する拡張子（ドット付き） */
  extensions: string[];
}

export const LANGUAGE_METADATA: LanguageMetadata[] = [
  {
    id: 'typescript',
    displayName: 'TypeScript / JavaScript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  },
  {
    id: 'go',
    displayName: 'Go',
    extensions: ['.go'],
  },
  {
    id: 'python',
    displayName: 'Python',
    extensions: ['.py'],
  },
];

export function languageMetadata(id: string): LanguageMetadata {
  const found = LANGUAGE_METADATA.find((m) => m.id === id);
  if (!found) throw new Error(`未登録の言語 id です: ${id}`);
  return found;
}
