// mermaid-source（グラフ JSON → mermaid 記法変換と表示フィルタ）のユニットテスト。
// mermaid 本体には依存しない純粋ロジックなので Node 上でそのまま検証できる。
// 実行前に pretest（esbuild）が dist-test/mermaid-source.mjs を生成する。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildMermaidSource,
  filterGraph,
  NODE_CLASS_DEPENDENCY,
  NODE_CLASS_IN_DIFF,
} from '../dist-test/mermaid-source.mjs';

/** テスト用の GraphNode を作る（id は Phase 3 の実フォーマットに合わせる） */
function node(name, filePath, startLine, inDiff, extra = {}) {
  return {
    id: `${filePath}#${name}@${startLine}`,
    name,
    filePath,
    startLine,
    endLine: startLine + 3,
    kind: 'function_declaration',
    inDiff,
    sourceText: `function ${name}() {}`,
    ...extra,
  };
}

const a = node('alpha', 'src/a.ts', 1, true);
const b = node('beta', 'src/b.ts', 10, false);
const c = node('gamma', 'src/a.ts', 20, true);
const isolated = node('lonely', 'src/c.ts', 5, false);

const graph = {
  nodes: [a, b, c, isolated],
  edges: [
    { from: a.id, to: b.id, callLine: 2 },
    { from: c.id, to: a.id, callLine: 21 },
  ],
  analyzedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  skippedFiles: [],
  unresolvedCallCount: 0,
};

describe('buildMermaidSource', () => {
  test('ノード id を連番に置換し、逆引き Map で GraphNode を引ける', () => {
    const { source, nodeByMermaidId } = buildMermaidSource(graph);
    // 元 id の `/` `#` `@` が mermaid ソースのノード定義に漏れていないこと
    assert.match(source, /^flowchart LR$/m);
    assert.match(source, /^ {2}n0\["alpha<br\/>a\.ts:1"\]:::inDiff$/m);
    assert.match(source, /^ {2}n1\["beta<br\/>b\.ts:10"\]:::dep$/m);
    assert.equal(nodeByMermaidId.get('n0'), a);
    assert.equal(nodeByMermaidId.get('n3'), isolated);
    assert.equal(nodeByMermaidId.size, 4);
  });

  test('エッジは連番 id 同士で呼び出し方向どおりに張られる', () => {
    const { source } = buildMermaidSource(graph);
    assert.match(source, /^ {2}n0 --> n1$/m);
    assert.match(source, /^ {2}n2 --> n0$/m);
  });

  test('inDiff / dep の classDef が含まれる', () => {
    const { source } = buildMermaidSource(graph);
    assert.match(source, new RegExp(`classDef ${NODE_CLASS_IN_DIFF} `));
    assert.match(source, new RegExp(`classDef ${NODE_CLASS_DEPENDENCY} `));
  });

  test('ラベルの特殊文字（" < > &）は実体参照にエスケープされる', () => {
    const tricky = node('render<T>', 'src/x.ts', 1, true);
    tricky.name = 'say"&<hi>"';
    const { source } = buildMermaidSource({ ...graph, nodes: [tricky], edges: [] });
    assert.ok(source.includes('say#quot;#amp;#lt;hi#gt;#quot;'));
    assert.ok(!source.includes('say"'));
  });
});

describe('filterGraph', () => {
  test('フィルタなしなら全ノード・全エッジを保持する', () => {
    const filtered = filterGraph(graph, { connectedOnly: false, inDiffOnly: false });
    assert.equal(filtered.nodes.length, 4);
    assert.equal(filtered.edges.length, 2);
  });

  test('connectedOnly で孤立ノードだけが除かれる', () => {
    const filtered = filterGraph(graph, { connectedOnly: true, inDiffOnly: false });
    assert.deepEqual(
      filtered.nodes.map((n) => n.name).sort(),
      ['alpha', 'beta', 'gamma']
    );
    assert.equal(filtered.edges.length, 2);
  });

  test('inDiffOnly で diff 外ノードと、端点を失ったエッジが除かれる', () => {
    const filtered = filterGraph(graph, { connectedOnly: false, inDiffOnly: true });
    assert.deepEqual(
      filtered.nodes.map((n) => n.name).sort(),
      ['alpha', 'gamma']
    );
    // a -> b は b が消えるためエッジも消え、c -> a だけ残る
    assert.deepEqual(filtered.edges, [{ from: c.id, to: a.id, callLine: 21 }]);
  });

  test('両方 ON なら inDiff かつエッジのあるノードだけ残る', () => {
    const filtered = filterGraph(graph, { connectedOnly: true, inDiffOnly: true });
    assert.deepEqual(
      filtered.nodes.map((n) => n.name).sort(),
      ['alpha', 'gamma']
    );
  });

  test('全エッジが消えるフィルタでは connectedOnly の結果が空になる', () => {
    const onlyIsolated = { ...graph, nodes: [isolated], edges: [] };
    const filtered = filterGraph(onlyIsolated, { connectedOnly: true, inDiffOnly: false });
    assert.equal(filtered.nodes.length, 0);
    assert.equal(filtered.edges.length, 0);
  });
});
