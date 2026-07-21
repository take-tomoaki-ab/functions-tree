// analyzer-core のユニットテスト。GitHub API を使わず、フィクスチャ（test/fixtures/ の
// 小さな TS プロジェクト）に対してパース → 抽出 → グラフ組み立てを Node 上で検証する。
// 実行前に pretest（esbuild）が dist-test/analyzer-core.mjs を生成する。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildGraph,
  createAnalyzer,
  isAnalyzablePath,
  resolveImportCandidates,
} from '../dist-test/analyzer-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');
const grammarDir = join(__dirname, '..', 'node_modules', 'tree-sitter-typescript');

/** @type {import('../src/background/analyzer-core').Analyzer} */
let analyzer;

before(async () => {
  analyzer = await createAnalyzer({
    // Node では runtimeWasm 省略で web-tree-sitter 同梱の wasm が解決される
    typescriptWasm: join(grammarDir, 'tree-sitter-typescript.wasm'),
    tsxWasm: join(grammarDir, 'tree-sitter-tsx.wasm'),
  });
});

/** フィクスチャディレクトリをリポジトリに見立てたファイル取得 */
async function fetchFixture(path) {
  try {
    const content = await readFile(join(fixturesDir, path), 'utf8');
    return { ok: true, content };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
}

async function buildFixtureGraph(changedPaths, options) {
  return buildGraph(analyzer, changedPaths, fetchFixture, options);
}

const findNode = (graph, name) => graph.nodes.find((n) => n.name === name);
const hasEdge = (graph, fromName, toName) => {
  const from = findNode(graph, fromName);
  const to = findNode(graph, toName);
  return !!from && !!to && graph.edges.some((e) => e.from === from.id && e.to === to.id);
};

describe('analyzeFile: 関数・import・export の抽出', () => {
  test('関数 3 種（宣言 / アロー / メソッド）と行範囲・本体テキストを抽出する', async () => {
    const content = (await fetchFixture('util.ts')).content;
    const a = analyzer.analyzeFile('util.ts', content);

    const names = a.functions.map((f) => f.name).sort();
    assert.deepEqual(names, ['formatDate', 'helper', 'toUpper', 'trim']);

    const toUpper = a.functions.find((f) => f.name === 'toUpper');
    assert.equal(toUpper.kind, 'function_declaration');
    assert.equal(toUpper.startLine, 4);
    assert.equal(toUpper.endLine, 6);
    assert.match(toUpper.sourceText, /^export function toUpper|^function toUpper/);

    const helper = a.functions.find((f) => f.name === 'helper');
    assert.equal(helper.kind, 'variable_declarator');
    // 表示範囲は variable_declarator 単体ではなく宣言文全体
    assert.match(helper.sourceText, /^const helper = /);
  });

  test('export 名の対応: 直接 export / export clause の alias / 未 export', async () => {
    const content = (await fetchFixture('util.ts')).content;
    const a = analyzer.analyzeFile('util.ts', content);
    const byName = new Map(a.functions.map((f) => [f.name, f]));

    assert.equal(byName.get('toUpper').exportName, 'toUpper'); // export function
    assert.equal(byName.get('formatDate').exportName, 'formatDate'); // export const
    assert.equal(byName.get('helper').exportName, 'helperFn'); // export { helper as helperFn }
    assert.equal(byName.get('trim').exportName, undefined); // 未 export
  });

  test('export default function（名前付き）は exportName: default になる', async () => {
    const content = (await fetchFixture('greet.tsx')).content;
    const a = analyzer.analyzeFile('greet.tsx', content);
    const greeting = a.functions.find((f) => f.name === 'Greeting');
    assert.equal(greeting.exportName, 'default');
  });

  test('import 束縛: default / named / alias / namespace を区別して抽出する', async () => {
    const content = (await fetchFixture('app.ts')).content;
    const a = analyzer.analyzeFile('app.ts', content);
    const byLocal = new Map(a.imports.map((b) => [b.local, b]));

    assert.deepEqual(byLocal.get('greet'), {
      local: 'greet',
      source: './greet.js',
      imported: 'default',
    });
    assert.deepEqual(byLocal.get('toUpper'), {
      local: 'toUpper',
      source: './util',
      imported: 'toUpper',
    });
    assert.deepEqual(byLocal.get('shorten'), {
      local: 'shorten',
      source: './util',
      imported: 'helperFn', // alias の import 先は util 側の公開名
    });
    assert.deepEqual(byLocal.get('logger'), {
      local: 'logger',
      source: './logger',
      imported: '*',
    });
  });

  test('呼び出しの帰属: 無名コールバック内は外側の関数、名前付きネスト関数は跨がない', async () => {
    const content = (await fetchFixture('app.ts')).content;
    const a = analyzer.analyzeFile('app.ts', content);

    const render = a.functions.find((f) => f.name === 'render');
    const callees = render.calls.map((c) => c.callee);
    // .map コールバック内の toUpper / String も render に帰属する
    assert.ok(callees.includes('toUpper'));
    assert.ok(callees.includes('logger.write'));

    // main の呼び出しに render 内のものが混ざっていないこと
    const main = a.functions.find((f) => f.name === 'main');
    assert.ok(!main.calls.some((c) => c.callee === 'items.join'));
  });

  test('TSX ファイルをパースできる（JSX 構文入り）', async () => {
    const content = (await fetchFixture('greet.tsx')).content;
    const a = analyzer.analyzeFile('greet.tsx', content);
    assert.equal(a.functions.length, 1);
    assert.deepEqual(
      a.functions[0].calls.map((c) => c.callee),
      ['toUpper']
    );
  });
});

describe('resolveImportCandidates: 相対 import のパス解決', () => {
  test('拡張子なし → 各拡張子と index ファイルを候補にする', () => {
    const c = resolveImportCandidates('src/a/b.ts', './util');
    assert.ok(c.includes('src/a/util.ts'));
    assert.ok(c.includes('src/a/util.tsx'));
    assert.ok(c.includes('src/a/util/index.ts'));
  });

  test('../ で親ディレクトリに上がれる', () => {
    const c = resolveImportCandidates('src/a/b.ts', '../shared/x');
    assert.equal(c[0], 'src/shared/x.ts');
  });

  test('NodeNext 形式 ./x.js は x.ts / x.tsx を優先候補にする', () => {
    const c = resolveImportCandidates('src/a.ts', './x.js');
    assert.deepEqual(c.slice(0, 3), ['src/x.ts', 'src/x.tsx', 'src/x.js']);
  });

  test('外部パッケージ（相対でない import）は解決しない', () => {
    assert.deepEqual(resolveImportCandidates('src/a.ts', 'react'), []);
  });

  test('ルートより上に出る相対パスは解決しない', () => {
    assert.deepEqual(resolveImportCandidates('a.ts', '../../x'), []);
  });
});

describe('buildGraph: グラフ組み立て', () => {
  test('変更ファイル + 深さ 1 の依存を解析し、inDiff フラグを立て分ける', async () => {
    const graph = await buildFixtureGraph(['app.ts', 'store.ts']);

    // 依存（util / logger / greet）が深さ 1 で取得・解析される
    assert.deepEqual(
      [...graph.analyzedFiles].sort(),
      ['app.ts', 'greet.tsx', 'logger.ts', 'store.ts', 'util.ts']
    );

    assert.equal(findNode(graph, 'main').inDiff, true);
    assert.equal(findNode(graph, 'fib').inDiff, true);
    assert.equal(findNode(graph, 'toUpper').inDiff, false);
    assert.equal(findNode(graph, 'write').inDiff, false);
  });

  test('呼び出し解決: 同一ファイル / named / alias / namespace / default import', async () => {
    const graph = await buildFixtureGraph(['app.ts', 'store.ts']);

    assert.ok(hasEdge(graph, 'main', 'render'), '同一ファイル');
    assert.ok(hasEdge(graph, 'main', 'toUpper'), 'named import');
    assert.ok(
      hasEdge(graph, 'main', 'helper'),
      'alias import (shorten → 公開名 helperFn → 実体 helper)'
    );
    assert.ok(hasEdge(graph, 'main', 'write'), 'namespace import (logger.write)');
    assert.ok(hasEdge(graph, 'main', 'Greeting'), 'default import (greet → Greeting)');
    assert.ok(hasEdge(graph, 'helper', 'trim'), '依存ファイル内の同一ファイル呼び出し');
    // 深さ 1 の依存ファイル同士でも、解析済みならエッジが張られる
    assert.ok(hasEdge(graph, 'Greeting', 'toUpper'), '依存ファイル → 依存ファイル');
  });

  test('this.method() の解決と自己再帰エッジ', async () => {
    const graph = await buildFixtureGraph(['store.ts']);
    assert.ok(hasEdge(graph, 'refresh', 'load'), 'this.load() → メソッド load');
    assert.ok(hasEdge(graph, 'fib', 'fib'), '自己再帰');
  });

  test('解決できない呼び出し（console.log / 未定義名）は unresolvedCallCount に計上', async () => {
    const graph = await buildFixtureGraph(['app.ts']);
    // main: missingFn, console.log / render: String, items.join / util.toUpper: s.toUpperCase など
    assert.ok(graph.unresolvedCallCount >= 4, `count=${graph.unresolvedCallCount}`);
    // 未解決呼び出しはエッジにならない
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      assert.ok(ids.has(e.from) && ids.has(e.to));
    }
  });

  test('同一関数間の複数回呼び出しは 1 本のエッジに畳まれる', async () => {
    const graph = await buildFixtureGraph(['app.ts']);
    const render = findNode(graph, 'render');
    const write = findNode(graph, 'write');
    const edges = graph.edges.filter((e) => e.from === render.id && e.to === write.id);
    assert.equal(edges.length, 1);
  });

  test('dependencyDepth: 0 なら依存を辿らない', async () => {
    const graph = await buildFixtureGraph(['app.ts'], { dependencyDepth: 0 });
    assert.deepEqual(graph.analyzedFiles, ['app.ts']);
    // import 先が解析されていないので named import のエッジは張られない
    assert.ok(!hasEdge(graph, 'main', 'toUpper'));
    assert.ok(hasEdge(graph, 'main', 'render'), '同一ファイルは解決される');
  });

  test('取得に失敗した変更ファイルは skippedFiles に理由付きで記録される', async () => {
    const fetchWithError = async (path) => {
      if (path === 'huge.ts') return { ok: false, reason: 'too_large' };
      return fetchFixture(path);
    };
    const graph = await buildGraph(analyzer, ['app.ts', 'huge.ts'], fetchWithError);
    assert.deepEqual(
      graph.skippedFiles.filter((s) => s.path === 'huge.ts'),
      [{ path: 'huge.ts', reason: 'too_large' }]
    );
    assert.ok(graph.analyzedFiles.includes('app.ts'), '他のファイルは解析が続行される');
  });

  test('解析対象外の拡張子は最初から除外される', async () => {
    const graph = await buildFixtureGraph(['app.ts', 'README.md', 'style.css']);
    assert.ok(!graph.analyzedFiles.includes('README.md'));
    assert.ok(!graph.skippedFiles.some((s) => s.path === 'README.md'));
  });

  test('maxChangedFiles を超えた変更ファイルは changed_file_limit でスキップ記録される', async () => {
    const graph = await buildFixtureGraph(['app.ts', 'store.ts'], {
      maxChangedFiles: 1,
      dependencyDepth: 0,
    });
    assert.deepEqual(graph.analyzedFiles, ['app.ts']);
    assert.deepEqual(graph.skippedFiles, [
      { path: 'store.ts', reason: 'changed_file_limit' },
    ]);
  });

  test('maxDependencyFiles を超えた依存は dependency_limit でスキップ記録される', async () => {
    const graph = await buildFixtureGraph(['app.ts'], { maxDependencyFiles: 1 });
    assert.ok(graph.skippedFiles.some((s) => s.reason === 'dependency_limit'));
    // 変更ファイル + 依存 1 件のみ
    assert.equal(graph.analyzedFiles.length, 2);
  });

  test('ノード ID は filePath#name@startLine 形式で一意', async () => {
    const graph = await buildFixtureGraph(['app.ts', 'store.ts']);
    const ids = graph.nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length);
    const main = findNode(graph, 'main');
    assert.equal(main.id, `app.ts#main@${main.startLine}`);
  });
});

describe('isAnalyzablePath', () => {
  test('対象拡張子の判定', () => {
    for (const p of ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs']) {
      assert.ok(isAnalyzablePath(p), p);
    }
    for (const p of ['a.md', 'a.css', 'a.d.ts.map', 'a.json', 'Makefile']) {
      assert.ok(!isAnalyzablePath(p), p);
    }
  });
});
