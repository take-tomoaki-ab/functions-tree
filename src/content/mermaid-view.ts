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
  /** 下書きのあるノードにマークを付ける。CSS は .has-draft クラスで当てる */
  setDraftMarks(nodeIds: ReadonlySet<string>): void;
  /** グラフの表示倍率を設定する（1 が実寸）。スクロールは呼び出し側が調整する */
  setZoom(scale: number): void;
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

    // ズームの基準サイズ。useMaxWidth: false なので mermaid は width/height 属性に
    // 実寸（px 数値）を出すが、万一欠けていたら bbox から補う。
    // setZoom は width/height 属性だけを倍率で書き換える（viewBox は据え置きなので
    // 中身が等倍で拡縮され、あふれた分は .graph-scroll 側のスクロールで見る）
    const svgEl = container.querySelector('svg');
    const attrSize = (name: 'width' | 'height'): number => {
      const v = Number(svgEl?.getAttribute(name));
      return Number.isFinite(v) && v > 0 ? v : 0;
    };
    let baseWidth = attrSize('width');
    let baseHeight = attrSize('height');
    if (svgEl && (baseWidth <= 0 || baseHeight <= 0)) {
      const bbox = svgEl.getBBox();
      baseWidth = baseWidth > 0 ? baseWidth : bbox.width;
      baseHeight = baseHeight > 0 ? baseHeight : bbox.height;
    }

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

    // 選択・下書きの強調は箱（shape）のインラインスタイル（priority: important）で当てる。
    // classDef の色は mermaid が SVG 内 <style> に `#svgId .クラス名` + !important で
    // 埋め込むため、Shadow DOM 側の CSS は specificity（ID セレクタ）で勝てない。
    // クラス（.selected / .has-draft）も付与するのは、状態の検査（E2E）と
    // 将来レンダラーを差し替えたときの CSS フォールバックのため。
    let selectedId: string | null = null;
    let draftIds: ReadonlySet<string> = new Set();
    const applyHighlights = (): void => {
      for (const [graphId, el] of elementByGraphId) {
        const isSelected = graphId === selectedId;
        const hasDraft = draftIds.has(graphId);
        el.classList.toggle('selected', isSelected);
        el.classList.toggle('has-draft', hasDraft);
        const shape = el.querySelector<SVGGraphicsElement>('rect, polygon, path');
        if (!shape) continue;
        if (isSelected || hasDraft) {
          // 選択（青）が下書きマーク（オレンジ）より優先
          shape.style.setProperty('stroke', isSelected ? '#0969da' : '#bc4c00', 'important');
          shape.style.setProperty('stroke-width', '3px', 'important');
          shape.style.setProperty('stroke-dasharray', 'none', 'important');
        } else {
          // classDef 由来の色は <style> ブロック側にあるので、外せば元の見た目に戻る
          shape.style.removeProperty('stroke');
          shape.style.removeProperty('stroke-width');
          shape.style.removeProperty('stroke-dasharray');
        }
      }
    };

    return {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      setSelected(nodeId: string | null): void {
        selectedId = nodeId;
        applyHighlights();
      },
      setDraftMarks(nodeIds: ReadonlySet<string>): void {
        draftIds = nodeIds;
        applyHighlights();
      },
      setZoom(scale: number): void {
        if (!svgEl || baseWidth <= 0 || baseHeight <= 0) return;
        svgEl.setAttribute('width', String(baseWidth * scale));
        svgEl.setAttribute('height', String(baseHeight * scale));
      },
    };
  }
}

/** panel.ts が動的 import 後に呼ぶファクトリ */
export function createRenderer(): GraphRenderer {
  return new MermaidRenderer();
}
