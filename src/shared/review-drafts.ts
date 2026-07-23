// GitHub pending review（ネイティブの下書きレビュー）まわりの純粋ロジック。
// content の panel が下書きコメントとグラフノードの対応付けに使い、
// background がリクエストボディの組み立て・API 応答のデシリアライズに使う。
// chrome API には依存しない（test/review-drafts.test.mjs で Node 上で検証）。

import type { PendingComment, ReviewCommentInput } from './github';

/** ノードとの対応付けに必要な GraphNode のサブセット */
export interface NodeRef {
  /** GraphNode.id（`path#name@line`） */
  id: string;
  /** リポジトリルートからのファイルパス */
  filePath: string;
  /** レビューコメントを付けられる行（patch の RIGHT サイド）。昇順 */
  commentableLines: readonly number[];
}

/**
 * POST /repos/{owner}/{repo}/pulls/{n}/reviews のリクエストボディを組み立てる。
 * event を省略すると PENDING のレビュー（GitHub ネイティブの下書き）として作られ、
 * submit するまで PR の相手には見えない。pending review が無いときの
 * 「最初の 1 件の下書き追加」= このボディでレビューごと作成する。
 */
export function buildPendingReviewCreateBody(
  commitId: string,
  comment: ReviewCommentInput
): {
  commit_id: string;
  comments: Array<{ path: string; line: number; side: 'RIGHT'; body: string }>;
} {
  return {
    commit_id: commitId,
    comments: [
      { path: comment.path, line: comment.line, side: 'RIGHT', body: comment.body },
    ],
  };
}

/**
 * GraphQL で取得した pending review のコメントノード配列から下書き一覧を復元する。
 * 形が想定と違う要素は黙って捨て、配列でなければ空として扱う。
 * line は outdated コメント等で null のことがある（その場合ノード対応付け不可）。
 */
export function parsePendingComments(raw: unknown): PendingComment[] {
  if (!Array.isArray(raw)) return [];
  const comments: PendingComment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (
      typeof c.id !== 'string' ||
      c.id.length === 0 ||
      typeof c.path !== 'string' ||
      c.path.length === 0 ||
      typeof c.body !== 'string'
    ) {
      continue;
    }
    const line =
      typeof c.line === 'number' && Number.isInteger(c.line) && c.line >= 1
        ? c.line
        : null;
    comments.push({ id: c.id, path: c.path, line, body: c.body });
  }
  return comments;
}

/**
 * ノードに対応する下書きコメントを探す（path が一致しコメント可能行に載っているもの）。
 * 同一ノードに複数マッチする場合は先頭を返す（フォームの編集対象）。
 */
export function findCommentForNode(
  comments: readonly PendingComment[],
  node: NodeRef
): PendingComment | undefined {
  return comments.find(
    (c) =>
      c.line !== null &&
      c.path === node.filePath &&
      node.commentableLines.includes(c.line)
  );
}

/** 下書きマーク（グラフ上の強調）を付けるべきノード ID の集合を求める */
export function draftNodeIds(
  comments: readonly PendingComment[],
  nodes: readonly NodeRef[]
): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (findCommentForNode(comments, node) !== undefined) ids.add(node.id);
  }
  return ids;
}
