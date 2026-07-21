// Go の言語定義。
//
// Go はディレクトリ = パッケージなので、依存の辿り方が TS / Python と違う:
// - 同一ディレクトリ（同一パッケージ）のファイル間は import なしで互いの関数を呼べる
//   → 変更ファイルのディレクトリを dir 依存として展開し、兄弟ファイルも解析する
// - パッケージ import はモジュールパス基準（go.mod の module 宣言 + 相対ディレクトリ）
//   → prepare() で go.mod を 1 回取得し、import パス → リポジトリ内ディレクトリに写像する。
//     go.mod がリポジトリルートにない（モノレポ等）場合はパッケージ間解決を諦める
//
// メソッドの扱い（Phase 6 での決定）:
// - ノード名（表示名）は `Receiver.Method`（ポインタ / 型パラメータは除去）
// - 呼び出し `x.Method()` はレシーバの型を追わず、同一パッケージ内でメソッド名が
//   一意のときだけ解決する（複数の型に同名メソッドがあれば未解決扱い）

import type { Node } from 'web-tree-sitter';
import { languageMetadata } from '../../shared/languages';
import type {
  DependencyTarget,
  FetchFileResult,
  FileAnalysis,
  LanguageDefinition,
  LanguageQueries,
  ResolveContext,
  ResolvedCall,
} from './types';
import { collectCalls, dirnameOf } from './types';

const metadata = languageMetadata('go');

const FUNCTIONS_QUERY = `
(function_declaration name: (identifier) @name) @func
(method_declaration name: (field_identifier) @name) @func
`;

const IMPORTS_QUERY = `
(import_spec) @import
`;

interface GoState {
  /** go.mod の module 宣言。リポジトリルートに go.mod がなければ null */
  modulePath: string | null;
}

function isFunctionBoundary(node: Node): boolean {
  // func_literal（無名関数）は境界にせず外側の関数に帰属させる
  return node.type === 'function_declaration' || node.type === 'method_declaration';
}

/** method_declaration のレシーバ型名（`*Server` / `Server[T]` → `Server`） */
function receiverTypeName(method: Node): string | undefined {
  const receiver = method.childForFieldName('receiver');
  const param = receiver?.namedChildren.find(
    (c) => c?.type === 'parameter_declaration'
  );
  const typeNode = param?.childForFieldName('type');
  if (!typeNode) return undefined;
  const text = typeNode.text.replace(/^\*/, '');
  const bracket = text.indexOf('[');
  return bracket >= 0 ? text.slice(0, bracket) : text;
}

/** import パス → リポジトリ内ディレクトリ。モジュール外（標準ライブラリ等）は null */
function moduleImportDir(modulePath: string | null, importPath: string): string | null {
  if (!modulePath) return null;
  if (importPath === modulePath) return '';
  if (importPath.startsWith(`${modulePath}/`)) {
    return importPath.slice(modulePath.length + 1);
  }
  return null;
}

export const goLanguage: LanguageDefinition = {
  ...metadata,
  grammarKeys: ['go'],
  grammarKeyFor: () => 'go',
  functionsQuery: FUNCTIONS_QUERY,
  importsQuery: IMPORTS_QUERY,
  isFunctionBoundary,

  analyze(path: string, rootNode: Node, queries: LanguageQueries): FileAnalysis {
    const packageName = rootNode.namedChildren
      .find((c) => c?.type === 'package_clause')
      ?.namedChildren.find((c) => c?.type === 'package_identifier')?.text;

    const functions = queries.functions.matches(rootNode).map((m) => {
      const funcNode = m.captures.find((c) => c.name === 'func')!.node;
      const nameNode = m.captures.find((c) => c.name === 'name')!.node;
      const bare = nameNode.text;
      const isMethod = funcNode.type === 'method_declaration';
      const receiver = isMethod ? receiverTypeName(funcNode) : undefined;
      return {
        name: receiver ? `${receiver}.${bare}` : bare,
        callName: bare,
        kind: funcNode.type,
        isMethod,
        startLine: funcNode.startPosition.row + 1,
        endLine: funcNode.endPosition.row + 1,
        // Go の公開判定は先頭大文字。メソッドはパッケージ関数として呼べないので対象外
        exportName: !isMethod && /^\p{Lu}/u.test(bare) ? bare : undefined,
        sourceText: funcNode.text,
        calls: collectCalls(funcNode, ['call_expression'], isFunctionBoundary),
      };
    });

    const imports = queries.imports.matches(rootNode).flatMap((m) => {
      const spec = m.captures.find((c) => c.name === 'import')!.node;
      const pathNode = spec.childForFieldName('path');
      if (!pathNode) return [];
      const importPath = pathNode.text.replace(/^"|"$/g, '');
      const nameNode = spec.childForFieldName('name');
      // `.` import（unqualified）と `_` import（副作用のみ）は束縛を作らない
      if (nameNode && nameNode.type !== 'package_identifier') return [];
      const local = nameNode?.text ?? importPath.split('/').pop();
      if (!local) return [];
      return [{ local, source: importPath, imported: '*' }];
    });

    return { path, language: metadata.id, packageName, functions, imports };
  },

  async prepare(
    fetchFile: (path: string) => Promise<FetchFileResult>
  ): Promise<GoState> {
    const r = await fetchFile('go.mod');
    if (!r.ok) return { modulePath: null };
    const m = /^module\s+(\S+)/m.exec(r.content);
    return { modulePath: m ? m[1] : null };
  },

  dependencyTargets(analysis: FileAnalysis, state: unknown): DependencyTarget[] {
    const modulePath = (state as GoState | undefined)?.modulePath ?? null;
    // 同一パッケージ（同一ディレクトリ）の兄弟ファイルは常に展開対象
    const targets: DependencyTarget[] = [
      { kind: 'dir', dir: dirnameOf(analysis.path) },
    ];
    const seen = new Set<string>();
    for (const b of analysis.imports) {
      const dir = moduleImportDir(modulePath, b.source);
      if (dir !== null && !seen.has(dir)) {
        seen.add(dir);
        targets.push({ kind: 'dir', dir });
      }
    }
    return targets;
  },

  // テストファイルは PR の変更ファイルとしては解析するが、パッケージ展開では取得しない
  includeDirFile: (path: string) => !path.endsWith('_test.go'),

  resolveCall(
    analysis: FileAnalysis,
    callee: string,
    ctx: ResolveContext,
    state: unknown
  ): ResolvedCall | null {
    const modulePath = (state as GoState | undefined)?.modulePath ?? null;
    const dir = dirnameOf(analysis.path);
    const samePackageFiles = (): string[] =>
      ctx.filesInDir(dir).filter((p) => {
        const t = ctx.file(p);
        return (
          t?.analysis.language === metadata.id &&
          t.analysis.packageName === analysis.packageName
        );
      });

    if (!callee.includes('.')) {
      // 同一ファイル → 同一パッケージ（同一ディレクトリ + 同一 package 名）のトップレベル関数
      const own = ctx.file(analysis.path)?.topLevel.get(callee);
      if (own) return { path: analysis.path, fn: own };
      for (const p of samePackageFiles()) {
        if (p === analysis.path) continue;
        const fn = ctx.file(p)?.topLevel.get(callee);
        if (fn) return { path: p, fn };
      }
      return null;
    }

    const parts = callee.split('.');
    if (parts.length !== 2) return null;
    const [head, member] = parts;

    // pkg.Foo(): import 束縛 → そのパッケージディレクトリの公開関数
    const binding = analysis.imports.find((b) => b.local === head);
    if (binding) {
      const targetDir = moduleImportDir(modulePath, binding.source);
      if (targetDir === null) return null; // 標準ライブラリ・外部パッケージ
      for (const p of ctx.filesInDir(targetDir)) {
        const fn = ctx.file(p)?.exports.get(member);
        if (fn) return { path: p, fn };
      }
      return null;
    }

    // x.Method(): レシーバの型は追わない。同一パッケージ内で一意なメソッド名のみ解決
    const matches: ResolvedCall[] = [];
    for (const p of samePackageFiles()) {
      for (const fn of ctx.file(p)?.methods.get(member) ?? []) {
        matches.push({ path: p, fn });
      }
    }
    return matches.length === 1 ? matches[0] : null;
  },
};
