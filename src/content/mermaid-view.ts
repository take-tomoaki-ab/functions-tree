// GraphRenderer インターフェースと、その mermaid 実装。
//
// - レンダラーは差し替え可能な設計（将来 Cytoscape.js 等へ移行する場合は
//   GraphRenderer を実装した別モジュールを用意し、panel 側の import 先を替えるだけ）。
// - mermaid は minify 後でも約 3MB あるため content.js には静的リンクしない。
//   このモジュールを dist/mermaid-view.js として別バンドル（web_accessible_resources）し、
//   panel.ts が初回描画時に import(chrome.runtime.getURL(...)) で遅延ロードする。
// - ノードクリックは mermaid の click callback（securityLevel: 'loose' が必要で、
//   グローバル関数経由のため Shadow DOM と相性が悪い）ではなく、描画後の SVG の
//   g.node 要素へ直接 addEventListener する方式。securityLevel は 'strict' のまま使える。

import mermaid from 'mermaid';
import type { FunctionGraph, GraphNode } from '../shared/graph';
import { buildMermaidSource } from './mermaid-source';

export interface RenderCallbacks {
  /** ノード（関数）がクリックされたとき */
  onNodeClick: (node: GraphNode) => void;
}

/** 1 回の描画結果へのハンドル */
export interface RenderHandle {
  /** 実際に描画したノード数（フィルタ適用後） */
  nodeCount: number;
  edgeCount: number;
  /** 指定ノードを選択強調する（null で解除）。CSS は .selected クラスで当てる */
  setSelected(nodeId: string | null): void;
}

/** グラフ描画エンジンの抽象。mermaid 以外（Cytoscape.js 等）への差し替え口 */
export interface GraphRenderer {
  render(
    container: HTMLElement,
    graph: FunctionGraph,
    callbacks: RenderCallbacks
  ): Promise<RenderHandle>;
}

let mermaidInitialized = false;
let renderSeq = 0;

function ensureMermaidInitialized(): void {
  if (mermaidInitialized) return;
  // フォントは themeVariables（表示 CSS）とトップレベル fontFamily（レイアウト時の
  // ラベル幅計測）の両方に指定する。揃えないと計測がデフォルトのプロポーショナル
  // フォントで行われ、monospace 表示より狭い箱が作られてラベル末尾が切れる
  const fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily,
    themeVariables: {
      fontFamily,
      fontSize: '13px',
    },
    // useMaxWidth: false で SVG を実寸のまま出し、コンテナ側でスクロールさせる。
    // htmlLabels: true（foreignObject）にしないと SVG テキストの幅計測がずれて
    // ラベル末尾が切れる（securityLevel: 'strict' なので HTML は DOMPurify で無害化される）
    flowchart: { htmlLabels: true, useMaxWidth: false },
  });
  mermaidInitialized = true;
}

/**
 * ラベル切れの補正。mermaid はレイアウト時のラベル幅計測を document.body 上で行うが、
 * GitHub ページ上ではこの計測が実際より狭い値を返し（全ノード一律の幅になる）、
 * ラベル末尾が切れる。描画済み SVG を Shadow DOM に入れた後なら表示コンテキストで
 * 正確に実測できるので、はみ出しているノードの箱と foreignObject を広げて補正する。
 */
function fixClippedLabels(container: HTMLElement): void {
  const svgEl = container.querySelector('svg');
  if (!svgEl) return;
  let adjusted = false;
  for (const nodeG of svgEl.querySelectorAll<SVGGElement>('g.node')) {
    const fo = nodeG.querySelector('foreignObject');
    const label = fo?.querySelector<HTMLElement>('.nodeLabel');
    const rect = nodeG.querySelector<SVGRectElement>('rect');
    const labelG = nodeG.querySelector<SVGGElement>('g.label');
    if (!fo || !label || !rect || !labelG) continue;
    const foWidth = Number(fo.getAttribute('width') ?? 0);
    const needed = Math.ceil(label.getBoundingClientRect().width) + 4;
    if (foWidth <= 0 || needed <= foWidth) continue;
    const delta = needed - foWidth;
    fo.setAttribute('width', String(needed));
    rect.setAttribute('width', String(Number(rect.getAttribute('width') ?? 0) + delta));
    rect.setAttribute('x', String(Number(rect.getAttribute('x') ?? 0) - delta / 2));
    // ラベルの中央揃えを保つため g.label の translate を半分だけ左へ
    const transform = labelG.getAttribute('transform') ?? '';
    const m = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(transform);
    if (m) {
      labelG.setAttribute(
        'transform',
        `translate(${Number(m[1]) - delta / 2}, ${m[2]})`
      );
    }
    adjusted = true;
  }
  if (!adjusted) return;
  // 広げた箱が SVG の端で切れないよう、全体の bbox に合わせて viewBox を張り直す
  const bbox = svgEl.getBBox();
  const pad = 8;
  svgEl.setAttribute(
    'viewBox',
    `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`
  );
  svgEl.setAttribute('width', String(bbox.width + pad * 2));
  svgEl.setAttribute('height', String(bbox.height + pad * 2));
}

/**
 * 矢印マーカーの補正。mermaid の pointEnd マーカーは refX=5（三角形の中心）で
 * パス終端に置かれるが、GitHub ページ上ではエッジ終端座標がノードの箱に
 * 2px ほど食い込んで計算され、三角形の大半が箱の下に隠れて縦棒に見える。
 * refX=10（三角形の先端 = パス終端）に変えると、どちらの環境でも
 * 矢先がノードの縁に刺さる見た目になる。
 */
function fixArrowMarkers(container: HTMLElement): void {
  for (const marker of container.querySelectorAll('marker[id$="pointEnd"]')) {
    marker.setAttribute('refX', '10');
  }
}

class MermaidRenderer implements GraphRenderer {
  async render(
    container: HTMLElement,
    graph: FunctionGraph,
    callbacks: RenderCallbacks
  ): Promise<RenderHandle> {
    ensureMermaidInitialized();
    const { source, nodeByMermaidId } = buildMermaidSource(graph);
    // mermaid.render は一時要素を document.body に作って描画し、SVG 文字列を返す。
    // コンテナを第 3 引数に渡して Shadow DOM 内で描画させることはできない
    // （mermaid 内部の document.querySelector が Shadow DOM を見えず null 参照で落ちる）。
    // 返った SVG は <style> を内包しているので Shadow DOM 内に入れても崩れない
    const { svg } = await mermaid.render(
      `functions-tree-graph-${renderSeq++}`,
      source
    );
    container.innerHTML = svg;
    fixClippedLabels(container);
    fixArrowMarkers(container);

    const elementByGraphId = new Map<string, SVGGElement>();
    for (const el of container.querySelectorAll<SVGGElement>('g.node')) {
      // g.node の id は `flowchart-<mermaidId>-<連番>` 形式
      const match = /-((?:n)\d+)-\d+$/.exec(el.id);
      const node = match ? nodeByMermaidId.get(match[1]) : undefined;
      if (!node) continue;
      elementByGraphId.set(node.id, el);
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => callbacks.onNodeClick(node));
    }

    return {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      setSelected(nodeId: string | null): void {
        for (const [graphId, el] of elementByGraphId) {
          el.classList.toggle('selected', graphId === nodeId);
        }
      },
    };
  }
}

/** panel.ts が動的 import 後に呼ぶファクトリ */
export function createRenderer(): GraphRenderer {
  return new MermaidRenderer();
}
