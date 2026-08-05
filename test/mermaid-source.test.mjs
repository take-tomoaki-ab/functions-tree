// mermaid-source（グラフ JSON → mermaid 記法変換と表示フィルタ）のユニットテスト。
// mermaid 本体には依存しない純粋ロジックなので Node 上でそのまま検証できる。
// 実行前に pretest（esbuild）が dist-test/mermaid-source.mjs を生成する。

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildMermaidSource,
  disambiguateFileLabels,
  filterGraph,
  NODE_CLASS_COMMENTABLE,
  NODE_CLASS_DEPENDENCY,
  NODE_CLASS_IN_DIFF,
  nodeClassOf,
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
    commentableLines: [],
    hasChangedLine: false,
    sourceText: `function ${name}() {}`,
    ...extra,
  };
}

// a はコメント可（変更あり）、c は変更ファイル内で関数無変更だが diff コンテキスト内で
// コメント可能（issue #10: 黄色ノードもコメント可能であるべき）、b / isolated は diff 外
const a = node('alpha', 'src/a.ts', 1, true, {
  commentableLines: [2, 3],
  commentLine: 2,
  hasChangedLine: true,
});
const b = node('beta', 'src/b.ts', 10, false);
const c = node('gamma', 'src/a.ts', 20, true, {
  commentableLines: [21],
  commentLine: 21,
  hasChangedLine: false,
});
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
    assert.match(source, /^ {2}n0\["alpha<br\/>a\.ts:1"\]:::commentable$/m);
    assert.match(source, /^ {2}n1\["beta<br\/>b\.ts:10"\]:::dep$/m);
    assert.match(source, /^ {2}n2\["gamma<br\/>a\.ts:20"\]:::inDiff$/m);
    assert.equal(nodeByMermaidId.get('n0'), a);
    assert.equal(nodeByMermaidId.get('n3'), isolated);
    assert.equal(nodeByMermaidId.size, 4);
  });

  test('エッジは連番 id 同士で呼び出し方向どおりに張られる', () => {
    const { source } = buildMermaidSource(graph);
    assert.match(source, /^ {2}n0 --> n1$/m);
    assert.match(source, /^ {2}n2 --> n0$/m);
  });

  test('commentable / inDiff / dep の classDef が含まれる', () => {
    const { source } = buildMermaidSource(graph);
    assert.match(source, new RegExp(`classDef ${NODE_CLASS_COMMENTABLE} `));
    assert.match(source, new RegExp(`classDef ${NODE_CLASS_IN_DIFF} `));
    assert.match(source, new RegExp(`classDef ${NODE_CLASS_DEPENDENCY} `));
  });

  test('nodeClassOf: 変更あり(緑) > 差分なしだがコメント可(黄) > コメント不可(グレー) の優先で分類する', () => {
    assert.equal(nodeClassOf(a), NODE_CLASS_COMMENTABLE);
    assert.equal(nodeClassOf(c), NODE_CLASS_IN_DIFF);
    assert.equal(nodeClassOf(b), NODE_CLASS_DEPENDENCY);
  });

  test('nodeClassOf: 黄色（差分なしだがコメント可能）ノードは commentableLines が非空（issue #10 回帰）', () => {
    assert.equal(nodeClassOf(c), NODE_CLASS_IN_DIFF);
    assert.ok(c.commentableLines.length > 0, '黄色ノードはコメント可能でなければならない');
  });

  test('nodeClassOf: 変更ファイル内でも hunk に一切掛からない関数はコメント不可のグレー扱い', () => {
    const untouched = node('delta', 'src/a.ts', 100, true, {
      commentableLines: [],
      hasChangedLine: false,
    });
    assert.equal(nodeClassOf(untouched), NODE_CLASS_DEPENDENCY);
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

describe('disambiguateFileLabels', () => {
  test('同名ファイルがなければファイル名のみを返す', () => {
    const labels = disambiguateFileLabels(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.deepEqual(labels, ['a.ts', 'b.ts', 'c.ts']);
  });

  test('同一ファイル内の複数関数（filePath が完全一致）はファイル名のみを返す', () => {
    const labels = disambiguateFileLabels(['src/a.ts', 'src/a.ts', 'src/b.ts']);
    assert.deepEqual(labels, ['a.ts', 'a.ts', 'b.ts']);
  });

  test('同名ファイル2件は、差が出る直近のディレクトリまで遡って表示する（issue #26 の例）', () => {
    const labels = disambiguateFileLabels(['a/components/index.tsx', 'b/components/index.tsx']);
    assert.deepEqual(labels, ['a/components/index.tsx', 'b/components/index.tsx']);
  });

  test('中間ディレクトリが同名でも、直近1階層で区別がつけばそこで止める', () => {
    const labels = disambiguateFileLabels(['src/foo/bar.ts', 'src/baz/bar.ts', 'test/bar.ts']);
    assert.deepEqual(labels, ['foo/bar.ts', 'baz/bar.ts', 'test/bar.ts']);
  });

  test('3件以上の同名ファイルは、衝突しているものだけ追加でディレクトリを遡る', () => {
    const labels = disambiguateFileLabels([
      'a/x/index.tsx',
      'b/x/index.tsx',
      'c/y/index.tsx',
    ]);
    assert.deepEqual(labels, ['a/x/index.tsx', 'b/x/index.tsx', 'y/index.tsx']);
  });

  test('深さの異なる同名ファイルは、浅い側は自身の全ディレクトリで打ち止めになる', () => {
    const labels = disambiguateFileLabels(['a/index.tsx', 'a/b/index.tsx']);
    assert.deepEqual(labels, ['a/index.tsx', 'b/index.tsx']);
  });

  test('深さの異なる同名ファイルで浅い側がルート直下（ディレクトリなし）の場合', () => {
    const labels = disambiguateFileLabels(['index.tsx', 'src/index.tsx']);
    assert.deepEqual(labels, ['index.tsx', 'src/index.tsx']);
  });

  test('components/index.tsx パターン: 同名複数でも別グループの同名は独立して解決する', () => {
    const labels = disambiguateFileLabels([
      'a/components/index.tsx',
      'b/components/index.tsx',
      'x/utils/helper.ts',
      'y/utils/helper.ts',
    ]);
    assert.deepEqual(labels, [
      'a/components/index.tsx',
      'b/components/index.tsx',
      'x/utils/helper.ts',
      'y/utils/helper.ts',
    ]);
  });

  test('入力順やインデックスに依存せず、各要素に対応するラベルを返す', () => {
    const labels = disambiguateFileLabels([
      'src/b.ts',
      'a/components/index.tsx',
      'b/components/index.tsx',
      'src/a.ts',
    ]);
    assert.deepEqual(labels, [
      'b.ts',
      'a/components/index.tsx',
      'b/components/index.tsx',
      'a.ts',
    ]);
  });
});

describe('buildMermaidSource: 同名ファイルの区別表示（issue #26）', () => {
  test('同名ファイルが複数あるノードは、区別がつくディレクトリ接頭辞付きでラベル表示される', () => {
    const dup1 = node('render', 'a/components/index.tsx', 1, false);
    const dup2 = node('render', 'b/components/index.tsx', 1, false);
    const unique = node('helper', 'src/util.ts', 5, false);
    const { source } = buildMermaidSource({
      nodes: [dup1, dup2, unique],
      edges: [],
      analyzedFiles: [],
      skippedFiles: [],
      unresolvedCallCount: 0,
    });
    assert.match(source, /^ {2}n0\["render<br\/>a\/components\/index\.tsx:1"\]/m);
    assert.match(source, /^ {2}n1\["render<br\/>b\/components\/index\.tsx:1"\]/m);
    assert.match(source, /^ {2}n2\["helper<br\/>util\.ts:5"\]/m);
  });
});
