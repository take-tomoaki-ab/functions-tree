// TypeScript / JavaScript の言語定義（Phase 3 の analyzer-core から移植）。
// .tsx / .jsx は tsx 文法、それ以外は typescript 文法でパースする。

import type { Node } from 'web-tree-sitter';
import { languageMetadata } from '../../shared/languages';
import type { HighlightConfig } from '../highlight';
import type {
  DependencyTarget,
  FileAnalysis,
  ImportBinding,
  LanguageDefinition,
  LanguageQueries,
  ResolveContext,
  ResolvedCall,
} from './types';
import { collectCalls, normalizePath } from './types';

const metadata = languageMetadata('typescript');

// クエリ文字列は TS / TSX 文法で共通（Query オブジェクトは文法ごとに生成される）
const FUNCTIONS_QUERY = `
(function_declaration name: (identifier) @name) @func
(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)]) @func
(method_definition name: (property_identifier) @name) @func
`;

const IMPORTS_QUERY = `
(import_statement source: (string (string_fragment) @source)) @import
`;

const HIGHLIGHT: HighlightConfig = {
  wholeNodeTypes: {
    comment: 'comment',
    regex: 'string',
    // `string` / `number` 等の anonymous キーワードを含むため全体を type で塗る
    predefined_type: 'type',
  },
  leafTypes: {
    // 引用符と内容が別トークンなので、どちらも string で塗る
    // （template_string は substitution を素通しするため whole にしない）
    string_fragment: 'string',
    escape_sequence: 'string',
    '"': 'string',
    "'": 'string',
    '`': 'string',
    number: 'number',
    type_identifier: 'type',
    this: 'keyword',
    super: 'keyword',
    true: 'constant',
    false: 'constant',
    null: 'constant',
    undefined: 'constant',
  },
  functionDefTypes: [
    'function_declaration',
    'generator_function_declaration',
    'method_definition',
  ],
  calls: [
    { type: 'call_expression', field: 'function' },
    { type: 'new_expression', field: 'constructor' },
  ],
  member: { type: 'member_expression', field: 'property' },
};

function isFunctionBoundary(node: Node): boolean {
  if (node.type === 'function_declaration' || node.type === 'method_definition') {
    return true;
  }
  if (node.type === 'variable_declarator') {
    const value = node.childForFieldName('value');
    return (
      !!value &&
      (value.type === 'arrow_function' || value.type === 'function_expression')
    );
  }
  return false;
}

/**
 * 直接の export 判定: `export function foo` / `export const foo = ...` /
 * `export default function foo`。
 * `export { foo }` / `export default foo`（識別子参照）は別途 collectExportClauses で拾う。
 */
function directExportName(funcNode: Node, name: string): string | undefined {
  if (funcNode.type === 'method_definition') return undefined;
  const wrapper =
    funcNode.type === 'variable_declarator' ? funcNode.parent : funcNode;
  const parent = wrapper?.parent;
  if (parent?.type !== 'export_statement') return undefined;
  const isDefault = parent.children.some((c) => c?.type === 'default');
  return isDefault ? 'default' : name;
}

/** `export { foo, bar as baz }` と `export default foo` の { ローカル名 → 公開名 } を集める */
function collectExportClauses(rootNode: Node): Map<string, string> {
  const map = new Map<string, string>();
  for (const child of rootNode.namedChildren) {
    if (!child || child.type !== 'export_statement') continue;
    // re-export（`export { x } from './y'`）は自ファイルの関数ではないので対象外
    if (child.childForFieldName('source')) continue;
    const value = child.childForFieldName('value');
    if (value?.type === 'identifier') {
      map.set(value.text, 'default'); // export default foo
      continue;
    }
    for (const c of child.namedChildren) {
      if (!c || c.type !== 'export_clause') continue;
      for (const spec of c.namedChildren) {
        if (!spec || spec.type !== 'export_specifier') continue;
        const local = spec.childForFieldName('name');
        const alias = spec.childForFieldName('alias');
        if (local) map.set(local.text, (alias ?? local).text);
      }
    }
  }
  return map;
}

/** import_clause から { ローカル名 → import 先の名前 } の束縛を集める */
function collectImportBindings(importNode: Node, source: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const child of importNode.namedChildren) {
    if (!child || child.type !== 'import_clause') continue;
    for (const c of child.namedChildren) {
      if (!c) continue;
      if (c.type === 'identifier') {
        bindings.push({ local: c.text, source, imported: 'default' });
      } else if (c.type === 'namespace_import') {
        const id = c.namedChildren.find((n) => n?.type === 'identifier');
        if (id) bindings.push({ local: id.text, source, imported: '*' });
      } else if (c.type === 'named_imports') {
        for (const spec of c.namedChildren) {
          if (!spec || spec.type !== 'import_specifier') continue;
          const name = spec.childForFieldName('name');
          const alias = spec.childForFieldName('alias');
          if (name) {
            bindings.push({
              local: (alias ?? name).text,
              source,
              imported: name.text,
            });
          }
        }
      }
    }
  }
  return bindings;
}

/** './x' / '../y' 形式か（node_modules 等の外部パッケージはノード化しない） */
function isRelativeSpec(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

function hasTsExtension(path: string): boolean {
  return metadata.extensions.some((ext) => path.endsWith(ext));
}

/**
 * 相対 import の解決候補パスを優先順で返す。
 * - 拡張子なし → .ts / .tsx / .js / ... と index ファイルを試す
 * - `./x.js` 形式（NodeNext スタイル）→ 実体が x.ts のことが多いので .ts / .tsx も試す
 */
export function resolveImportCandidates(fromPath: string, spec: string): string[] {
  if (!isRelativeSpec(spec)) return [];
  const dir = fromPath.split('/').slice(0, -1);
  const base = normalizePath([...dir, ...spec.split('/')]);
  if (base === null || base === '') return [];

  if (hasTsExtension(base)) {
    const candidates = [];
    if (/\.js$/.test(base)) {
      candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
    } else if (/\.jsx$/.test(base)) {
      candidates.push(base.replace(/\.jsx$/, '.tsx'));
    }
    candidates.push(base);
    return candidates;
  }
  return [
    ...metadata.extensions.map((ext) => `${base}${ext}`),
    ...['.ts', '.tsx', '.js'].map((ext) => `${base}/index${ext}`),
  ];
}

export const typescriptLanguage: LanguageDefinition = {
  ...metadata,
  grammarKeys: ['typescript', 'tsx'],
  grammarKeyFor: (path) =>
    path.endsWith('.tsx') || path.endsWith('.jsx') ? 'tsx' : 'typescript',
  functionsQuery: FUNCTIONS_QUERY,
  importsQuery: IMPORTS_QUERY,
  highlight: HIGHLIGHT,
  isFunctionBoundary,

  analyze(path: string, rootNode: Node, queries: LanguageQueries): FileAnalysis {
    const exportClauses = collectExportClauses(rootNode);

    const functions = queries.functions.matches(rootNode).map((m) => {
      const funcNode = m.captures.find((c) => c.name === 'func')!.node;
      const nameNode = m.captures.find((c) => c.name === 'name')!.node;
      const name = nameNode.text;
      // `const foo = () => {}` は variable_declarator 単体ではなく宣言文全体を表示範囲にする
      const rangeNode =
        funcNode.type === 'variable_declarator' && funcNode.parent
          ? funcNode.parent
          : funcNode;
      // 呼び出しの帰属は関数本体（variable_declarator なら value の関数）から集める
      const bodyRoot =
        funcNode.type === 'variable_declarator'
          ? (funcNode.childForFieldName('value') ?? funcNode)
          : funcNode;
      return {
        name,
        kind: funcNode.type,
        isMethod: funcNode.type === 'method_definition',
        startLine: rangeNode.startPosition.row + 1,
        endLine: rangeNode.endPosition.row + 1,
        startIndex: rangeNode.startIndex,
        endIndex: rangeNode.endIndex,
        exportName: directExportName(funcNode, name) ?? exportClauses.get(name),
        sourceText: rangeNode.text,
        calls: collectCalls(bodyRoot, ['call_expression'], isFunctionBoundary),
      };
    });

    const imports = queries.imports.matches(rootNode).flatMap((m) => {
      const importNode = m.captures.find((c) => c.name === 'import')!.node;
      const sourceNode = m.captures.find((c) => c.name === 'source')!.node;
      return collectImportBindings(importNode, sourceNode.text);
    });

    return { path, language: metadata.id, functions, imports };
  },

  dependencyTargets(analysis: FileAnalysis): DependencyTarget[] {
    const specs = new Set(
      analysis.imports.filter((b) => isRelativeSpec(b.source)).map((b) => b.source)
    );
    return [...specs]
      .map((spec) => ({
        kind: 'file' as const,
        candidates: resolveImportCandidates(analysis.path, spec),
      }))
      .filter((t) => t.candidates.length > 0);
  },

  resolveCall(
    analysis: FileAnalysis,
    callee: string,
    ctx: ResolveContext
  ): ResolvedCall | null {
    // import 束縛 → 依存ファイルの export（候補のうち最初に解析済みのファイルで判定）
    const resolveImported = (
      binding: ImportBinding,
      exportName: string
    ): ResolvedCall | null => {
      for (const candidate of resolveImportCandidates(analysis.path, binding.source)) {
        const tables = ctx.file(candidate);
        if (!tables) continue;
        const fn = tables.exports.get(exportName);
        return fn ? { path: candidate, fn } : null;
      }
      return null;
    };

    if (!callee.includes('.')) {
      // 1. 同一ファイルのトップレベル関数
      const local = ctx.file(analysis.path)?.topLevel.get(callee);
      if (local) return { path: analysis.path, fn: local };
      // 2. import 束縛 → 依存ファイルの export
      const binding = analysis.imports.find((b) => b.local === callee);
      if (binding && binding.imported !== '*') {
        return resolveImported(binding, binding.imported);
      }
      return null;
    }
    const parts = callee.split('.');
    if (parts.length === 2) {
      const [head, member] = parts;
      // this.method() → 同一ファイル内のメソッド（同名複数は最初の定義）
      if (head === 'this') {
        const methods = ctx.file(analysis.path)?.methods.get(member);
        return methods?.length ? { path: analysis.path, fn: methods[0] } : null;
      }
      // ns.func() → namespace import 先の export
      const binding = analysis.imports.find(
        (b) => b.local === head && b.imported === '*'
      );
      if (binding) return resolveImported(binding, member);
    }
    return null;
  },
};
