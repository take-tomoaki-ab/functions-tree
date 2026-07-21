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

/** inDiff ノードに付ける mermaid クラス名（SVG の g.node にもこのクラスが付く） */
export const NODE_CLASS_IN_DIFF = 'inDiff';
/** diff 外の依存先ノードに付ける mermaid クラス名 */
export const NODE_CLASS_DEPENDENCY = 'dep';

// htmlLabels: false でも mermaid は <br/> だけは改行として解釈するため、
// ラベル本文は実体参照でエスケープした上で <br/> を挟む
function escapeLabel(text: string): string {
  return text
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');
}

function shortFileName(filePath: string): string {
  const base = filePath.split('/').pop();
  return base && base.length > 0 ? base : filePath;
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

  graph.nodes.forEach((node, index) => {
    const mermaidId = `n${index}`;
    mermaidIdOf.set(node.id, mermaidId);
    nodeByMermaidId.set(mermaidId, node);
    const label =
      `${escapeLabel(node.name)}<br/>` +
      `${escapeLabel(shortFileName(node.filePath))}:${node.startLine}`;
    const nodeClass = node.inDiff ? NODE_CLASS_IN_DIFF : NODE_CLASS_DEPENDENCY;
    lines.push(`  ${mermaidId}["${label}"]:::${nodeClass}`);
  });

  for (const edge of graph.edges) {
    const from = mermaidIdOf.get(edge.from);
    const to = mermaidIdOf.get(edge.to);
    if (from && to) lines.push(`  ${from} --> ${to}`);
  }

  lines.push(
    `  classDef ${NODE_CLASS_IN_DIFF} fill:#dafbe1,stroke:#1a7f37,stroke-width:2px,color:#116329`,
    `  classDef ${NODE_CLASS_DEPENDENCY} fill:#f6f8fa,stroke:#8c959f,stroke-dasharray:4 3,color:#57606a`
  );
  return { source: lines.join('\n'), nodeByMermaidId };
}
