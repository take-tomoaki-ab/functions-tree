// tree-sitter によるコールグラフ抽出の中核。実行環境（SW / Node）に依存させないため、
// wasm の所在とファイル取得はすべて呼び出し側から注入する。
// SW からは analyzer.ts が、ユニットテストからは test/ が直接使う。

import { Language, Parser, Query } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import type {
  FunctionGraph,
  GraphEdge,
  GraphNode,
  SkippedFile,
} from '../shared/graph';

/** 解析対象の拡張子。.tsx / .jsx は tsx 文法、それ以外は typescript 文法でパースする */
export const ANALYZABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** 変更ファイルから依存を辿る深さ。1 = 変更ファイルが直接 import するファイルまで */
export const DEFAULT_DEPENDENCY_DEPTH = 1;

/** 解析する変更ファイル数の上限。超過分はスキップ記録（未認証 60 req/h の保護） */
export const DEFAULT_MAX_CHANGED_FILES = 30;

/** 深さ 1 で追加取得する依存ファイル数の上限（レート制限保護） */
export const DEFAULT_MAX_DEPENDENCY_FILES = 20;

/** 依存解決のための fetch 試行回数の上限。候補パスの 404 も 1 回に数える */
export const DEFAULT_MAX_DEPENDENCY_FETCHES = 40;

export function isAnalyzablePath(path: string): boolean {
  return ANALYZABLE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

// ---------------------------------------------------------------------------
// パーサ初期化
// ---------------------------------------------------------------------------

export interface AnalyzerWasmSource {
  /** web-tree-sitter.wasm の URL。Node では省略可（パッケージ同梱分を自動解決） */
  runtimeWasm?: string;
  /** tree-sitter-typescript.wasm の URL・パス・バイト列 */
  typescriptWasm: string | Uint8Array;
  /** tree-sitter-tsx.wasm の URL・パス・バイト列 */
  tsxWasm: string | Uint8Array;
}

interface LanguageSet {
  language: Language;
  functionQuery: Query;
  importQuery: Query;
}

export interface Analyzer {
  analyzeFile(path: string, source: string): FileAnalysis;
}

// Query は文法 wasm ごとに作る必要があるが、クエリ文字列自体は TS / TSX で共通。
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

/**
 * パーサと文法を初期化する。呼び出し側でモジュールスコープにキャッシュすること
 * （SW は頻繁に休止 → 再起動するため。初期化は 10ms 程度）。
 */
export async function createAnalyzer(wasm: AnalyzerWasmSource): Promise<Analyzer> {
  const runtimeWasm = wasm.runtimeWasm;
  await Parser.init(runtimeWasm ? { locateFile: () => runtimeWasm } : undefined);
  const load = async (source: string | Uint8Array): Promise<LanguageSet> => {
    const language = await Language.load(source);
    return {
      language,
      functionQuery: new Query(language, FUNCTIONS_QUERY),
      importQuery: new Query(language, IMPORTS_QUERY),
    };
  };
  const typescript = await load(wasm.typescriptWasm);
  const tsx = await load(wasm.tsxWasm);
  const parser = new Parser();

  return {
    analyzeFile(path: string, source: string): FileAnalysis {
      const set = path.endsWith('.tsx') || path.endsWith('.jsx') ? tsx : typescript;
      parser.setLanguage(set.language);
      const tree = parser.parse(source);
      if (!tree) throw new Error(`パースに失敗しました: ${path}`);
      try {
        return analyzeTree(path, set, tree.rootNode);
      } finally {
        tree.delete();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 単一ファイルの解析
// ---------------------------------------------------------------------------

/** 関数本体内の呼び出し 1 つ */
export interface CallSite {
  /** call_expression の callee テキスト。identifier（`log`）か member（`utils.toUpper`） */
  callee: string;
  /** 1 始まりの行番号 */
  line: number;
}

/** 抽出した関数 1 つ（ファイル内） */
export interface FunctionInfo {
  name: string;
  /** function_declaration | variable_declarator | method_definition */
  kind: string;
  startLine: number;
  endLine: number;
  /** export されている場合の公開名（default export は 'default'） */
  exportName?: string;
  sourceText: string;
  calls: CallSite[];
}

/** import 束縛 1 つ: ファイル内のローカル名が、どの module のどの名前に対応するか */
export interface ImportBinding {
  /** ファイル内で使う名前 */
  local: string;
  /** import 元の指定文字列（'./utils' など） */
  source: string;
  /** import 先での名前。default import は 'default'、namespace import は '*' */
  imported: string;
}

export interface FileAnalysis {
  path: string;
  functions: FunctionInfo[];
  imports: ImportBinding[];
}

/**
 * 名前付きで抽出対象になる関数ノードか（呼び出し帰属の境界）。
 * ここに該当するノードの内側の呼び出しは、外側の関数ではなくそのノード自身に帰属させる。
 * 無名コールバック（インラインの arrow 等）は境界にせず外側の関数に帰属させる。
 */
function isExtractedFunctionBoundary(node: Node): boolean {
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

function collectCalls(root: Node): CallSite[] {
  const calls: CallSite[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn) calls.push({ callee: fn.text, line: fn.startPosition.row + 1 });
    }
    for (const child of node.namedChildren) {
      if (child && !isExtractedFunctionBoundary(child)) visit(child);
    }
  };
  visit(root);
  return calls;
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

function analyzeTree(path: string, set: LanguageSet, rootNode: Node): FileAnalysis {
  const exportClauses = collectExportClauses(rootNode);

  const functions = set.functionQuery.matches(rootNode).map((m) => {
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
      startLine: rangeNode.startPosition.row + 1,
      endLine: rangeNode.endPosition.row + 1,
      exportName: directExportName(funcNode, name) ?? exportClauses.get(name),
      sourceText: rangeNode.text,
      calls: collectCalls(bodyRoot),
    };
  });

  const imports = set.importQuery.matches(rootNode).flatMap((m) => {
    const importNode = m.captures.find((c) => c.name === 'import')!.node;
    const sourceNode = m.captures.find((c) => c.name === 'source')!.node;
    return collectImportBindings(importNode, sourceNode.text);
  });

  return { path, functions, imports };
}

// ---------------------------------------------------------------------------
// 相対 import のパス解決
// ---------------------------------------------------------------------------

/** './x' / '../y' 形式か（node_modules 等の外部パッケージはノード化しない） */
function isRelativeSpec(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

/** posix パスの正規化（'.' と '..' の解決）。ルートより上に出たら null */
function normalizePath(segments: string[]): string | null {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
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

  if (isAnalyzablePath(base)) {
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
    ...ANALYZABLE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...['.ts', '.tsx', '.js'].map((ext) => `${base}/index${ext}`),
  ];
}

// ---------------------------------------------------------------------------
// グラフ組み立て
// ---------------------------------------------------------------------------

/** ファイル取得の結果。ok: false の reason は SkippedFile.reason にそのまま使われる */
export type FetchFileResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

export interface BuildGraphOptions {
  /** 依存を辿る深さ（既定 1）。0 なら変更ファイルのみ */
  dependencyDepth?: number;
  /** 解析する変更ファイル数の上限 */
  maxChangedFiles?: number;
  /** 深さ拡張で解析に加える依存ファイル数の上限 */
  maxDependencyFiles?: number;
  /** 依存解決の fetch 試行回数の上限（候補パスの 404 も 1 回に数える） */
  maxDependencyFetches?: number;
}

/**
 * 変更ファイル群からコールグラフを組み立てる。
 * fetchFile は変更ファイル・依存ファイルの中身の取得手段（SW では GitHub contents API、
 * テストではフィクスチャの読み込み）。存在しないパスは { ok: false } を返すこと。
 */
export async function buildGraph(
  analyzer: Analyzer,
  changedPaths: string[],
  fetchFile: (path: string) => Promise<FetchFileResult>,
  options: BuildGraphOptions = {}
): Promise<FunctionGraph> {
  const depth = options.dependencyDepth ?? DEFAULT_DEPENDENCY_DEPTH;
  const maxChangedFiles = options.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES;
  const maxDependencyFiles =
    options.maxDependencyFiles ?? DEFAULT_MAX_DEPENDENCY_FILES;
  const maxDependencyFetches =
    options.maxDependencyFetches ?? DEFAULT_MAX_DEPENDENCY_FETCHES;

  const analyzable = changedPaths.filter(isAnalyzablePath);
  const changedSet = new Set(analyzable.slice(0, maxChangedFiles));
  const analyzed = new Map<string, FileAnalysis>();
  const skipped: SkippedFile[] = [];

  const fetchAndAnalyze = async (path: string): Promise<boolean> => {
    const r = await fetchFile(path);
    if (!r.ok) {
      skipped.push({ path, reason: r.reason });
      return false;
    }
    try {
      analyzed.set(path, analyzer.analyzeFile(path, r.content));
      return true;
    } catch (e) {
      skipped.push({
        path,
        reason: `parse_error: ${e instanceof Error ? e.message : String(e)}`,
      });
      return false;
    }
  };

  for (const path of analyzable.slice(maxChangedFiles)) {
    skipped.push({ path, reason: 'changed_file_limit' });
  }

  // 深さ 0: PR の変更ファイル
  for (const path of changedSet) {
    await fetchAndAnalyze(path);
  }

  // 深さ 1..depth: 解析済みファイルの相対 import 先を取得して解析対象に加える
  let frontier = [...analyzed.values()];
  let dependencyFiles = 0;
  let dependencyFetches = 0;
  for (let d = 0; d < depth; d++) {
    const added: FileAnalysis[] = [];
    for (const analysis of frontier) {
      const specs = new Set(
        analysis.imports.filter((b) => isRelativeSpec(b.source)).map((b) => b.source)
      );
      for (const spec of specs) {
        const candidates = resolveImportCandidates(analysis.path, spec);
        // 既に解析済み（変更ファイル同士の import 等）なら fetch 不要
        if (candidates.some((c) => analyzed.has(c))) continue;
        if (dependencyFiles >= maxDependencyFiles) {
          skipped.push({ path: candidates[0] ?? spec, reason: 'dependency_limit' });
          continue;
        }
        for (const candidate of candidates) {
          if (dependencyFetches >= maxDependencyFetches) break;
          dependencyFetches++;
          const r = await fetchFile(candidate);
          if (!r.ok) {
            // 候補の探索なので not_found は静かに次の候補へ。それ以外は記録
            if (r.reason !== 'not_found') {
              skipped.push({ path: candidate, reason: r.reason });
              break;
            }
            continue;
          }
          try {
            const a = analyzer.analyzeFile(candidate, r.content);
            analyzed.set(candidate, a);
            added.push(a);
            dependencyFiles++;
          } catch (e) {
            skipped.push({
              path: candidate,
              reason: `parse_error: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
          break;
        }
      }
    }
    frontier = added;
  }

  return assembleGraph(analyzed, changedSet, skipped);
}

function nodeId(path: string, name: string, startLine: number): string {
  return `${path}#${name}@${startLine}`;
}

function assembleGraph(
  analyzed: Map<string, FileAnalysis>,
  changedSet: Set<string>,
  skippedFiles: SkippedFile[]
): FunctionGraph {
  const nodes: GraphNode[] = [];
  // ファイルごとの解決テーブル
  const topLevelByName = new Map<string, Map<string, FunctionInfo>>();
  const methodByName = new Map<string, Map<string, FunctionInfo>>();
  const exportByName = new Map<string, Map<string, FunctionInfo>>();

  for (const [path, analysis] of analyzed) {
    const topLevel = new Map<string, FunctionInfo>();
    const methods = new Map<string, FunctionInfo>();
    const exports = new Map<string, FunctionInfo>();
    for (const fn of analysis.functions) {
      nodes.push({
        id: nodeId(path, fn.name, fn.startLine),
        name: fn.name,
        exportName: fn.exportName,
        filePath: path,
        startLine: fn.startLine,
        endLine: fn.endLine,
        kind: fn.kind,
        inDiff: changedSet.has(path),
        sourceText: fn.sourceText,
      });
      if (fn.kind === 'method_definition') {
        if (!methods.has(fn.name)) methods.set(fn.name, fn);
      } else {
        // 同名の再宣言（オーバーロード実装等）は最初の定義を採用
        if (!topLevel.has(fn.name)) topLevel.set(fn.name, fn);
        if (fn.exportName && !exports.has(fn.exportName)) {
          exports.set(fn.exportName, fn);
        }
      }
    }
    topLevelByName.set(path, topLevel);
    methodByName.set(path, methods);
    exportByName.set(path, exports);
  }

  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let unresolvedCallCount = 0;

  const addEdge = (from: string, to: string, callLine: number): void => {
    const key = `${from}->${to}`;
    if (edgeKeys.has(key)) return; // 同一関数間の複数回呼び出しは 1 本のエッジに畳む
    edgeKeys.add(key);
    edges.push({ from, to, callLine });
  };

  /** callee 名を関数に解決する。できなければ null */
  const resolve = (
    analysis: FileAnalysis,
    callee: string
  ): { path: string; fn: FunctionInfo } | null => {
    if (!callee.includes('.')) {
      // 1. 同一ファイルのトップレベル関数
      const local = topLevelByName.get(analysis.path)?.get(callee);
      if (local) return { path: analysis.path, fn: local };
      // 2. import 束縛 → 依存ファイルの export
      const binding = analysis.imports.find((b) => b.local === callee);
      if (binding && binding.imported !== '*') {
        const target = resolveImportedFunction(binding, binding.imported, analysis.path);
        if (target) return target;
      }
      return null;
    }
    const parts = callee.split('.');
    if (parts.length === 2) {
      const [head, member] = parts;
      // this.method() → 同一ファイル内のメソッド
      if (head === 'this') {
        const method = methodByName.get(analysis.path)?.get(member);
        return method ? { path: analysis.path, fn: method } : null;
      }
      // ns.func() → namespace import 先の export
      const binding = analysis.imports.find(
        (b) => b.local === head && b.imported === '*'
      );
      if (binding) return resolveImportedFunction(binding, member, analysis.path);
    }
    return null;
  };

  const resolveImportedFunction = (
    binding: ImportBinding,
    exportName: string,
    fromPath: string
  ): { path: string; fn: FunctionInfo } | null => {
    for (const candidate of resolveImportCandidates(fromPath, binding.source)) {
      const exports = exportByName.get(candidate);
      if (!exports) continue;
      const fn = exports.get(exportName);
      return fn ? { path: candidate, fn } : null;
    }
    return null;
  };

  for (const analysis of analyzed.values()) {
    for (const fn of analysis.functions) {
      const fromId = nodeId(analysis.path, fn.name, fn.startLine);
      for (const call of fn.calls) {
        const target = resolve(analysis, call.callee);
        if (target) {
          addEdge(fromId, nodeId(target.path, target.fn.name, target.fn.startLine), call.line);
        } else {
          unresolvedCallCount++;
        }
      }
    }
  }

  return {
    nodes,
    edges,
    analyzedFiles: [...analyzed.keys()],
    skippedFiles,
    unresolvedCallCount,
  };
}
