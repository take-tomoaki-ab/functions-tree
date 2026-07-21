// 言語定義のインターフェース。新しい言語への対応は、この LanguageDefinition を
// 実装したモジュールを languages/index.ts の配列に 1 つ足すだけでよい
// （文法 wasm の追加は package.json の copy-wasm と analyzer.ts の grammars にも 1 行ずつ）。

import type { Node, Query } from 'web-tree-sitter';
import type { LanguageMetadata } from '../../shared/languages';

/** 関数本体内の呼び出し 1 つ */
export interface CallSite {
  /** callee のテキスト。identifier（`log`）か member（`utils.toUpper`） */
  callee: string;
  /** 1 始まりの行番号 */
  line: number;
}

/** 抽出した関数 1 つ（ファイル内） */
export interface FunctionInfo {
  /** 表示名（Go / Python のメソッドは `Receiver.method` 形式） */
  name: string;
  /** 呼び出し解決で突き合わせる名前。省略時は name（メソッドは bare 名を入れる） */
  callName?: string;
  /** tree-sitter のノード種別（function_declaration 等） */
  kind: string;
  /** メソッド（レシーバ / self 付き）なら true */
  isMethod?: boolean;
  /** 1 始まりの行範囲（宣言全体。デコレータ含む） */
  startLine: number;
  endLine: number;
  /** 他ファイルから参照できる場合の公開名 */
  exportName?: string;
  sourceText: string;
  calls: CallSite[];
}

/** import 束縛 1 つ: ファイル内のローカル名が、どの module のどの名前に対応するか */
export interface ImportBinding {
  /** ファイル内で使う名前 */
  local: string;
  /** import 元の指定文字列（'./utils' / 'example.com/app/util' / '.util' など） */
  source: string;
  /** import 先での名前。default import は 'default'、モジュール全体は '*' */
  imported: string;
}

export interface FileAnalysis {
  path: string;
  /** 言語 id（LanguageDefinition.id） */
  language: string;
  /** Go の package 名（他言語は undefined） */
  packageName?: string;
  functions: FunctionInfo[];
  imports: ImportBinding[];
}

export interface LanguageQueries {
  functions: Query;
  imports: Query;
}

/** import から辿る依存先の指定 */
export type DependencyTarget =
  /** 候補パスを順に試し、最初に取得できたものを解析する（TS / Python） */
  | { kind: 'file'; candidates: string[] }
  /** ディレクトリ直下の対象拡張子ファイルをすべて解析する（Go のパッケージ） */
  | { kind: 'dir'; dir: string };

export interface ResolvedCall {
  path: string;
  fn: FunctionInfo;
}

/** 解析済みファイル 1 つ分の解決テーブル（analyzer-core の assembleGraph が構築する） */
export interface FileTables {
  analysis: FileAnalysis;
  /** callName → 非メソッド関数（同名は最初の定義） */
  topLevel: Map<string, FunctionInfo>;
  /** callName → メソッド（同名は全部。曖昧さの判定に使う） */
  methods: Map<string, FunctionInfo[]>;
  /** exportName → 関数（同名は最初の定義） */
  exports: Map<string, FunctionInfo>;
}

export interface ResolveContext {
  file(path: string): FileTables | undefined;
  /** 解析済みファイルのうち、指定ディレクトリ直下にあるもののパス */
  filesInDir(dir: string): string[];
}

export type FetchFileResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

export interface LanguageDefinition extends LanguageMetadata {
  /** 必要な文法 wasm のキー（AnalyzerWasmSource.grammars のキーと対応） */
  grammarKeys: string[];
  /** パスをどの文法でパースするか（TS は .tsx/.jsx のとき tsx 文法） */
  grammarKeyFor(path: string): string;
  functionsQuery: string;
  importsQuery: string;
  /** クエリ結果 + 構文木から FileAnalysis を組み立てる */
  analyze(path: string, rootNode: Node, queries: LanguageQueries): FileAnalysis;
  /**
   * グラフ構築前の言語ごとの準備（buildGraph 1 回につき 1 回だけ呼ばれる）。
   * Go は go.mod を取得して module パスを得る。
   * 返り値は dependencyTargets / resolveCall に state として渡る。
   */
  prepare?(fetchFile: (path: string) => Promise<FetchFileResult>): Promise<unknown>;
  /** このファイルの import から辿るべき依存先 */
  dependencyTargets(analysis: FileAnalysis, state: unknown): DependencyTarget[];
  /** dir 依存の展開に含めるファイルか（Go は _test.go を除外）。省略時はすべて含める */
  includeDirFile?(path: string): boolean;
  /** 呼び出しの解決。できなければ null（unresolvedCallCount に計上される） */
  resolveCall(
    analysis: FileAnalysis,
    callee: string,
    ctx: ResolveContext,
    state: unknown
  ): ResolvedCall | null;
  /**
   * 名前付きで抽出対象になる関数ノードか（呼び出し帰属の境界）。
   * 該当ノードの内側の呼び出しは、外側の関数ではなくそのノード自身に帰属させる。
   * 無名コールバック（インラインの arrow / func literal / lambda）は境界にしない。
   */
  isFunctionBoundary(node: Node): boolean;
}

// ---------------------------------------------------------------------------
// 言語共通ヘルパ
// ---------------------------------------------------------------------------

/** 呼び出しノードを boundary を跨がずに集める */
export function collectCalls(
  root: Node,
  callNodeTypes: readonly string[],
  isBoundary: (node: Node) => boolean
): CallSite[] {
  const calls: CallSite[] = [];
  const visit = (node: Node): void => {
    if (callNodeTypes.includes(node.type)) {
      const fn = node.childForFieldName('function');
      if (fn) calls.push({ callee: fn.text, line: fn.startPosition.row + 1 });
    }
    for (const child of node.namedChildren) {
      if (child && !isBoundary(child)) visit(child);
    }
  };
  visit(root);
  return calls;
}

/** posix パスのディレクトリ部分（ルート直下は ''） */
export function dirnameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** posix パスの正規化（'.' と '..' の解決）。ルートより上に出たら null */
export function normalizePath(segments: string[]): string | null {
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
