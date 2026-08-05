// グラフ JSON → mermaid flowchart 記法への変換と、表示フィルタ。
// mermaid 本体には依存しない純粋ロジックで、Node 上でユニットテストできる
// （test/mermaid-source.test.mjs。pretest が dist-test/ にバンドルする）。

import type { FunctionGraph, GraphNode } from '../shared/graph';

/** グラフの表示絞り込み条件（パネルのトグル UI に対応） */
export interface GraphFilter {
  /** true なら、エッジの端点になっているノードだけ表示する（孤立ノードを隠す） */
  connectedOnly: boolean;
  /** true なら、PR の変更ファイル内 (inDiff) のノードだけ表示する */
  inDiffOnly: boolean;
}

/**
 * フィルタを適用した部分グラフを返す。
 * ノードを絞った結果、端点を失ったエッジも取り除く。
 */
export function filterGraph(
  graph: FunctionGraph,
  filter: GraphFilter
): FunctionGraph {
  let nodes = graph.nodes;
  if (filter.inDiffOnly) {
    nodes = nodes.filter((n) => n.inDiff);
  }
  const kept = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  if (filter.connectedOnly) {
    const connected = new Set<string>();
    for (const e of edges) {
      connected.add(e.from);
      connected.add(e.to);
    }
    nodes = nodes.filter((n) => connected.has(n.id));
  }
  return { ...graph, nodes, edges };
}

export interface MermaidGraphSource {
  /** mermaid flowchart 記法のソーステキスト */
  source: string;
  /** mermaid 側のノード id（n0, n1, ...）→ 元の GraphNode */
  nodeByMermaidId: Map<string, GraphNode>;
}

/** 実際に変更された行を含む関数（コメント可）の mermaid クラス名（SVG の g.node にも付く） */
export const NODE_CLASS_COMMENTABLE = 'commentable';
/**
 * 差分はないが diff コンテキスト内（hunk の文脈行）にありコメント可能な関数のクラス名。
 * GitHub の PR コメント API は文脈行にもコメントできるため、この区分もコメント可能
 */
export const NODE_CLASS_IN_DIFF = 'inDiff';
/** diff 外、または変更ファイル内でも hunk に掛からずコメント不可なノードのクラス名 */
export const NODE_CLASS_DEPENDENCY = 'dep';

/** ノードの表示クラス分け: 変更あり(緑) > 差分なしだがコメント可(黄) > コメント不可(グレー) */
export function nodeClassOf(node: GraphNode): string {
  if (node.hasChangedLine) return NODE_CLASS_COMMENTABLE;
  if (node.commentableLines.length > 0) return NODE_CLASS_IN_DIFF;
  return NODE_CLASS_DEPENDENCY;
}

// htmlLabels: false でも mermaid は <br/> だけは改行として解釈するため、
// ラベル本文は実体参照でエスケープした上で <br/> を挟む
function escapeLabel(text: string): string {
  return text
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');
}

/**
 * 同名ファイル（ベース名が一致する異なるパス）を区別できる最短のディレクトリ接頭辞付きラベルを返す。
 * VSCode のタブ表示と同様、ファイルに近い側のディレクトリから 1 階層ずつ遡り、
 * 他の同名ファイルと区別がつき次第そこで止める（区別に必要な階層数はパスごとに異なりうる）。
 * ベース名が他と重複しないパス、または（同一ファイル内の複数関数のように）
 * 完全に同一のパスしか同じベース名を持たない場合はベース名のみを返す。
 */
export function disambiguateFileLabels(filePaths: string[]): string[] {
  const segmentsOf = (path: string): string[] => path.split('/');

  const indicesByBase = new Map<string, number[]>();
  filePaths.forEach((path, index) => {
    const segments = segmentsOf(path);
    const base = segments[segments.length - 1] ?? path;
    const indices = indicesByBase.get(base);
    if (indices) indices.push(index);
    else indicesByBase.set(base, [index]);
  });

  const labels = new Array<string>(filePaths.length);

  for (const [base, indices] of indicesByBase) {
    const uniquePaths = [...new Set(indices.map((i) => filePaths[i]))];
    if (uniquePaths.length <= 1) {
      for (const i of indices) labels[i] = base;
      continue;
    }

    const dirsOf = new Map(
      uniquePaths.map((path) => {
        const segments = segmentsOf(path);
        return [path, segments.slice(0, segments.length - 1)] as const;
      })
    );
    const depthOf = new Map(uniquePaths.map((path) => [path, 0]));
    const labelForDepth = (path: string): string => {
      const dirs = dirsOf.get(path) ?? [];
      const depth = Math.min(depthOf.get(path) ?? 0, dirs.length);
      const suffix = depth > 0 ? dirs.slice(dirs.length - depth) : [];
      return suffix.length > 0 ? `${suffix.join('/')}/${base}` : base;
    };

    // 区別がつくまで、衝突しているパスだけディレクトリを 1 階層ずつ追加する
    const maxDirs = Math.max(...uniquePaths.map((p) => dirsOf.get(p)?.length ?? 0));
    for (let round = 0; round <= maxDirs; round++) {
      const byLabel = new Map<string, string[]>();
      for (const path of uniquePaths) {
        const label = labelForDepth(path);
        const group = byLabel.get(label);
        if (group) group.push(path);
        else byLabel.set(label, [path]);
      }
      let anyExtended = false;
      for (const group of byLabel.values()) {
        if (group.length <= 1) continue;
        for (const path of group) {
          const dirs = dirsOf.get(path) ?? [];
          const depth = depthOf.get(path) ?? 0;
          if (depth < dirs.length) {
            depthOf.set(path, depth + 1);
            anyExtended = true;
          }
        }
      }
      if (!anyExtended) break;
    }

    const labelOf = new Map(uniquePaths.map((path) => [path, labelForDepth(path)]));
    for (const i of indices) labels[i] = labelOf.get(filePaths[i]) ?? base;
  }

  return labels;
}

/**
 * グラフを mermaid flowchart 記法に変換する。
 * GraphNode.id は `/` `#` `@` を含み mermaid の id に使えないため、
 * 連番 id (n0, n1, ...) に置換し、逆引き Map を添えて返す。
 */
export function buildMermaidSource(graph: FunctionGraph): MermaidGraphSource {
  const lines: string[] = ['flowchart LR'];
  const mermaidIdOf = new Map<string, string>();
  const nodeByMermaidId = new Map<string, GraphNode>();
  const fileLabels = disambiguateFileLabels(graph.nodes.map((n) => n.filePath));

  graph.nodes.forEach((node, index) => {
    const mermaidId = `n${index}`;
    mermaidIdOf.set(node.id, mermaidId);
    nodeByMermaidId.set(mermaidId, node);
    const label =
      `${escapeLabel(node.name)}<br/>` +
      `${escapeLabel(fileLabels[index])}:${node.startLine}`;
    lines.push(`  ${mermaidId}["${label}"]:::${nodeClassOf(node)}`);
  });

  for (const edge of graph.edges) {
    const from = mermaidIdOf.get(edge.from);
    const to = mermaidIdOf.get(edge.to);
    if (from && to) lines.push(`  ${from} --> ${to}`);
  }

  lines.push(
    `  classDef ${NODE_CLASS_COMMENTABLE} fill:#dafbe1,stroke:#1a7f37,stroke-width:2px,color:#116329`,
    `  classDef ${NODE_CLASS_IN_DIFF} fill:#fff8c5,stroke:#9a6700,stroke-width:1px,color:#7d4e00`,
    `  classDef ${NODE_CLASS_DEPENDENCY} fill:#f6f8fa,stroke:#8c959f,stroke-dasharray:4 3,color:#57606a`
  );
  return { source: lines.join('\n'), nodeByMermaidId };
}
