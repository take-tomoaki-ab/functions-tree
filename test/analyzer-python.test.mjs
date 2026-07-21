// Python の抽出・解決・グラフ組み立てのユニットテスト（test/fixtures-py/ に対して Node 上で検証）。
// 実行前に pretest（esbuild）が dist-test/analyzer-core.mjs を生成する。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildGraph,
  createAnalyzer,
  resolvePythonModuleCandidates,
} from '../dist-test/analyzer-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures-py');

/** @type {import('../src/background/analyzer-core').Analyzer} */
let analyzer;

before(async () => {
  analyzer = await createAnalyzer({
    grammars: {
      python: join(
        __dirname, '..', 'node_modules', 'tree-sitter-python', 'tree-sitter-python.wasm'
      ),
    },
  });
});

async function fetchFixture(path) {
  try {
    const content = await readFile(join(fixturesDir, path), 'utf8');
    return { ok: true, content };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
}

async function buildFixtureGraph(changedFiles, options) {
  const inputs = changedFiles.map((f) => (typeof f === 'string' ? { path: f } : f));
  return buildGraph(analyzer, inputs, fetchFixture, options);
}

const findNode = (graph, name) => graph.nodes.find((n) => n.name === name);
const hasEdge = (graph, fromName, toName) => {
  const from = findNode(graph, fromName);
  const to = findNode(graph, toName);
  return !!from && !!to && graph.edges.some((e) => e.from === from.id && e.to === to.id);
};

describe('Python: analyzeFile の抽出', () => {
  test('トップレベル関数 / メソッド / デコレータ付き関数を抽出する', async () => {
    const content = (await fetchFixture('pkg/handlers.py')).content;
    const a = analyzer.analyzeFile('pkg/handlers.py', content);

    assert.equal(a.language, 'python');
    const names = a.functions.map((f) => f.name).sort();
    assert.deepEqual(names, ['Handler.handle_one', 'Handler.log', 'handle', 'prepare']);

    const handleOne = a.functions.find((f) => f.name === 'Handler.handle_one');
    assert.equal(handleOne.isMethod, true);
    assert.equal(handleOne.callName, 'handle_one');
    assert.equal(handleOne.exportName, undefined, 'メソッドは import 可能な公開名を持たない');

    // デコレータ付きはデコレータ行から表示範囲に含める
    const prepare = a.functions.find((f) => f.name === 'prepare');
    assert.equal(prepare.startLine, 16);
    assert.equal(prepare.endLine, 18);
    assert.match(prepare.sourceText, /^@functools\.lru_cache/);
    assert.equal(prepare.exportName, 'prepare', 'トップレベルの def は公開扱い');
  });

  test('ネスト関数は独立したノードとして抽出され、呼び出しの帰属は跨がない', async () => {
    const content = (await fetchFixture('main.py')).content;
    const a = analyzer.analyzeFile('main.py', content);

    const run = a.functions.find((f) => f.name === 'run');
    const inner = a.functions.find((f) => f.name === 'inner');
    assert.ok(inner, 'ネスト関数もノード化される');
    assert.equal(inner.exportName, undefined, 'ネスト関数は公開名を持たない');
    assert.deepEqual(run.calls.map((c) => c.callee), ['inner']);
    assert.deepEqual(inner.calls.map((c) => c.callee), ['main']);
  });

  test('import 束縛: from-import / alias / モジュール alias を区別して抽出する', async () => {
    const content = (await fetchFixture('main.py')).content;
    const a = analyzer.analyzeFile('main.py', content);
    const byLocal = new Map(a.imports.map((b) => [b.local, b]));

    assert.deepEqual(byLocal.get('handlers'), {
      local: 'handlers',
      source: 'pkg',
      imported: 'handlers',
    });
    assert.deepEqual(byLocal.get('init_app'), {
      local: 'init_app',
      source: 'pkg',
      imported: 'init_app',
    });
    assert.deepEqual(byLocal.get('to_upper'), {
      local: 'to_upper',
      source: 'pkg.util',
      imported: 'to_upper',
    });
    assert.deepEqual(byLocal.get('util_mod'), {
      local: 'util_mod',
      source: 'pkg.util',
      imported: '*',
    });
  });

  test('相対 import の束縛（from . import util as u / from .util import to_upper）', async () => {
    const content = (await fetchFixture('pkg/handlers.py')).content;
    const a = analyzer.analyzeFile('pkg/handlers.py', content);
    const byLocal = new Map(a.imports.map((b) => [b.local, b]));

    assert.deepEqual(byLocal.get('u'), { local: 'u', source: '.', imported: 'util' });
    assert.deepEqual(byLocal.get('to_upper'), {
      local: 'to_upper',
      source: '.util',
      imported: 'to_upper',
    });
  });
});

describe('resolvePythonModuleCandidates: モジュール → ファイル候補', () => {
  test('相対 import はドット数で親パッケージに遡る', () => {
    assert.deepEqual(resolvePythonModuleCandidates('pkg/handlers.py', '.util'), [
      'pkg/util.py',
      'pkg/util/__init__.py',
    ]);
    assert.deepEqual(resolvePythonModuleCandidates('pkg/sub/deep.py', '..util'), [
      'pkg/util.py',
      'pkg/util/__init__.py',
    ]);
    assert.deepEqual(resolvePythonModuleCandidates('pkg/handlers.py', '.'), [
      'pkg/__init__.py',
    ]);
  });

  test('ルートより上に出る相対 import は解決しない', () => {
    assert.deepEqual(resolvePythonModuleCandidates('main.py', '..x'), []);
  });

  test('絶対 import はリポジトリルート基準 + src レイアウトの root 推定', () => {
    assert.deepEqual(resolvePythonModuleCandidates('main.py', 'pkg.util'), [
      'pkg/util.py',
      'pkg/util/__init__.py',
    ]);
    assert.deepEqual(resolvePythonModuleCandidates('src/mypkg/a.py', 'mypkg.b'), [
      'src/mypkg/b.py',
      'src/mypkg/b/__init__.py',
      'mypkg/b.py',
      'mypkg/b/__init__.py',
    ]);
  });
});

describe('Python: buildGraph の解決', () => {
  test('絶対 import（同一リポジトリ内）の依存が解析され、エッジが張られる', async () => {
    const graph = await buildFixtureGraph(['main.py']);

    assert.deepEqual(
      [...graph.analyzedFiles].sort(),
      ['main.py', 'pkg/__init__.py', 'pkg/handlers.py', 'pkg/util.py']
    );
    assert.ok(hasEdge(graph, 'main', 'init_app'), 'from pkg import init_app（__init__.py の関数）');
    assert.ok(hasEdge(graph, 'main', 'to_upper'), 'from pkg.util import to_upper');
    assert.ok(hasEdge(graph, 'main', 'handle'), 'from pkg import handlers（サブモジュール）→ handlers.handle()');
    assert.ok(hasEdge(graph, 'main', 'shorten'), 'import pkg.util as util_mod → util_mod.shorten()');
    assert.ok(hasEdge(graph, 'shorten', 'trim'), '依存ファイル内の同一ファイル呼び出し');
  });

  test('ネスト関数のエッジ（run → inner → main）', async () => {
    const graph = await buildFixtureGraph(['main.py'], { dependencyDepth: 0 });
    assert.ok(hasEdge(graph, 'run', 'inner'));
    assert.ok(hasEdge(graph, 'inner', 'main'));
  });

  test('相対 import / self.method / デコレータ付き関数の解決', async () => {
    const graph = await buildFixtureGraph(['pkg/handlers.py']);

    assert.ok(hasEdge(graph, 'prepare', 'to_upper'), 'from .util import to_upper');
    assert.ok(hasEdge(graph, 'handle', 'trim'), 'from . import util as u → u.trim()');
    assert.ok(hasEdge(graph, 'Handler.handle_one', 'Handler.log'), 'self.log()');
    assert.ok(
      hasEdge(graph, 'Handler.handle_one', 'prepare'),
      'メソッドからトップレベル関数'
    );
  });

  test('親パッケージへの相対 import（from ..util import trim）', async () => {
    const graph = await buildFixtureGraph(['pkg/sub/deep.py']);
    assert.ok(graph.analyzedFiles.includes('pkg/util.py'));
    assert.ok(hasEdge(graph, 'deep_clean', 'trim'));
  });

  test('src レイアウトの絶対 import（src/mypkg から mypkg.b）', async () => {
    const graph = await buildFixtureGraph(['src/mypkg/a.py']);
    assert.ok(graph.analyzedFiles.includes('src/mypkg/b.py'));
    assert.ok(hasEdge(graph, 'a_main', 'helper'));
  });

  test('解決できない呼び出し（s.upper() 等）は unresolvedCallCount に計上される', async () => {
    const graph = await buildFixtureGraph(['pkg/util.py'], { dependencyDepth: 0 });
    // to_upper: s.upper() / shorten: trim は解決 / trim: s.strip() → 未解決 2 件
    assert.ok(graph.unresolvedCallCount >= 2, `count=${graph.unresolvedCallCount}`);
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      assert.ok(ids.has(e.from) && ids.has(e.to));
    }
  });
});
