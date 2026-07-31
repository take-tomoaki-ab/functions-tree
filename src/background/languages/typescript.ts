// TypeScript / JavaScript の言語定義（Phase 3 の analyzer-core から移植）。
// .tsx / .jsx は tsx 文法、それ以外は typescript 文法でパースする。

import type { Node } from 'web-tree-sitter';
import { languageMetadata } from '../../shared/languages';
import type { HighlightConfig } from '../highlight';
import type {
  CallNodePattern,
  DependencyTarget,
  FetchFileResult,
  FileAnalysis,
  FunctionInfo,
  ImportBinding,
  LanguageDefinition,
  LanguageQueries,
  ReExport,
  ResolveContext,
  ResolvedCall,
} from './types';
import { collectCalls, normalizePath } from './types';

const metadata = languageMetadata('typescript');

// クエリ文字列は TS / TSX 文法で共通（Query オブジェクトは文法ごとに生成される）
//
// call_expression 値の variable_declarator は `const Card = memo(() => …)` のような
// HOC ラップを拾うため（issue #28 E）。関数を包んでいない呼び出し（`const x = f()`）は
// analyze() 側で落とす。class_declaration は class コンポーネント用（issue #28 F）。
const FUNCTIONS_QUERY = `
(function_declaration name: (identifier) @name) @func
(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression) (call_expression)]) @func
(method_definition name: (property_identifier) @name) @func
(class_declaration name: (type_identifier) @name) @func
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

/**
 * JSX の要素名が「関数コンポーネントへの参照」か（issue #12）。
 * JSX の規約どおり、小文字始まりの単純名は組み込み要素（`<div>` → 文字列タグ）、
 * それ以外（`<Card>` / `<UI.Panel>`）はスコープ内の値の参照として扱う。
 * `<svg:path>` のような XML 名前空間タグも組み込み扱いで対象外。
 */
function isComponentReference(name: string): boolean {
  if (name.includes(':')) return false;
  if (name.includes('.')) return true;
  return !/^[a-z]/.test(name);
}

/**
 * 呼び出しとして拾うノード。JSX 要素も関数コンポーネントの呼び出しなので依存に含める。
 * jsx_closing_element は開始タグと同じ名前を持つため、二重計上しないよう対象にしない。
 */
const CALL_NODES: readonly CallNodePattern[] = [
  'call_expression',
  { type: 'jsx_opening_element', field: 'name', accepts: isComponentReference },
  { type: 'jsx_self_closing_element', field: 'name', accepts: isComponentReference },
];

/**
 * `memo(fn)` / `forwardRef(fn)` / `memo(forwardRef(fn))` のように関数式を包む呼び出しなら、
 * 包まれている関数式のノードを返す（issue #28 E）。
 * 引数を再帰的に見るのは直下の call_expression だけ（オブジェクトリテラルの中の
 * コールバックまで拾うと `createConfig({ onClick: () => {} })` が関数定義になってしまう）。
 */
function wrappedFunction(call: Node): Node | null {
  for (const arg of call.childForFieldName('arguments')?.namedChildren ?? []) {
    if (!arg) continue;
    if (arg.type === 'arrow_function' || arg.type === 'function_expression') return arg;
    if (arg.type === 'call_expression') {
      const inner = wrappedFunction(arg);
      if (inner) return inner;
    }
  }
  return null;
}

/** `memo(Card)` / `withRouter(memo(Card))` のように識別子を包む呼び出しの、その識別子名 */
function wrappedIdentifier(call: Node): string | undefined {
  for (const arg of call.childForFieldName('arguments')?.namedChildren ?? []) {
    if (!arg) continue;
    if (arg.type === 'identifier') return arg.text;
    if (arg.type === 'call_expression') {
      const inner = wrappedIdentifier(arg);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** 関数定義として扱う variable_declarator なら、その本体（関数式）を返す */
function declaratorBody(node: Node): Node | null {
  const value = node.childForFieldName('value');
  if (!value) return null;
  if (value.type === 'arrow_function' || value.type === 'function_expression') {
    return value;
  }
  if (value.type !== 'call_expression') return null;
  // `const Card = memo(() => …)` のような HOC ラップ（issue #28 E）。
  // 構文上は `const items = xs.map((n) => …)` と区別できないので、
  // コンポーネント規約どおり PascalCase の名前に限って関数定義として扱う
  // （`const CONFIG = list.map(…)` のような定数を拾わないよう小文字も必須にする）。
  const name = node.childForFieldName('name')?.text;
  if (!name || !/^[A-Z]/.test(name) || !/[a-z]/.test(name)) return null;
  return wrappedFunction(value);
}

function isFunctionBoundary(node: Node): boolean {
  if (
    node.type === 'function_declaration' ||
    node.type === 'method_definition' ||
    // class 自体がノードなので、内側の呼び出しは外の関数に帰属させない（issue #28 F）
    node.type === 'class_declaration'
  ) {
    return true;
  }
  if (node.type === 'variable_declarator') return declaratorBody(node) !== null;
  return false;
}

/**
 * class ノードの呼び出し収集用の境界（issue #28 F）。
 * `render()` の中身は class（＝コンポーネント）そのものに帰属させたいので境界にしない。
 * 他のメソッドは従来どおり独立したノードなので境界のまま。
 */
function isClassBodyBoundary(node: Node): boolean {
  if (node.type === 'method_definition' && methodName(node) === 'render') return false;
  return isFunctionBoundary(node);
}

function methodName(node: Node): string | undefined {
  return node.childForFieldName('name')?.text;
}

/**
 * 名前付き class の `render()` か。class ノードに畳むので独立したノードにはしない
 * （そうしないと `render` ノードと class ノードから二重にエッジが張られる）。
 */
function isFoldedRenderMethod(node: Node): boolean {
  if (node.type !== 'method_definition' || methodName(node) !== 'render') return false;
  const cls = node.parent?.parent;
  return cls?.type === 'class_declaration' && !!cls.childForFieldName('name');
}

/**
 * その関数定義がファイルのトップレベルにあるか（issue #27）。
 * `function foo` / `const foo = () => {}` が `program` 直下（`export` 付きを含む）なら
 * トップレベル。ブロックや他の関数の内側にあるものはネスト定義として扱う。
 */
function isTopLevelDefinition(funcNode: Node): boolean {
  // const foo = ... は variable_declarator → (lexical|variable)_declaration が宣言文
  const statement =
    funcNode.type === 'variable_declarator' ? funcNode.parent : funcNode;
  if (!statement) return false;
  const parent = statement.parent;
  if (!parent) return false;
  return (
    parent.type === 'program' ||
    (parent.type === 'export_statement' && parent.parent?.type === 'program')
  );
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

/** import / export の source 文字列（引用符を外す） */
function specText(sourceNode: Node): string {
  return sourceNode.text.replace(/^['"`]|['"`]$/g, '');
}

/**
 * export 文をまとめて読む。
 * - clauses: `export { foo, bar as baz }` / `export default foo` の { ローカル名 → 公開名 }
 * - reExports: `export { x } from './y'` / `export * from './y'` の他ファイルへの転送（issue #28 D）
 */
function collectExports(rootNode: Node): {
  clauses: Map<string, string>;
  reExports: ReExport[];
} {
  const clauses = new Map<string, string>();
  const reExports: ReExport[] = [];
  for (const child of rootNode.namedChildren) {
    if (!child || child.type !== 'export_statement') continue;
    const sourceNode = child.childForFieldName('source');
    if (sourceNode) {
      collectReExports(child, specText(sourceNode), reExports);
      continue;
    }
    const value = child.childForFieldName('value');
    if (value?.type === 'identifier') {
      clauses.set(value.text, 'default'); // export default foo
      continue;
    }
    if (value?.type === 'call_expression') {
      // export default memo(Card) / withRouter(Card)（issue #28 E）
      const wrapped = wrappedIdentifier(value);
      if (wrapped) clauses.set(wrapped, 'default');
      continue;
    }
    for (const c of child.namedChildren) {
      if (!c || c.type !== 'export_clause') continue;
      for (const spec of c.namedChildren) {
        if (!spec || spec.type !== 'export_specifier') continue;
        const local = spec.childForFieldName('name');
        const alias = spec.childForFieldName('alias');
        if (local) clauses.set(local.text, (alias ?? local).text);
      }
    }
  }
  return { clauses, reExports };
}

/** source 付き export 文 1 つ分の転送を集める */
function collectReExports(node: Node, source: string, out: ReExport[]): void {
  const statementTypeOnly = hasTypeKeyword(node);
  const clause = node.namedChildren.find((c) => c?.type === 'export_clause');
  if (clause) {
    for (const spec of clause.namedChildren) {
      if (!spec || spec.type !== 'export_specifier') continue;
      const name = spec.childForFieldName('name');
      const alias = spec.childForFieldName('alias');
      if (!name) continue;
      out.push({
        exported: (alias ?? name).text,
        imported: name.text,
        source,
        typeOnly: statementTypeOnly || hasTypeKeyword(spec),
      });
    }
    return;
  }
  // `export * as NS from './y'` は名前空間オブジェクトを作るだけなので転送とは扱わない
  if (node.namedChildren.some((c) => c?.type === 'namespace_export')) return;
  out.push({ exported: '*', imported: '*', source, typeOnly: statementTypeOnly });
}

/** `import type ...` / `import { type X }` の `type` トークンを持つか */
function hasTypeKeyword(node: Node): boolean {
  return node.children.some((c) => c?.type === 'type');
}

/** import_clause から { ローカル名 → import 先の名前 } の束縛を集める */
function collectImportBindings(importNode: Node, source: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  // `import type { Props } from './types'` は値を持ち込まないので束縛全体が型だけ
  const statementTypeOnly = hasTypeKeyword(importNode);
  for (const child of importNode.namedChildren) {
    if (!child || child.type !== 'import_clause') continue;
    for (const c of child.namedChildren) {
      if (!c) continue;
      if (c.type === 'identifier') {
        bindings.push({
          local: c.text,
          source,
          imported: 'default',
          typeOnly: statementTypeOnly,
        });
      } else if (c.type === 'namespace_import') {
        const id = c.namedChildren.find((n) => n?.type === 'identifier');
        if (id) {
          bindings.push({
            local: id.text,
            source,
            imported: '*',
            typeOnly: statementTypeOnly,
          });
        }
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
              // `import { type A, B }` は specifier ごとに型かどうかが変わる
              typeOnly: statementTypeOnly || hasTypeKeyword(spec),
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
 * 拡張子なし import の解決候補の拡張子（issue #27）。
 * JSX を持つコンポーネントが依存の大半なので .tsx を .ts より先に試す。
 * listDir が使える環境ではこの順序は「複数実在したときにどれを採るか」だけに効くが、
 * ディレクトリ一覧が取れない環境では 404 プローブの回数に直結する。
 */
const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];

/** ディレクトリ import（`./card` → `card/index.*`）の index 候補（.jsx 対応 = issue #24 ×-6） */
const INDEX_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

/**
 * tsconfig.json の `compilerOptions.paths` 1 件（issue #28 G）。
 * `"@/*": ["./src/*"]` なら prefix = '@/'、suffix = ''、targets = ['src/*']。
 */
interface PathAlias {
  prefix: string;
  suffix: string;
  /** パターンに `*` があるか（`"jquery": [...]` のような完全一致指定は false） */
  wildcard: boolean;
  /** baseUrl 解決済みのリポジトリ相対パス（`*` を含みうる） */
  targets: string[];
}

interface TsState {
  aliases: PathAlias[];
}

/** JSONC（コメント・末尾カンマ入り JSON）を読む。tsconfig.json はこの形式 */
function parseJsonc(text: string): unknown {
  const stripped = text
    // 文字列リテラルは丸ごと残し、コメントだけ落とす
    .replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) =>
      m.startsWith('"') ? m : ''
    )
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    return null;
  }
}

function parsePathAliases(config: unknown): PathAlias[] {
  const opts = (config as { compilerOptions?: Record<string, unknown> } | null)
    ?.compilerOptions;
  if (!opts) return [];
  const baseUrl = typeof opts.baseUrl === 'string' ? opts.baseUrl : '';
  const paths = opts.paths;
  if (typeof paths !== 'object' || paths === null) return [];
  const aliases: PathAlias[] = [];
  for (const [pattern, value] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const star = pattern.indexOf('*');
    const targets: string[] = [];
    for (const t of value) {
      if (typeof t !== 'string') continue;
      // targets は baseUrl 起点。tsconfig はリポジトリルート前提で取得している
      const resolved = normalizePath([...baseUrl.split('/'), ...t.split('/')]);
      if (resolved !== null && resolved !== '') targets.push(resolved);
    }
    if (targets.length === 0) continue;
    aliases.push(
      star < 0
        ? { prefix: pattern, suffix: '', wildcard: false, targets }
        : {
            prefix: pattern.slice(0, star),
            suffix: pattern.slice(star + 1),
            wildcard: true,
            targets,
          }
    );
  }
  // より具体的な（プレフィックスの長い）パターンを先に評価する
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** エイリアス spec（`@/components/Card`）をリポジトリ相対のベースパスに写す */
function aliasBases(spec: string, state: unknown): string[] {
  const aliases = (state as TsState | undefined)?.aliases ?? [];
  for (const alias of aliases) {
    if (!alias.wildcard) {
      if (spec === alias.prefix) return alias.targets;
      continue;
    }
    if (
      !spec.startsWith(alias.prefix) ||
      !spec.endsWith(alias.suffix) ||
      spec.length < alias.prefix.length + alias.suffix.length
    ) {
      continue;
    }
    const star = spec.slice(alias.prefix.length, spec.length - alias.suffix.length);
    return alias.targets
      .map((t) => normalizePath(t.replace('*', star).split('/')))
      .filter((p): p is string => p !== null && p !== '');
  }
  return [];
}

/** ベースパス 1 つ分の候補（拡張子・index ファイルの補完） */
function candidatesForBase(base: string): string[] {
  if (hasTsExtension(base)) {
    const candidates: string[] = [];
    if (/\.js$/.test(base)) {
      candidates.push(base.replace(/\.js$/, '.tsx'), base.replace(/\.js$/, '.ts'));
    } else if (/\.jsx$/.test(base)) {
      candidates.push(base.replace(/\.jsx$/, '.tsx'));
    }
    candidates.push(base);
    return candidates;
  }
  return [
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...INDEX_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
}

/**
 * import の解決候補パスを優先順で返す。
 * - 相対 import は fromPath 起点、それ以外は tsconfig paths のエイリアス（issue #28 G）
 * - 拡張子なし → .tsx / .ts / .js / ... と index ファイルを試す
 * - `./x.js` 形式（NodeNext スタイル）→ 実体が x.ts のことが多いので .tsx / .ts も試す
 *
 * state は LanguageDefinition.prepare() が返した TsState（未指定なら相対 import のみ）。
 */
export function resolveImportCandidates(
  fromPath: string,
  spec: string,
  state?: unknown
): string[] {
  let bases: string[];
  if (isRelativeSpec(spec)) {
    const dir = fromPath.split('/').slice(0, -1);
    const base = normalizePath([...dir, ...spec.split('/')]);
    bases = base === null || base === '' ? [] : [base];
  } else {
    bases = aliasBases(spec, state);
  }
  return [...new Set(bases.flatMap(candidatesForBase))];
}

/** barrel を辿る最大段数（`components/index.ts` → `card/index.ts` → `card.tsx` 程度を想定） */
const MAX_REEXPORT_HOPS = 3;

/**
 * ファイルの公開名 → 関数。自ファイルに実体が無ければ re-export を辿る（issue #28 D）。
 * `export * from './card'` は元の名前のまま転送先を探す。
 */
function findExport(
  path: string,
  exportName: string,
  ctx: ResolveContext,
  state: unknown,
  hops: number
): ResolvedCall | null {
  const tables = ctx.file(path);
  if (!tables) return null;
  const own = tables.exports.get(exportName);
  if (own) return { path, fn: own };
  if (hops <= 0) return null;

  for (const re of tables.analysis.reExports ?? []) {
    if (re.typeOnly) continue;
    let imported: string;
    if (re.exported === '*') imported = exportName; // export * from './y'
    else if (re.exported === exportName) imported = re.imported;
    else continue;
    for (const candidate of resolveImportCandidates(path, re.source, state)) {
      if (!ctx.file(candidate)) continue;
      const found = findExport(candidate, imported, ctx, state, hops - 1);
      if (found) return found;
      break; // 転送先の実体は 1 ファイルなので、他の候補は見ない
    }
  }
  return null;
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
    const { clauses, reExports } = collectExports(rootNode);

    const functions: FunctionInfo[] = [];
    for (const m of queries.functions.matches(rootNode)) {
      const funcNode = m.captures.find((c) => c.name === 'func')!.node;
      const nameNode = m.captures.find((c) => c.name === 'name')!.node;
      const name = nameNode.text;
      const isClass = funcNode.type === 'class_declaration';
      const isDeclarator = funcNode.type === 'variable_declarator';
      // `const x = compute()` のように関数を包まない呼び出しは関数定義ではない
      const declBody = isDeclarator ? declaratorBody(funcNode) : null;
      if (isDeclarator && !declBody) continue;
      // class の render() は class ノードに畳むので独立したノードにはしない（issue #28 F）
      if (isFoldedRenderMethod(funcNode)) continue;
      // `const foo = () => {}` は variable_declarator 単体ではなく宣言文全体を表示範囲にする
      const rangeNode = isDeclarator && funcNode.parent ? funcNode.parent : funcNode;
      // 呼び出しの帰属は関数本体（variable_declarator なら value の関数）から集める
      const bodyRoot = declBody ?? funcNode;
      functions.push({
        name,
        kind: funcNode.type,
        isMethod: funcNode.type === 'method_definition',
        isNested:
          funcNode.type !== 'method_definition' && !isTopLevelDefinition(funcNode),
        startLine: rangeNode.startPosition.row + 1,
        endLine: rangeNode.endPosition.row + 1,
        startIndex: rangeNode.startIndex,
        endIndex: rangeNode.endIndex,
        exportName: directExportName(funcNode, name) ?? clauses.get(name),
        sourceText: rangeNode.text,
        calls: collectCalls(
          bodyRoot,
          CALL_NODES,
          isClass ? isClassBodyBoundary : isFunctionBoundary
        ),
      });
    }

    const imports = queries.imports.matches(rootNode).flatMap((m) => {
      const importNode = m.captures.find((c) => c.name === 'import')!.node;
      const sourceNode = m.captures.find((c) => c.name === 'source')!.node;
      return collectImportBindings(importNode, sourceNode.text);
    });

    return { path, language: metadata.id, functions, imports, reExports };
  },

  /**
   * tsconfig.json の paths エイリアスを 1 回だけ読む（issue #28 G）。
   * リポジトリルート以外の tsconfig と `extends` は追わない（fetch を増やさないため）。
   */
  async prepare(
    fetchFile: (path: string) => Promise<FetchFileResult>
  ): Promise<TsState> {
    const r = await fetchFile('tsconfig.json');
    if (!r.ok) return { aliases: [] };
    return { aliases: parsePathAliases(parseJsonc(r.content)) };
  },

  dependencyTargets(analysis: FileAnalysis, state: unknown): DependencyTarget[] {
    // 型だけの import（`import type`）はグラフに現れないので取得しない。
    // 同じ source を値としても import していれば、そちらの束縛で対象に残る（issue #27 A）
    const specs = new Set(
      analysis.imports.filter((b) => !b.typeOnly).map((b) => b.source)
    );
    // barrel の転送先も辿る（issue #28 D）
    for (const r of analysis.reExports ?? []) {
      if (!r.typeOnly) specs.add(r.source);
    }
    return [...specs]
      .map((spec) => ({
        kind: 'file' as const,
        candidates: resolveImportCandidates(analysis.path, spec, state),
      }))
      .filter((t) => t.candidates.length > 0);
  },

  // barrel（re-export だけの index.ts）は実装を持たないので深さに数えない（issue #28 D）
  isTransparent: (analysis: FileAnalysis) =>
    analysis.functions.length === 0 && (analysis.reExports?.length ?? 0) > 0,

  resolveCall(
    analysis: FileAnalysis,
    callee: string,
    ctx: ResolveContext,
    state: unknown
  ): ResolvedCall | null {
    // import 束縛 → 依存ファイルの export（候補のうち最初に解析済みのファイルで判定）
    const resolveImported = (
      binding: ImportBinding,
      exportName: string
    ): ResolvedCall | null => {
      for (const candidate of resolveImportCandidates(
        analysis.path,
        binding.source,
        state
      )) {
        if (!ctx.file(candidate)) continue;
        return findExport(candidate, exportName, ctx, state, MAX_REEXPORT_HOPS);
      }
      return null;
    };

    if (!callee.includes('.')) {
      const tables = ctx.file(analysis.path);
      // 1. 同一ファイルのトップレベル関数
      const local = tables?.topLevel.get(callee);
      if (local) return { path: analysis.path, fn: local };
      // 2. import 束縛 → 依存ファイルの export
      const binding = analysis.imports.find(
        (b) => b.local === callee && !b.typeOnly
      );
      if (binding && binding.imported !== '*') {
        return resolveImported(binding, binding.imported);
      }
      // 3. ネスト定義（issue #27 C）。import した本物を上書きしないよう最後に見る
      const nested = tables?.nested.get(callee);
      if (nested) return { path: analysis.path, fn: nested };
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
        (b) => b.local === head && b.imported === '*' && !b.typeOnly
      );
      if (binding) return resolveImported(binding, member);
    }
    return null;
  },
};
