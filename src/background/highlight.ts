// tree-sitter の構文木からシンタックスハイライトのトークンを抽出する。
// 解析時に構文木は既に手元にあるので、ハイライト専用のライブラリは使わず、
// 言語ごとの小さな設定（HighlightConfig）+ 共通の走査で色付け対象を拾う。
//
// 方針:
// - 文法上のキーワードは anonymous ノード（文法の文字列リテラル）として現れるため、
//   英字のみの anonymous 葉を一律 keyword とみなす（言語ごとの予約語リストが不要になる）
// - 文字列・コメント・数値・型などの named ノードは設定のマッピングで拾う
// - 関数名は「定義ノードの name フィールド」「呼び出しノードの callee フィールド」を塗る
// - どれにも該当しないトークン（識別子・記号）は無装飾のまま

import type { Node } from 'web-tree-sitter';
import type { HighlightKind, HighlightToken } from '../shared/graph';

export interface HighlightConfig {
  /**
   * ノード全体を 1 トークンとして塗る型 → 種別（子には降りない）。
   * 内側に anonymous キーワードを含む型（例: TS の predefined_type の `string`）や、
   * 引用符・内容が子ノードに分かれる文字列（例: Go の interpreted_string_literal）に使う。
   */
  wholeNodeTypes: Record<string, HighlightKind>;
  /** 葉ノードの型 → 種別。anonymous キーワード規則より優先される */
  leafTypes: Record<string, HighlightKind>;
  /** name フィールドを function として塗る定義ノードの型 */
  functionDefTypes: string[];
  /** name フィールドを type として塗る定義ノードの型（Python の class_definition 等） */
  typeDefTypes?: string[];
  /** 呼び出しノードの型と callee のフィールド名。フィールドの識別子を function として塗る */
  calls: Array<{ type: string; field: string }>;
  /**
   * メンバーアクセスのノード型と塗る対象のフィールド名。
   * メンバーアクセスが呼び出しの callee のとき（`obj.method()`）だけ method 側を塗る。
   */
  member?: { type: string; field: string };
}

/** 葉が定義名・呼び出し名なら対応する種別を返す（親のフィールドで判定する） */
function classifyIdentifier(
  node: Node,
  config: HighlightConfig
): HighlightKind | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  const isField = (owner: Node, field: string): boolean =>
    owner.childForFieldName(field)?.id === node.id;

  if (config.functionDefTypes.includes(parent.type) && isField(parent, 'name')) {
    return 'function';
  }
  if (config.typeDefTypes?.includes(parent.type) && isField(parent, 'name')) {
    return 'type';
  }
  for (const call of config.calls) {
    if (parent.type === call.type && isField(parent, call.field)) return 'function';
  }
  // `obj.method()` の method: メンバーアクセス自体が呼び出しの callee のときだけ塗る
  const member = config.member;
  if (member && parent.type === member.type && isField(parent, member.field)) {
    const grand = parent.parent;
    if (
      grand &&
      config.calls.some(
        (c) =>
          grand.type === c.type &&
          grand.childForFieldName(c.field)?.id === parent.id
      )
    ) {
      return 'function';
    }
  }
  return undefined;
}

/** ファイル全体の構文木からハイライトトークンを抽出する（昇順・重複なし） */
export function collectHighlightTokens(
  root: Node,
  config: HighlightConfig
): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const push = (node: Node, kind: HighlightKind): void => {
    if (node.endIndex > node.startIndex) {
      tokens.push([node.startIndex, node.endIndex, kind]);
    }
  };
  const visit = (node: Node): void => {
    const whole = config.wholeNodeTypes[node.type];
    if (whole !== undefined) {
      push(node, whole);
      return;
    }
    if (node.childCount === 0) {
      const mapped = config.leafTypes[node.type];
      if (mapped !== undefined) {
        push(node, mapped);
      } else if (!node.isNamed && /^[A-Za-z_]+$/.test(node.type)) {
        push(node, 'keyword');
      } else {
        const kind = classifyIdentifier(node, config);
        if (kind !== undefined) push(node, kind);
      }
      return;
    }
    for (const child of node.children) {
      if (child) visit(child);
    }
  };
  visit(root);
  return tokens;
}

/**
 * ファイル全体のトークンから関数の文字範囲 [startIndex, endIndex) に収まるものを
 * 切り出し、オフセットを sourceText 基準（関数先頭 = 0）に変換する。
 */
export function tokensForRange(
  tokens: HighlightToken[],
  startIndex: number,
  endIndex: number
): HighlightToken[] {
  const out: HighlightToken[] = [];
  for (const [start, end, kind] of tokens) {
    if (start >= endIndex) break; // 昇順なのでこれ以降は範囲外
    if (start < startIndex || end > endIndex) continue;
    out.push([start - startIndex, end - startIndex, kind]);
  }
  return out;
}
