// tree-sitter によるコールグラフ抽出の中核。実行環境（SW / Node）に依存させないため、
// wasm の所在とファイル取得はすべて呼び出し側から注入する。
// SW からは analyzer.ts が、ユニットテストからは test/ が直接使う。
//
// Phase 6 で言語ごとの処理（抽出クエリ・import 解決・呼び出し解決）を
// languages/ の LanguageDefinition に切り出した。このファイルは言語非依存の
// パーサ初期化・依存の辿り・グラフ組み立てだけを持つ。

import { Language, Parser, Query } from 'web-tree-sitter';
import type {
  FunctionGraph,
  GraphEdge,
  GraphNode,
  SkippedFile,
} from '../shared/graph';
import type { PatchCommentableLines } from './diff-lines';
import { commentableLinesForRange, parsePatchCommentableLines } from './diff-lines';
import { collectHighlightTokens, tokensForRange } from './highlight';
import { LANGUAGE_DEFINITIONS, languageForPath } from './languages';
import type {
  FileAnalysis,
  FileTables,
  FunctionInfo,
  LanguageDefinition,
  LanguageQueries,
  ResolveContext,
} from './languages/types';
import { dirnameOf } from './languages/types';

// 言語モジュールの型・ロジックの再輸出（テスト・既存 import の互換用）
export type {
  CallSite,
  FileAnalysis,
  FunctionInfo,
  ImportBinding,
} from './languages/types';
export { languageForPath, LANGUAGE_DEFINITIONS } from './languages';
export { resolveImportCandidates } from './languages/typescript';
export { resolvePythonModuleCandidates } from './languages/python';

/** 解析対象の拡張子（全対応言語の合算） */
export const ANALYZABLE_EXTENSIONS = LANGUAGE_DEFINITIONS.flatMap(
  (d) => d.extensions
);

/** 変更ファイルから依存を辿る深さ。1 = 変更ファイルが直接 import するファイルまで */
export const DEFAULT_DEPENDENCY_DEPTH = 1;

/** 解析する変更ファイル数の上限。超過分はスキップ記録（未認証 60 req/h の保護） */
export const DEFAULT_MAX_CHANGED_FILES = 30;

/** 深さ 1 で追加取得する依存ファイル数の上限（レート制限保護） */
export const DEFAULT_MAX_DEPENDENCY_FILES = 20;

/** 依存解決のための fetch 試行回数の上限。候補パスの 404 やディレクトリ一覧も 1 回に数える */
export const DEFAULT_MAX_DEPENDENCY_FETCHES = 40;

export function isAnalyzablePath(path: string): boolean {
  return languageForPath(path) !== undefined;
}

// ---------------------------------------------------------------------------
// パーサ初期化
// ---------------------------------------------------------------------------

export interface AnalyzerWasmSource {
  /** web-tree-sitter.wasm の URL。Node では省略可（パッケージ同梱分を自動解決） */
  runtimeWasm?: string;
  /**
   * 文法 wasm のキー → URL・パス・バイト列。キーは LanguageDefinition.grammarKeys
   * （'typescript' / 'tsx' / 'go' / 'python'）。必要な wasm がすべて与えられた言語
   * だけが解析可能になる（テストで一部の言語だけ渡してもよい）。
   */
  grammars: Partial<Record<string, string | Uint8Array>>;
}

export interface Analyzer {
  analyzeFile(path: string, source: string): FileAnalysis;
  /** 文法 wasm が与えられ、解析可能になった言語 */
  languages: LanguageDefinition[];
}

interface GrammarSet {
  language: Language;
  queries: LanguageQueries;
}

/**
 * パーサと文法を初期化する。呼び出し側でモジュールスコープにキャッシュすること
 * （SW は頻繁に休止 → 再起動するため。初期化は 10ms 程度）。
 */
export async function createAnalyzer(wasm: AnalyzerWasmSource): Promise<Analyzer> {
  const runtimeWasm = wasm.runtimeWasm;
  await Parser.init(runtimeWasm ? { locateFile: () => runtimeWasm } : undefined);

  // 言語 id → (grammarKey → GrammarSet)。Query は文法 wasm ごとに作る必要がある
  const grammarSets = new Map<string, Map<string, GrammarSet>>();
  const loaded: LanguageDefinition[] = [];
  for (const def of LANGUAGE_DEFINITIONS) {
    if (!def.grammarKeys.every((key) => wasm.grammars[key] !== undefined)) continue;
    const byKey = new Map<string, GrammarSet>();
    for (const key of def.grammarKeys) {
      const language = await Language.load(wasm.grammars[key]!);
      byKey.set(key, {
        language,
        queries: {
          functions: new Query(language, def.functionsQuery),
          imports: new Query(language, def.importsQuery),
        },
      });
    }
    grammarSets.set(def.id, byKey);
    loaded.push(def);
  }
  const parser = new Parser();

  return {
    languages: loaded,
    analyzeFile(path: string, source: string): FileAnalysis {
      const def = languageForPath(path);
      const grammar = def && grammarSets.get(def.id)?.get(def.grammarKeyFor(path));
      if (!def || !grammar) throw new Error(`未対応の言語です: ${path}`);
      parser.setLanguage(grammar.language);
      const tree = parser.parse(source);
      if (!tree) throw new Error(`パースに失敗しました: ${path}`);
      try {
        const analysis = def.analyze(path, tree.rootNode, grammar.queries);
        // ハイライトはファイル全体で 1 回抽出し、各関数の文字範囲に切り出して割り当てる
        const tokens = collectHighlightTokens(tree.rootNode, def.highlight);
        for (const fn of analysis.functions) {
          fn.highlights = tokensForRange(tokens, fn.startIndex, fn.endIndex);
        }
        return analysis;
      } finally {
        tree.delete();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// グラフ組み立て
// ---------------------------------------------------------------------------

/** ファイル取得の結果。ok: false の reason は SkippedFile.reason にそのまま使われる */
export type FetchFileResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/** ディレクトリ一覧の取得結果。paths はディレクトリ直下のファイルのフルパス */
export type ListDirResult =
  | { ok: true; paths: string[] }
  | { ok: false; reason: string };

/** PR の変更ファイル 1 つ。patch は行レベルのコメント可否判定に使う（無くてもよい） */
export interface ChangedFileInput {
  path: string;
  /** GET /pulls/{n}/files の unified diff。バイナリ / 巨大ファイルでは undefined */
  patch?: string;
}

export interface BuildGraphOptions {
  /** 依存を辿る深さ（既定 1）。0 なら変更ファイルのみ */
  dependencyDepth?: number;
  /** 解析する変更ファイル数の上限 */
  maxChangedFiles?: number;
  /** 深さ拡張で解析に加える依存ファイル数の上限 */
  maxDependencyFiles?: number;
  /** 依存解決の fetch 試行回数の上限（候補パスの 404 やディレクトリ一覧も 1 回に数える） */
  maxDependencyFetches?: number;
  /**
   * ディレクトリ直下のファイル一覧の取得手段（Go のパッケージ解決に使う。
   * SW では GitHub contents API、テストでは fs.readdir）。
   * 未指定なら dir 依存は dir_listing_unavailable としてスキップ記録される。
   */
  listDir?: (dir: string) => Promise<ListDirResult>;
}

/**
 * 変更ファイル群からコールグラフを組み立てる。
 * fetchFile は変更ファイル・依存ファイルの中身の取得手段（SW では GitHub contents API、
 * テストではフィクスチャの読み込み）。存在しないパスは { ok: false } を返すこと。
 */
export async function buildGraph(
  analyzer: Analyzer,
  changedFiles: ChangedFileInput[],
  fetchFile: (path: string) => Promise<FetchFileResult>,
  options: BuildGraphOptions = {}
): Promise<FunctionGraph> {
  const depth = options.dependencyDepth ?? DEFAULT_DEPENDENCY_DEPTH;
  const maxChangedFiles = options.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES;
  const maxDependencyFiles =
    options.maxDependencyFiles ?? DEFAULT_MAX_DEPENDENCY_FILES;
  const maxDependencyFetches =
    options.maxDependencyFetches ?? DEFAULT_MAX_DEPENDENCY_FETCHES;

  const analyzable = changedFiles
    .map((f) => f.path)
    .filter(isAnalyzablePath);
  const changedSet = new Set(analyzable.slice(0, maxChangedFiles));
  // 変更ファイルごとの「コメント可能な行集合」（patch の RIGHT サイド）
  const patchLinesByPath = new Map<string, PatchCommentableLines>(
    changedFiles
      .filter((f) => changedSet.has(f.path))
      .map((f) => [f.path, parsePatchCommentableLines(f.patch)])
  );
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

  // 言語ごとの準備（Go: go.mod の取得）。変更ファイルに現れた言語だけ 1 回ずつ
  const langState = new Map<string, unknown>();
  for (const path of changedSet) {
    const def = languageForPath(path);
    if (def && def.prepare && !langState.has(def.id)) {
      langState.set(def.id, await def.prepare(fetchFile));
    }
  }

  // 深さ 0: PR の変更ファイル
  for (const path of changedSet) {
    await fetchAndAnalyze(path);
  }

  // 深さ 1..depth: 解析済みファイルの依存先を取得して解析対象に加える
  let frontier = [...analyzed.values()];
  let dependencyFiles = 0;
  let dependencyFetches = 0;
  // 取得済み / 取得失敗のディレクトリ一覧（同一ディレクトリの重複リクエスト防止）
  const listedDirs = new Map<string, string[]>();
  const requestedDirs = new Set<string>();

  for (let d = 0; d < depth; d++) {
    const added: FileAnalysis[] = [];

    /** 依存ファイル 1 つを取得・解析して added に加える */
    const analyzeDependency = async (path: string): Promise<boolean> => {
      try {
        const r = await fetchFile(path);
        if (!r.ok) {
          if (r.reason !== 'not_found') skipped.push({ path, reason: r.reason });
          return false;
        }
        const a = analyzer.analyzeFile(path, r.content);
        analyzed.set(path, a);
        added.push(a);
        dependencyFiles++;
        return true;
      } catch (e) {
        skipped.push({
          path,
          reason: `parse_error: ${e instanceof Error ? e.message : String(e)}`,
        });
        return false;
      }
    };

    for (const analysis of frontier) {
      const def = languageForPath(analysis.path);
      if (!def) continue;
      for (const target of def.dependencyTargets(analysis, langState.get(def.id))) {
        if (target.kind === 'file') {
          // 候補パスを順に試し、最初に取得できたものを解析する
          if (target.candidates.some((c) => analyzed.has(c))) continue;
          if (dependencyFiles >= maxDependencyFiles) {
            skipped.push({ path: target.candidates[0], reason: 'dependency_limit' });
            continue;
          }
          for (const candidate of target.candidates) {
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
        } else {
          // ディレクトリ内の対象ファイルすべて（Go のパッケージ）
          if (requestedDirs.has(target.dir) && !listedDirs.has(target.dir)) continue;
          let paths = listedDirs.get(target.dir);
          if (paths === undefined) {
            requestedDirs.add(target.dir);
            if (!options.listDir) {
              skipped.push({ path: target.dir, reason: 'dir_listing_unavailable' });
              continue;
            }
            if (dependencyFetches >= maxDependencyFetches) continue;
            dependencyFetches++;
            const r = await options.listDir(target.dir);
            if (!r.ok) {
              if (r.reason !== 'not_found') {
                skipped.push({ path: target.dir, reason: r.reason });
              }
              continue;
            }
            paths = r.paths;
            listedDirs.set(target.dir, paths);
          }
          for (const p of paths) {
            if (analyzed.has(p)) continue;
            const pDef = languageForPath(p);
            if (!pDef || pDef.id !== def.id) continue;
            if (def.includeDirFile && !def.includeDirFile(p)) continue;
            if (dependencyFiles >= maxDependencyFiles) {
              skipped.push({ path: p, reason: 'dependency_limit' });
              continue;
            }
            if (dependencyFetches >= maxDependencyFetches) break;
            dependencyFetches++;
            await analyzeDependency(p);
          }
        }
      }
    }
    frontier = added;
  }

  return assembleGraph(analyzed, changedSet, patchLinesByPath, skipped, langState);
}

function nodeId(path: string, name: string, startLine: number): string {
  return `${path}#${name}@${startLine}`;
}

function assembleGraph(
  analyzed: Map<string, FileAnalysis>,
  changedSet: Set<string>,
  patchLinesByPath: Map<string, PatchCommentableLines>,
  skippedFiles: SkippedFile[],
  langState: Map<string, unknown>
): FunctionGraph {
  const nodes: GraphNode[] = [];
  const tables = new Map<string, FileTables>();
  const dirIndex = new Map<string, string[]>();

  for (const [path, analysis] of analyzed) {
    const topLevel = new Map<string, FunctionInfo>();
    const methods = new Map<string, FunctionInfo[]>();
    const exports = new Map<string, FunctionInfo>();
    const patchLines = patchLinesByPath.get(path);
    for (const fn of analysis.functions) {
      // 行レベルのコメント可否: 関数の行範囲 ∩ patch のコメント可能行。
      // diff 外のファイル、変更ファイル内でも関数範囲に diff の行がなければ空になる
      const { lines, commentLine } = patchLines
        ? commentableLinesForRange(patchLines, fn.startLine, fn.endLine)
        : { lines: [] as number[], commentLine: undefined };
      nodes.push({
        id: nodeId(path, fn.name, fn.startLine),
        name: fn.name,
        exportName: fn.exportName,
        filePath: path,
        startLine: fn.startLine,
        endLine: fn.endLine,
        kind: fn.kind,
        inDiff: changedSet.has(path),
        commentableLines: lines,
        commentLine,
        sourceText: fn.sourceText,
        highlightTokens: fn.highlights ?? [],
      });
      const callName = fn.callName ?? fn.name;
      if (fn.isMethod) {
        const list = methods.get(callName) ?? [];
        list.push(fn);
        methods.set(callName, list);
      } else {
        // 同名の再宣言（オーバーロード実装等）は最初の定義を採用
        if (!topLevel.has(callName)) topLevel.set(callName, fn);
      }
      if (fn.exportName && !exports.has(fn.exportName)) {
        exports.set(fn.exportName, fn);
      }
    }
    tables.set(path, { analysis, topLevel, methods, exports });
    const dir = dirnameOf(path);
    dirIndex.set(dir, [...(dirIndex.get(dir) ?? []), path]);
  }

  const ctx: ResolveContext = {
    file: (path) => tables.get(path),
    filesInDir: (dir) => dirIndex.get(dir) ?? [],
  };

  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let unresolvedCallCount = 0;

  const addEdge = (from: string, to: string, callLine: number): void => {
    const key = `${from}->${to}`;
    if (edgeKeys.has(key)) return; // 同一関数間の複数回呼び出しは 1 本のエッジに畳む
    edgeKeys.add(key);
    edges.push({ from, to, callLine });
  };

  for (const analysis of analyzed.values()) {
    const def = languageForPath(analysis.path);
    if (!def) continue;
    const state = langState.get(def.id);
    for (const fn of analysis.functions) {
      const fromId = nodeId(analysis.path, fn.name, fn.startLine);
      for (const call of fn.calls) {
        const target = def.resolveCall(analysis, call.callee, ctx, state);
        if (target) {
          addEdge(
            fromId,
            nodeId(target.path, target.fn.name, target.fn.startLine),
            call.line
          );
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
