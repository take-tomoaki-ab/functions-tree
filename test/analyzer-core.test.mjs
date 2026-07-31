// analyzer-core のユニットテスト。GitHub API を使わず、フィクスチャ（test/fixtures/ の
// 小さな TS プロジェクト）に対してパース → 抽出 → グラフ組み立てを Node 上で検証する。
// 実行前に pretest（esbuild）が dist-test/analyzer-core.mjs を生成する。

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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
    // Node では runtimeWasm 省略で web-tree-sitter 同梱の wasm が解決される。
    // TS のテストなので typescript / tsx の文法だけ渡す（他言語は解析不可でよい）
    grammars: {
      typescript: join(grammarDir, 'tree-sitter-typescript.wasm'),
      tsx: join(grammarDir, 'tree-sitter-tsx.wasm'),
    },
  });
});

/**
 * フィクスチャディレクトリをリポジトリのルートに見立てた取得手段。
 * listDir は SW の contents API 相当（候補をこれで絞って 404 プローブを避ける = issue #27 A）
 */
function fixtureIO(root) {
  return {
    fetchFile: async (path) => {
      try {
        return { ok: true, content: await readFile(join(root, path), 'utf8') };
      } catch {
        return { ok: false, reason: 'not_found' };
      }
    },
    listDir: async (dir) => {
      try {
        const entries = await readdir(join(root, dir), { withFileTypes: true });
        return {
          ok: true,
          paths: entries
            .filter((e) => e.isFile())
            .map((e) => (dir === '' ? e.name : `${dir}/${e.name}`)),
        };
      } catch {
        return { ok: false, reason: 'not_found' };
      }
    },
  };
}

const { fetchFile: fetchFixture, listDir: listFixtureDir } = fixtureIO(fixturesDir);

/** 変更ファイルはパス文字列 or { path, patch } で指定できるようにする */
async function buildFixtureGraph(changedFiles, options) {
  const inputs = changedFiles.map((f) => (typeof f === 'string' ? { path: f } : f));
  return buildGraph(analyzer, inputs, fetchFixture, {
    listDir: listFixtureDir,
    ...options,
  });
}

/** tsconfig paths を持つ別リポジトリ（test/fixtures-alias）でグラフを組む（issue #28 G） */
async function buildAliasGraph(changedFiles, options) {
  const io = fixtureIO(join(__dirname, 'fixtures-alias'));
  return buildGraph(
    analyzer,
    changedFiles.map((path) => ({ path })),
    io.fetchFile,
    { listDir: io.listDir, ...options }
  );
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
      typeOnly: false,
    });
    assert.deepEqual(byLocal.get('toUpper'), {
      local: 'toUpper',
      source: './util',
      imported: 'toUpper',
      typeOnly: false,
    });
    assert.deepEqual(byLocal.get('shorten'), {
      local: 'shorten',
      source: './util',
      imported: 'helperFn', // alias の import 先は util 側の公開名
      typeOnly: false,
    });
    assert.deepEqual(byLocal.get('logger'), {
      local: 'logger',
      source: './logger',
      imported: '*',
      typeOnly: false,
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

  test('候補順は .tsx が .ts より先で、index には .jsx も含まれる（issue #27 A）', () => {
    const c = resolveImportCandidates('src/a/b.ts', './card');
    assert.ok(
      c.indexOf('src/a/card.tsx') < c.indexOf('src/a/card.ts'),
      '.tsx を .ts より先に試す'
    );
    assert.ok(c.includes('src/a/card/index.jsx'), 'index.jsx も候補に入る');
  });

  test('../ で親ディレクトリに上がれる', () => {
    const c = resolveImportCandidates('src/a/b.ts', '../shared/x');
    assert.equal(c[0], 'src/shared/x.tsx');
    assert.ok(c.includes('src/shared/x.ts'));
  });

  test('NodeNext 形式 ./x.js は x.tsx / x.ts を優先候補にする', () => {
    const c = resolveImportCandidates('src/a.ts', './x.js');
    assert.deepEqual(c.slice(0, 3), ['src/x.tsx', 'src/x.ts', 'src/x.js']);
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
    const graph = await buildGraph(
      analyzer,
      [{ path: 'app.ts' }, { path: 'huge.ts' }],
      fetchWithError
    );
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

  test('patch から行レベルのコメント可否がノードに載る（推奨行は最初の追加行）', async () => {
    // app.ts の main（9-17 行）に掛かる hunk。RIGHT: 8-10 文脈 / 11 追加 / 12 文脈
    const patch = [
      '@@ -8,4 +8,5 @@',
      ' ',
      ' export function main(): void {',
      "   const message = toUpper('hello');",
      '+  shorten(message);',
      '   logger.write(message);',
    ].join('\n');
    const graph = await buildFixtureGraph([{ path: 'app.ts', patch }]);

    const main = findNode(graph, 'main');
    assert.equal(main.inDiff, true);
    assert.deepEqual(main.commentableLines, [9, 10, 11, 12]);
    assert.equal(main.commentLine, 11, '関数範囲内の最初の追加行');
    assert.equal(main.hasChangedLine, true, '追加行を含むので変更あり（緑）');

    // 変更ファイル内でも、diff に掛からない関数（render: 19-24 行）はコメント不可
    const render = findNode(graph, 'render');
    assert.equal(render.inDiff, true);
    assert.deepEqual(render.commentableLines, []);
    assert.equal(render.commentLine, undefined);
    assert.equal(render.hasChangedLine, false);

    // diff 外の依存ファイル（util.ts）の関数もコメント不可
    const toUpper = findNode(graph, 'toUpper');
    assert.equal(toUpper.inDiff, false);
    assert.deepEqual(toUpper.commentableLines, []);
    assert.equal(toUpper.hasChangedLine, false);
  });

  test('パネルの diff ハイライト用に addedLines / deletedLines がノードに載る', async () => {
    // main（9-17 行）で 11 行目を差し替えた hunk。RIGHT: 9-10 文脈 / 11 追加 / 12 文脈
    const patch = [
      '@@ -8,5 +8,5 @@',
      ' ',
      ' export function main(): void {',
      "-  const message = toUpper('bye');",
      "+  const message = toUpper('hello');",
      '   logger.write(message);',
    ].join('\n');
    const graph = await buildFixtureGraph([{ path: 'app.ts', patch }], {
      dependencyDepth: 0,
    });

    const main = findNode(graph, 'main');
    assert.deepEqual(main.addedLines, [10], '追加行は commentableLines の部分集合');
    assert.ok(main.commentableLines.includes(10));
    assert.deepEqual(main.deletedLines, [
      { beforeLine: 10, text: "  const message = toUpper('bye');" },
    ]);

    // 変更に掛からない関数（render: 19-24 行）は追加行も削除行も持たない
    const render = findNode(graph, 'render');
    assert.deepEqual(render.addedLines, []);
    assert.deepEqual(render.deletedLines, []);
  });

  test('範囲内に追加行がなければ推奨行は文脈行にフォールバックし、差分なしだがコメント可能になる（issue #10 回帰）', async () => {
    // render（19-24 行）に掛かる削除のみの hunk。RIGHT: 20-21 は文脈行
    const patch = [
      '@@ -20,3 +20,2 @@',
      ' function render(): void {',
      '-  // removed comment',
      '   const items = [1, 2, 3].map((n) => toUpper(String(n)));',
    ].join('\n');
    const graph = await buildFixtureGraph([{ path: 'app.ts', patch }], {
      dependencyDepth: 0,
    });
    const render = findNode(graph, 'render');
    assert.deepEqual(render.commentableLines, [20, 21]);
    assert.equal(render.commentLine, 20, '追加行がないので最初の文脈行');
    assert.equal(
      render.hasChangedLine,
      false,
      '差分自体はないので黄（コメント可・差分なし）に分類されるべき'
    );
  });

  test('patch のない変更ファイル（バイナリ / 巨大）は全関数がコメント不可', async () => {
    const graph = await buildFixtureGraph(['app.ts'], { dependencyDepth: 0 });
    for (const node of graph.nodes) {
      assert.deepEqual(node.commentableLines, []);
      assert.equal(node.commentLine, undefined);
      assert.equal(node.hasChangedLine, false);
      assert.deepEqual(node.addedLines, []);
      assert.deepEqual(node.deletedLines, []);
    }
  });

  test('ノード ID は filePath#name@startLine 形式で一意', async () => {
    const graph = await buildFixtureGraph(['app.ts', 'store.ts']);
    const ids = graph.nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length);
    const main = findNode(graph, 'main');
    assert.equal(main.id, `app.ts#main@${main.startLine}`);
  });
});

// issue #12: `<Component />` という JSX での関数コンポーネント呼び出しが
// 依存として扱われていなかった（call_expression しか拾っていなかった）
describe('JSX: 関数コンポーネントの呼び出し', () => {
  test('自己閉じ / 開始終了ペア / メンバー形式を呼び出しとして拾う', async () => {
    const content = (await fetchFixture('page.tsx')).content;
    const a = analyzer.analyzeFile('page.tsx', content);

    const page = a.functions.find((f) => f.name === 'Page');
    const callees = page.calls.map((c) => c.callee);
    assert.ok(callees.includes('Layout'), '<Layout>...</Layout>');
    assert.ok(callees.includes('UI.Panel'), '<UI.Panel />');
    assert.ok(callees.includes('Card'), '<Card>...</Card>');
    assert.ok(callees.includes('CardTitle'), '<CardTitle />');
    assert.ok(callees.includes('toUpper'), '通常の関数呼び出しも引き続き拾う');
  });

  test('終了タグは二重に数えない（<Card>...</Card> は 2 回の参照で 2 件）', async () => {
    const content = (await fetchFixture('page.tsx')).content;
    const a = analyzer.analyzeFile('page.tsx', content);
    const callees = a.functions.find((f) => f.name === 'Page').calls;
    // <Card>...</Card> と .map 内の <Card /> で 2 件（終了タグを数えれば 3 件になる）
    assert.equal(callees.filter((c) => c.callee === 'Card').length, 2);
    assert.equal(callees.filter((c) => c.callee === 'Layout').length, 1);
  });

  test('組み込み要素・Fragment・名前空間タグは呼び出しにしない', async () => {
    const content = (await fetchFixture('page.tsx')).content;
    const a = analyzer.analyzeFile('page.tsx', content);
    const callees = a.functions.find((f) => f.name === 'Page').calls.map((c) => c.callee);
    for (const intrinsic of ['div', 'main', 'section', 'h2', 'h3']) {
      assert.ok(!callees.includes(intrinsic), `組み込み要素 ${intrinsic} は対象外`);
    }
    assert.ok(!callees.some((c) => c === ''), 'Fragment は対象外');
  });

  test('呼び出し行は要素名の行を指す', async () => {
    const content = (await fetchFixture('page.tsx')).content;
    const a = analyzer.analyzeFile('page.tsx', content);
    const panel = a.functions
      .find((f) => f.name === 'Page')
      .calls.find((c) => c.callee === 'UI.Panel');
    assert.equal(content.split('\n')[panel.line - 1].includes('<UI.Panel'), true);
  });

  test('JSX 呼び出しがグラフのエッジになる（default / named / namespace import）', async () => {
    const graph = await buildFixtureGraph(['page.tsx']);

    assert.deepEqual(
      [...graph.analyzedFiles].sort(),
      ['card.tsx', 'layout.tsx', 'page.tsx', 'ui.tsx', 'util.ts']
    );
    assert.ok(hasEdge(graph, 'Page', 'Layout'), 'default import の <Layout>');
    assert.ok(hasEdge(graph, 'Page', 'Card'), 'named import の <Card>');
    assert.ok(hasEdge(graph, 'Page', 'CardTitle'), 'named import の <CardTitle />');
    assert.ok(hasEdge(graph, 'Page', 'Panel'), 'namespace import の <UI.Panel />');
    assert.ok(hasEdge(graph, 'Page', 'toUpper'), '通常の関数呼び出し');
  });

  test('.jsx ファイルでも JSX 呼び出しがエッジになる', async () => {
    const graph = await buildFixtureGraph(['legacy.jsx']);
    assert.ok(hasEdge(graph, 'Legacy', 'Card'));
  });

  test('JSX を含まない TS ファイルの解析結果は変わらない', async () => {
    const content = (await fetchFixture('util.ts')).content;
    const a = analyzer.analyzeFile('util.ts', content);
    assert.deepEqual(
      a.functions.find((f) => f.name === 'helper').calls.map((c) => c.callee),
      ['trim']
    );
  });
});

describe('issue #27: 連結の安定性', () => {
  const CHILDREN = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];

  test('A: 6 子のディレクトリ import が import 順によらず全件連結される', async () => {
    for (const [parentFile, parentFn] of [
      ['many/parent.tsx', 'Parent'],
      ['many/parent-reversed.tsx', 'ParentReversed'],
    ]) {
      const graph = await buildFixtureGraph([parentFile]);
      const missing = CHILDREN.filter((c) => !hasEdge(graph, parentFn, c));
      assert.deepEqual(missing, [], `${parentFile}: 連結されない子がある`);
      assert.deepEqual(
        graph.skippedFiles,
        [],
        `${parentFile}: スキップは発生しないはず`
      );
    }
  });

  test('A: index.jsx のディレクトリ import も解決される（#24 ×-6 の回帰）', async () => {
    const graph = await buildFixtureGraph(['many/parent.tsx']);
    assert.ok(graph.analyzedFiles.includes('many/c5/index.jsx'));
  });

  test('A: ディレクトリ一覧で候補を絞るので fetch 予算をほとんど使わない', async () => {
    let fetches = 0;
    const countingFetch = async (path) => {
      fetches++;
      return fetchFixture(path);
    };
    let listings = 0;
    const countingList = async (dir) => {
      listings++;
      return listFixtureDir(dir);
    };
    const graph = await buildGraph(
      analyzer,
      [{ path: 'many/parent.tsx' }],
      countingFetch,
      { listDir: countingList }
    );
    assert.equal(graph.analyzedFiles.length, 7, '親 + 子 6 件');
    // 親 1 + 子 6 = 7 回のファイル取得 + tsconfig.json 1 回（issue #28 G の prepare）。
    // 404 プローブは 0 回
    assert.equal(fetches, 8);
    // many/ と many/cN の 7 ディレクトリ。同じディレクトリは 1 回だけ
    assert.equal(listings, 7);
  });

  test('A: 型だけの import は依存として取得しない', async () => {
    const graph = await buildFixtureGraph(['types/parent.tsx']);
    assert.ok(
      !graph.analyzedFiles.includes('types/props.ts'),
      'import type だけの source は取得しない'
    );
    assert.ok(
      graph.analyzedFiles.includes('types/badge.tsx'),
      '同じ source を値としても import していれば取得する'
    );
    assert.ok(hasEdge(graph, 'Parent', 'Badge'));
  });

  test('A: import type の束縛は typeOnly として抽出される', async () => {
    const content = (await fetchFixture('types/parent.tsx')).content;
    const a = analyzer.analyzeFile('types/parent.tsx', content);
    const byLocal = Object.fromEntries(a.imports.map((b) => [b.local, b.typeOnly]));
    assert.equal(byLocal.Props, true, 'import type 文');
    assert.equal(byLocal.Variant, true, 'インラインの type specifier');
    assert.equal(byLocal.Badge, false, '値の import');
  });

  test('B: fetch 予算切れが dependency_fetch_limit として記録される', async () => {
    const graph = await buildFixtureGraph(['many/parent.tsx'], {
      maxDependencyFetches: 4,
    });
    const limited = graph.skippedFiles.filter(
      (s) => s.reason === 'dependency_fetch_limit'
    );
    assert.ok(limited.length > 0, '予算切れが記録される');
    // 同じパスを何度も積まない
    const paths = limited.map((s) => s.path);
    assert.equal(new Set(paths).size, paths.length);
  });

  test('C: ネストした同名 const があっても import した本物にエッジが張られる', async () => {
    const graph = await buildFixtureGraph(['scope/parent.tsx']);
    const parent = graph.nodes.find((n) => n.name === 'Parent');
    const realCard = graph.nodes.find(
      (n) => n.name === 'Card' && n.filePath === 'scope/card.tsx'
    );
    const localCard = graph.nodes.find(
      (n) => n.name === 'Card' && n.filePath === 'scope/parent.tsx'
    );
    assert.ok(realCard, 'import 先の Card がノード化されている');
    assert.ok(localCard, 'ネストしたローカル Card もノードとしては残る');
    assert.ok(
      graph.edges.some((e) => e.from === parent.id && e.to === realCard.id),
      'Parent → 本物の Card'
    );
    assert.ok(
      !graph.edges.some((e) => e.from === parent.id && e.to === localCard.id),
      'Parent → ネストしたローカル Card は張らない'
    );
  });

  test('C: ネスト定義しか候補が無ければ従来どおり解決される', async () => {
    const content = (await fetchFixture('app.ts')).content;
    const a = analyzer.analyzeFile('app.ts', content);
    // app.ts の render / main はトップレベル。ネスト判定が誤爆していないこと
    assert.equal(a.functions.find((f) => f.name === 'render').isNested, false);
    const graph = await buildFixtureGraph(['app.ts']);
    assert.ok(hasEdge(graph, 'main', 'render'));
  });
});

describe('issue #28: 検知漏れパターン', () => {
  describe('D: barrel / re-export の解決', () => {
    test('名前付き re-export・export * ・多段 barrel のいずれでも親子が連結される', async () => {
      const graph = await buildFixtureGraph(['barrel/parent.tsx']);
      assert.ok(hasEdge(graph, 'Parent', 'Card'), "export { Card } from './card'");
      assert.ok(hasEdge(graph, 'Parent', 'Badge'), "export * from './badge'");
      assert.ok(hasEdge(graph, 'Parent', 'Chip'), 'barrel → barrel → 実体');
    });

    test('barrel は深さに数えないので、深さ 1 のまま実体まで届く', async () => {
      const graph = await buildFixtureGraph(['barrel/parent.tsx']);
      assert.deepEqual(
        [...graph.analyzedFiles].sort(),
        [
          'barrel/components/badge.tsx',
          'barrel/components/card.tsx',
          'barrel/components/chip/chip.tsx',
          'barrel/components/chip/index.ts',
          'barrel/components/index.ts',
          'barrel/parent.tsx',
        ]
      );
      assert.deepEqual(graph.skippedFiles, []);
      assert.equal(graph.unresolvedCallCount, 0);
    });

    test('barrel の型だけの re-export は依存として取得しない', async () => {
      const graph = await buildFixtureGraph(['barrel/parent.tsx']);
      assert.ok(!graph.analyzedFiles.includes('barrel/components/props.ts'));
    });

    test('re-export は reExports として抽出され、自ファイルの関数にはならない', async () => {
      const path = 'barrel/components/index.ts';
      const a = analyzer.analyzeFile(path, (await fetchFixture(path)).content);
      assert.deepEqual(a.functions, [], 'barrel 自身は関数を持たない');
      assert.deepEqual(a.reExports, [
        { exported: 'Card', imported: 'Card', source: './card', typeOnly: false },
        { exported: '*', imported: '*', source: './badge', typeOnly: false },
        { exported: '*', imported: '*', source: './chip', typeOnly: false },
        {
          exported: 'CardProps',
          imported: 'CardProps',
          source: './props',
          typeOnly: true,
        },
      ]);
    });

    test('dependencyDepth: 0 なら barrel も辿らない', async () => {
      const graph = await buildFixtureGraph(['barrel/parent.tsx'], {
        dependencyDepth: 0,
      });
      assert.deepEqual(graph.analyzedFiles, ['barrel/parent.tsx']);
    });
  });

  describe('E: HOC / memo / forwardRef ラップ', () => {
    test('memo / forwardRef / HOC ラップの子がノード化されエッジが張られる', async () => {
      const graph = await buildFixtureGraph(['wrap/parent.tsx']);
      assert.ok(hasEdge(graph, 'Parent', 'Card'), 'memo(function ...)');
      assert.ok(hasEdge(graph, 'Parent', 'Input'), 'forwardRef((p, ref) => ...)');
      assert.ok(
        hasEdge(graph, 'Parent', 'Panel'),
        'export default withRouter(Panel)（識別子を包む HOC）'
      );
    });

    test('export default memo(Card) 形式は包まれた識別子に default が付く', async () => {
      const path = 'wrap/panel.tsx';
      const a = analyzer.analyzeFile(path, (await fetchFixture(path)).content);
      assert.equal(a.functions.find((f) => f.name === 'Panel').exportName, 'default');
    });

    test('ラップされた関数本体の呼び出しはラップ側のノードに帰属する', async () => {
      const graph = await buildFixtureGraph(['wrap/parent.tsx', 'wrap/card.tsx']);
      assert.ok(hasEdge(graph, 'Card', 'Row'), 'memo で包んだ本体の <Row /> も辿れる');
      assert.equal(graph.unresolvedCallCount, 0);
    });

    test('関数を包まない呼び出し・大文字定数はノード化しない', async () => {
      const path = 'wrap/plain.ts';
      const a = analyzer.analyzeFile(path, (await fetchFixture(path)).content);
      assert.deepEqual(
        a.functions.map((f) => f.name),
        ['createConfig'],
        'Config（オブジェクト内のコールバック）も EXTENSIONS（定数）も関数ではない'
      );
    });

    test('小文字始まりの高階呼び出しは従来どおり外側の関数に帰属する（回帰）', async () => {
      const a = analyzer.analyzeFile('app.ts', (await fetchFixture('app.ts')).content);
      const render = a.functions.find((f) => f.name === 'render');
      assert.ok(
        render.calls.some((c) => c.callee === 'toUpper'),
        'items.map((n) => toUpper(...)) は render に帰属したまま'
      );
      assert.ok(!a.functions.some((f) => f.name === 'items'));
    });
  });

  describe('F: class コンポーネント', () => {
    test('class 名でノード化され、<Panel /> が解決される', async () => {
      const graph = await buildFixtureGraph(['cls/parent.tsx']);
      const parent = findNode(graph, 'Parent');
      assert.equal(parent.kind, 'class_declaration');
      assert.equal(parent.exportName, 'Parent', 'export class Foo');
      const panel = findNode(graph, 'Panel');
      assert.equal(panel.exportName, 'default', 'export default class Foo');
      assert.ok(hasEdge(graph, 'Parent', 'Panel'));
    });

    test('render() の呼び出しは class ノードに帰属し、render ノードは作られない', async () => {
      const graph = await buildFixtureGraph(['cls/parent.tsx', 'cls/panel.tsx']);
      assert.ok(!findNode(graph, 'render'), 'render ノードは class に畳まれる');
      assert.ok(hasEdge(graph, 'Panel', 'Card'), 'render 内の <Card /> は Panel の子');
    });

    test('render 以外のメソッドは従来どおり独立ノードで this 呼び出しも解決される', async () => {
      const graph = await buildFixtureGraph(['cls/parent.tsx']);
      const helper = findNode(graph, 'helper');
      assert.equal(helper.kind, 'method_definition');
      assert.ok(hasEdge(graph, 'Parent', 'helper'), 'render 内の this.helper()');
    });

    test('コンポーネントでない class もノード化されるがメソッドは残る（回帰）', async () => {
      const graph = await buildFixtureGraph(['store.ts'], { dependencyDepth: 0 });
      assert.equal(findNode(graph, 'Cache').kind, 'class_declaration');
      assert.ok(hasEdge(graph, 'refresh', 'load'), 'this.load() は従来どおり');
    });
  });

  describe('G: tsconfig paths エイリアス', () => {
    test('@/* エイリアスの import で親子が連結される', async () => {
      const graph = await buildAliasGraph(['src/app/page.tsx']);
      assert.ok(hasEdge(graph, 'Page', 'Card'), '@/components/Card');
      assert.ok(hasEdge(graph, 'Page', 'Badge'), '~components/Badge');
      assert.deepEqual(graph.skippedFiles, []);
    });

    test('エイリアスに当たらない外部パッケージは取得しない', async () => {
      const graph = await buildAliasGraph(['src/app/page.tsx']);
      assert.deepEqual(
        [...graph.analyzedFiles].sort(),
        ['src/app/page.tsx', 'src/components/Badge.tsx', 'src/components/Card.tsx']
      );
    });

    test('tsconfig.json が無いリポジトリでは非相対 import を解決しない（回帰）', async () => {
      // test/fixtures には tsconfig.json が無い。'react' 等は候補 0 件で取得されない
      const graph = await buildFixtureGraph(['wrap/card.tsx']);
      assert.ok(!graph.analyzedFiles.some((p) => p.includes('react')));
      assert.deepEqual(graph.skippedFiles, []);
    });
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
