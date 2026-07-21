// Python の言語定義。
//
// - 関数: トップレベル / ネスト関数 / クラスメソッドを function_definition で抽出。
//   デコレータ付きは decorated_definition 全体を表示範囲にする。
//   メソッドの表示名は `Class.method`（解決は bare 名 + self./cls. 経由）
// - export の概念がないので、トップレベルの def はすべて import 可能（exportName = 名前）
// - import 解決:
//   - 相対 import（`from .x import y` / `from ..pkg import z`）→ ドット数で親を遡る
//   - 絶対 import（`import a.b` / `from a.b import c`）→ リポジトリルート基準。
//     さらに src レイアウト対策として、先頭セグメントが自ファイルのパスに現れる場合は
//     その手前までを root 候補にする（src/flask/app.py から 'flask.helpers' →
//     src/flask/helpers.py）
//   - モジュール候補は `a/b.py` と `a/b/__init__.py` の両方
// - `from X import y` の y は関数ともサブモジュールとも取れるため、依存としては
//   X と X.y の両方を候補にし、呼び出し `y()` は X の関数、`y.f()` は X.y の関数として解決

import type { Node } from 'web-tree-sitter';
import { languageMetadata } from '../../shared/languages';
import type {
  DependencyTarget,
  FileAnalysis,
  ImportBinding,
  LanguageDefinition,
  LanguageQueries,
  ResolveContext,
  ResolvedCall,
} from './types';
import { collectCalls, dirnameOf } from './types';

const metadata = languageMetadata('python');

const FUNCTIONS_QUERY = `
(function_definition name: (identifier) @name) @func
`;

const IMPORTS_QUERY = `
(import_statement) @import
(import_from_statement) @import
`;

function isFunctionBoundary(node: Node): boolean {
  // lambda は境界にせず外側の関数に帰属させる
  return node.type === 'function_definition';
}

/** 関数を囲む最も内側のスコープ（module / class_definition / function_definition） */
function enclosingScope(node: Node): Node | null {
  let cur = node.parent;
  while (cur) {
    if (
      cur.type === 'module' ||
      cur.type === 'class_definition' ||
      cur.type === 'function_definition'
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function parseImportStatement(node: Node): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'dotted_name') {
      const name = child.text;
      // `import a.b`（alias なしの多段）は a を束縛するが a.b.f() は 3 セグメントで
      // 未対応のため、単一セグメントのみ束縛を作る
      if (!name.includes('.')) {
        bindings.push({ local: name, source: name, imported: '*' });
      }
    } else if (child.type === 'aliased_import') {
      const name = child.childForFieldName('name')?.text;
      const alias = child.childForFieldName('alias')?.text;
      if (name && alias) bindings.push({ local: alias, source: name, imported: '*' });
    }
  }
  return bindings;
}

function parseImportFromStatement(node: Node): ImportBinding[] {
  const moduleNode = node.childForFieldName('module_name');
  if (!moduleNode) return [];
  const source = moduleNode.text; // 'a.b' / '.x' / '..' など
  const bindings: ImportBinding[] = [];
  for (const child of node.namedChildren) {
    if (!child || child.id === moduleNode.id) continue;
    if (child.type === 'dotted_name') {
      const name = child.text;
      if (!name.includes('.')) bindings.push({ local: name, source, imported: name });
    } else if (child.type === 'aliased_import') {
      const name = child.childForFieldName('name')?.text;
      const alias = child.childForFieldName('alias')?.text;
      if (name && alias && !name.includes('.')) {
        bindings.push({ local: alias, source, imported: name });
      }
    }
    // wildcard_import（from x import *）は束縛が確定できないので対象外
  }
  return bindings;
}

/**
 * 標準ライブラリのモジュール名（Python 3.12 の sys.stdlib_module_names から常用分を抜粋）。
 * `import os` 等の絶対 import をリポジトリ内のファイル候補として fetch すると
 * 404 の無駄撃ちでレート制限を消費するため、依存の辿りから除外する。
 */
const PY_STDLIB = new Set([
  'abc', 'argparse', 'array', 'ast', 'asyncio', 'base64', 'bisect', 'builtins',
  'calendar', 'codecs', 'collections', 'concurrent', 'configparser', 'contextlib',
  'contextvars', 'copy', 'csv', 'ctypes', 'dataclasses', 'datetime', 'decimal',
  'difflib', 'dis', 'email', 'enum', 'errno', 'fnmatch', 'fractions', 'functools',
  'gc', 'getpass', 'gettext', 'glob', 'graphlib', 'gzip', 'hashlib', 'heapq',
  'hmac', 'html', 'http', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools',
  'json', 'keyword', 'locale', 'logging', 'math', 'mimetypes', 'multiprocessing',
  'numbers', 'operator', 'os', 'pathlib', 'pickle', 'platform', 'pprint', 'queue',
  'random', 're', 'secrets', 'select', 'shlex', 'shutil', 'signal', 'socket',
  'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'struct', 'subprocess', 'sys',
  'sysconfig', 'tarfile', 'tempfile', 'textwrap', 'threading', 'time', 'token',
  'tokenize', 'traceback', 'types', 'typing', 'unicodedata', 'unittest', 'urllib',
  'uuid', 'warnings', 'weakref', 'xml', 'zipfile', 'zlib', 'zoneinfo',
]);

/** モジュール指定にサブモジュール名を足す（'.' + 'util' → '.util'、'a.b' + 'c' → 'a.b.c'） */
function joinModule(source: string, name: string): string {
  return source.endsWith('.') ? `${source}${name}` : `${source}.${name}`;
}

/** モジュール指定 → リポジトリ内のファイル候補（優先順） */
export function resolvePythonModuleCandidates(
  fromPath: string,
  spec: string
): string[] {
  const dirname = dirnameOf(fromPath);
  const dirSegs = dirname === '' ? [] : dirname.split('/');

  if (spec.startsWith('.')) {
    let level = 0;
    while (spec[level] === '.') level++;
    const rest = spec.slice(level);
    const up = level - 1; // '.x' は同一パッケージ、'..x' で 1 つ上
    if (up > dirSegs.length) return [];
    const baseSegs = up === 0 ? dirSegs : dirSegs.slice(0, dirSegs.length - up);
    const restSegs = rest === '' ? [] : rest.split('.');
    const base = [...baseSegs, ...restSegs].join('/');
    if (restSegs.length === 0) {
      // 'from . import x' の '.' → パッケージ自身（__init__.py）
      return [base === '' ? '__init__.py' : `${base}/__init__.py`];
    }
    return [`${base}.py`, `${base}/__init__.py`];
  }

  const segs = spec.split('.');
  const rel = segs.join('/');
  const roots: string[] = [];
  // src レイアウト: 先頭セグメントが自ファイルのディレクトリに現れたら、その手前を root に
  const idx = dirSegs.indexOf(segs[0]);
  if (idx > 0) roots.push(`${dirSegs.slice(0, idx).join('/')}/`);
  roots.push('');
  const out: string[] = [];
  for (const root of roots) {
    out.push(`${root}${rel}.py`, `${root}${rel}/__init__.py`);
  }
  return [...new Set(out)];
}

export const pythonLanguage: LanguageDefinition = {
  ...metadata,
  grammarKeys: ['python'],
  grammarKeyFor: () => 'python',
  functionsQuery: FUNCTIONS_QUERY,
  importsQuery: IMPORTS_QUERY,
  isFunctionBoundary,

  analyze(path: string, rootNode: Node, queries: LanguageQueries): FileAnalysis {
    const functions = queries.functions.matches(rootNode).map((m) => {
      const funcNode = m.captures.find((c) => c.name === 'func')!.node;
      const nameNode = m.captures.find((c) => c.name === 'name')!.node;
      const bare = nameNode.text;
      const scope = enclosingScope(funcNode);
      const isMethod = scope?.type === 'class_definition';
      const isTopLevel = !scope || scope.type === 'module';
      const className = isMethod
        ? scope?.childForFieldName('name')?.text
        : undefined;
      // デコレータ付きはデコレータ行から表示範囲に含める
      const rangeNode =
        funcNode.parent?.type === 'decorated_definition' ? funcNode.parent : funcNode;
      return {
        name: className ? `${className}.${bare}` : bare,
        callName: bare,
        kind: funcNode.type,
        isMethod,
        startLine: rangeNode.startPosition.row + 1,
        endLine: rangeNode.endPosition.row + 1,
        // トップレベルの def は他モジュールから import 可能
        exportName: isTopLevel ? bare : undefined,
        sourceText: rangeNode.text,
        calls: collectCalls(funcNode, ['call'], isFunctionBoundary),
      };
    });

    const imports = queries.imports.matches(rootNode).flatMap((m) => {
      const node = m.captures.find((c) => c.name === 'import')!.node;
      return node.type === 'import_statement'
        ? parseImportStatement(node)
        : parseImportFromStatement(node);
    });

    return { path, language: metadata.id, functions, imports };
  },

  dependencyTargets(analysis: FileAnalysis): DependencyTarget[] {
    // 相対 import を先に辿る（確実にリポジトリ内なので、fetch 予算を優先的に使う）。
    // 絶対 import は標準ライブラリを除外した上で後回しにする
    const relative: DependencyTarget[] = [];
    const absolute: DependencyTarget[] = [];
    const seen = new Set<string>();
    const add = (spec: string): void => {
      if (!spec.startsWith('.') && PY_STDLIB.has(spec.split('.')[0])) return;
      const candidates = resolvePythonModuleCandidates(analysis.path, spec);
      if (candidates.length === 0) return;
      const key = candidates.join('|');
      if (seen.has(key)) return;
      seen.add(key);
      (spec.startsWith('.') ? relative : absolute).push({ kind: 'file', candidates });
    };
    for (const b of analysis.imports) {
      add(b.source);
      if (b.imported !== '*') {
        // `from X import y` の y がサブモジュールの場合（from . import util 等）
        add(joinModule(b.source, b.imported));
      }
    }
    return [...relative, ...absolute];
  },

  resolveCall(
    analysis: FileAnalysis,
    callee: string,
    ctx: ResolveContext
  ): ResolvedCall | null {
    const own = ctx.file(analysis.path);
    const resolveModuleExport = (
      spec: string,
      exportName: string
    ): ResolvedCall | null => {
      for (const candidate of resolvePythonModuleCandidates(analysis.path, spec)) {
        const fn = ctx.file(candidate)?.exports.get(exportName);
        if (fn) return { path: candidate, fn };
      }
      return null;
    };

    if (!callee.includes('.')) {
      // 1. 同一ファイルのトップレベル関数
      const local = own?.topLevel.get(callee);
      if (local) return { path: analysis.path, fn: local };
      // 2. ネスト関数（スコープの正確な判定はせず、同名の非メソッド関数に解決）
      const nested = analysis.functions.find(
        (f) => !f.isMethod && (f.callName ?? f.name) === callee
      );
      if (nested) return { path: analysis.path, fn: nested };
      // 3. from X import y の束縛
      const binding = analysis.imports.find(
        (b) => b.local === callee && b.imported !== '*'
      );
      if (binding) return resolveModuleExport(binding.source, binding.imported);
      return null;
    }

    const parts = callee.split('.');
    if (parts.length !== 2) return null;
    const [head, member] = parts;

    // self.method() / cls.method() → 同一ファイル内のメソッド（同名複数は最初の定義）
    if (head === 'self' || head === 'cls') {
      const methods = own?.methods.get(member);
      return methods?.length ? { path: analysis.path, fn: methods[0] } : null;
    }

    const binding = analysis.imports.find((b) => b.local === head);
    if (!binding) return null;
    if (binding.imported === '*') {
      // import x / import a.b as m → モジュール x の関数
      return resolveModuleExport(binding.source, member);
    }
    // from X import y; y.f() → サブモジュール X.y の関数
    return resolveModuleExport(joinModule(binding.source, binding.imported), member);
  },
};
