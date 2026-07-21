// Go の抽出・解決・グラフ組み立てのユニットテスト（test/fixtures-go/ に対して Node 上で検証）。
// 実行前に pretest（esbuild）が dist-test/analyzer-core.mjs を生成する。

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildGraph, createAnalyzer } from '../dist-test/analyzer-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures-go');

/** @type {import('../src/background/analyzer-core').Analyzer} */
let analyzer;

before(async () => {
  analyzer = await createAnalyzer({
    grammars: {
      go: join(__dirname, '..', 'node_modules', 'tree-sitter-go', 'tree-sitter-go.wasm'),
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

/** ディレクトリ一覧（Go のパッケージ解決に必要。SW の contents API 相当） */
async function listFixtureDir(dir) {
  try {
    const entries = await readdir(join(fixturesDir, dir), { withFileTypes: true });
    return {
      ok: true,
      paths: entries
        .filter((e) => e.isFile())
        .map((e) => (dir === '' ? e.name : `${dir}/${e.name}`)),
    };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
}

async function buildFixtureGraph(changedFiles, options) {
  const inputs = changedFiles.map((f) => (typeof f === 'string' ? { path: f } : f));
  return buildGraph(analyzer, inputs, fetchFixture, {
    listDir: listFixtureDir,
    ...options,
  });
}

const findNode = (graph, name) => graph.nodes.find((n) => n.name === name);
const hasEdge = (graph, fromName, toName) => {
  const from = findNode(graph, fromName);
  const to = findNode(graph, toName);
  return !!from && !!to && graph.edges.some((e) => e.from === from.id && e.to === to.id);
};

describe('Go: analyzeFile の抽出', () => {
  test('関数とメソッドを抽出し、メソッド名は Receiver.Method 形式になる', async () => {
    const content = (await fetchFixture('server.go')).content;
    const a = analyzer.analyzeFile('server.go', content);

    assert.equal(a.language, 'go');
    assert.equal(a.packageName, 'main');
    const names = a.functions.map((f) => f.name).sort();
    assert.deepEqual(names, ['NewServer', 'Server.Start', 'Server.log', 'Worker.Start']);

    const start = a.functions.find((f) => f.name === 'Server.Start');
    assert.equal(start.kind, 'method_declaration');
    assert.equal(start.isMethod, true);
    assert.equal(start.callName, 'Start'); // 解決用の bare 名
    assert.equal(start.startLine, 12);
    assert.equal(start.endLine, 14);
    assert.match(start.sourceText, /^func \(s \*Server\) Start\(\)/);
  });

  test('公開判定は先頭大文字（メソッドはパッケージ関数として export しない）', async () => {
    const content = (await fetchFixture('util/strings.go')).content;
    const a = analyzer.analyzeFile('util/strings.go', content);
    const byName = new Map(a.functions.map((f) => [f.name, f]));

    assert.equal(byName.get('ToUpper').exportName, 'ToUpper'); // 大文字始まり
    assert.equal(byName.get('trim').exportName, undefined); // 小文字始まり

    const server = analyzer.analyzeFile(
      'server.go',
      (await fetchFixture('server.go')).content
    );
    const start = server.functions.find((f) => f.name === 'Server.Start');
    assert.equal(start.exportName, undefined);
  });

  test('import 束縛: alias 付き / なし（パッケージ名 = 最終セグメント）', async () => {
    const content = (await fetchFixture('main.go')).content;
    const a = analyzer.analyzeFile('main.go', content);
    const byLocal = new Map(a.imports.map((b) => [b.local, b]));

    assert.deepEqual(byLocal.get('fmt'), { local: 'fmt', source: 'fmt', imported: '*' });
    assert.deepEqual(byLocal.get('stringsutil'), {
      local: 'stringsutil',
      source: 'example.com/app/util',
      imported: '*',
    });
  });

  test('呼び出しの帰属: func literal（無名関数）内の呼び出しは外側の関数に帰属する', async () => {
    const content = (await fetchFixture('main.go')).content;
    const a = analyzer.analyzeFile('main.go', content);
    const build = a.functions.find((f) => f.name === 'buildMessage');
    const callees = build.calls.map((c) => c.callee);

    assert.ok(callees.includes('record'), 'func literal 内の呼び出し');
    assert.ok(callees.includes('each'));
    assert.ok(callees.includes('srv.Start'));
    assert.ok(callees.includes('stringsutil.ToUpper'));
  });
});

describe('Go: buildGraph の解決', () => {
  test('同一パッケージの兄弟ファイルと import 先パッケージが解析される（_test.go は除外）', async () => {
    const graph = await buildFixtureGraph(['main.go']);

    assert.deepEqual(
      [...graph.analyzedFiles].sort(),
      ['main.go', 'server.go', 'util/reverse.go', 'util/strings.go']
    );
    assert.ok(
      !graph.analyzedFiles.includes('main_test.go'),
      'パッケージ展開で _test.go は取得しない'
    );
    assert.equal(findNode(graph, 'main').inDiff, true);
    assert.equal(findNode(graph, 'NewServer').inDiff, false);
  });

  test('呼び出し解決: 同一ファイル / 同一パッケージ別ファイル / パッケージ import / メソッド', async () => {
    const graph = await buildFixtureGraph(['main.go']);

    assert.ok(hasEdge(graph, 'main', 'buildMessage'), '同一ファイル');
    assert.ok(hasEdge(graph, 'buildMessage', 'NewServer'), '同一パッケージ別ファイル');
    assert.ok(
      hasEdge(graph, 'buildMessage', 'ToUpper'),
      'alias import 経由のパッケージ公開関数 (stringsutil.ToUpper)'
    );
    assert.ok(hasEdge(graph, 'ToUpper', 'trim'), '依存パッケージ内・同一ファイル');
    assert.ok(hasEdge(graph, 'Reverse', 'ToUpper'), '依存パッケージ内・別ファイル');
    assert.ok(
      hasEdge(graph, 'buildMessage', 'Server.log'),
      'パッケージ内で一意なメソッド名 (srv.log)'
    );
    assert.ok(
      hasEdge(graph, 'Server.Start', 'Server.log'),
      'メソッドからのメソッド呼び出し (s.log)'
    );
  });

  test('同名メソッドが複数の型にある呼び出し（srv.Start）は曖昧として未解決扱い', async () => {
    const graph = await buildFixtureGraph(['main.go']);
    assert.ok(!hasEdge(graph, 'buildMessage', 'Server.Start'));
    assert.ok(!hasEdge(graph, 'buildMessage', 'Worker.Start'));
    // fmt.Println / strings.ToUpper / strings.TrimSpace / srv.Start が未解決
    assert.ok(graph.unresolvedCallCount >= 4, `count=${graph.unresolvedCallCount}`);
  });

  test('go.mod がない場合: パッケージ間解決は諦めるが、同一パッケージ内は解決される', async () => {
    const fetchNoGoMod = async (path) =>
      path === 'go.mod' ? { ok: false, reason: 'not_found' } : fetchFixture(path);
    const graph = await buildGraph(analyzer, [{ path: 'main.go' }], fetchNoGoMod, {
      listDir: listFixtureDir,
    });

    assert.ok(!graph.analyzedFiles.includes('util/strings.go'), 'util は辿れない');
    assert.ok(hasEdge(graph, 'buildMessage', 'NewServer'), '同一パッケージは解決される');
    assert.ok(!hasEdge(graph, 'buildMessage', 'ToUpper'));
  });

  test('listDir なし: dir_listing_unavailable が記録され、単一ファイルの解析は続行される', async () => {
    const graph = await buildGraph(analyzer, [{ path: 'main.go' }], fetchFixture, {});
    assert.deepEqual(graph.analyzedFiles, ['main.go']);
    assert.ok(
      graph.skippedFiles.some((s) => s.reason === 'dir_listing_unavailable'),
      JSON.stringify(graph.skippedFiles)
    );
    assert.ok(hasEdge(graph, 'main', 'buildMessage'), '同一ファイルは解決される');
  });

  test('patch から行レベルのコメント可否が Go の関数ノードにも載る', async () => {
    const patch = [
      '@@ -15,2 +15,3 @@',
      ' \tsrv := NewServer()',
      '+\tsrv.Start()',
      ' \tsrv.log("built")',
    ].join('\n');
    const graph = await buildFixtureGraph([{ path: 'main.go', patch }]);

    const build = findNode(graph, 'buildMessage');
    assert.deepEqual(build.commentableLines, [15, 16, 17]);
    assert.equal(build.commentLine, 16, '範囲内の最初の追加行');

    const main = findNode(graph, 'main');
    assert.deepEqual(main.commentableLines, [], 'diff に掛からない関数は不可');
  });

  test('変更ファイルとしての _test.go は解析対象になる', async () => {
    const graph = await buildFixtureGraph(['main_test.go']);
    assert.ok(graph.analyzedFiles.includes('main_test.go'));
    assert.ok(
      hasEdge(graph, 'TestBuildMessage', 'buildMessage'),
      'テスト → 本体（兄弟ファイル）の解決'
    );
  });
});
