// レビュー下書きキューの純粋ロジック。
// content の panel が状態管理・chrome.storage.session への退避に使い、
// background が SUBMIT_REVIEW のリクエストボディ組み立てに使う。
// chrome API には依存しない（test/review-drafts.test.mjs で Node 上で検証）。

import type { ReviewCommentInput } from './github';

/** ノード 1 つに対するレビューコメントの下書き（送信するまでローカルに保持） */
export interface ReviewDraft {
  /** 対象ノードの GraphNode.id（`path#name@line`）。同一ノードの下書きは 1 つ */
  nodeId: string;
  /** 一覧表示用の関数名 */
  nodeName: string;
  /** リポジトリルートからのファイルパス */
  path: string;
  /** RIGHT サイドの行番号（1 始まり） */
  line: number;
  /** コメント本文（Markdown） */
  body: string;
}

/**
 * chrome.storage.session 上のキー。PR ごとに別の下書きキューを持つ
 * （別 PR を開いたときに他 PR の下書きが混ざらない）。
 */
export function draftStorageKey(pr: { owner: string; repo: string; pr: number }): string {
  return `reviewDrafts:${pr.owner}/${pr.repo}#${pr.pr}`;
}

/** 下書きを追加する。同一ノードの下書きがあれば位置を保ったまま置き換える（編集） */
export function upsertDraft(
  drafts: readonly ReviewDraft[],
  draft: ReviewDraft
): ReviewDraft[] {
  const index = drafts.findIndex((d) => d.nodeId === draft.nodeId);
  if (index < 0) return [...drafts, draft];
  const next = [...drafts];
  next[index] = draft;
  return next;
}

/** 指定ノードの下書きを取り除く（なければそのままのコピーを返す） */
export function removeDraft(
  drafts: readonly ReviewDraft[],
  nodeId: string
): ReviewDraft[] {
  return drafts.filter((d) => d.nodeId !== nodeId);
}

/** 指定ノードの下書きを探す */
export function findDraft(
  drafts: readonly ReviewDraft[],
  nodeId: string
): ReviewDraft | undefined {
  return drafts.find((d) => d.nodeId === nodeId);
}

/**
 * storage から読み戻した値を検証つきでデシリアライズする。
 * 形が想定と違う要素（拡張の旧バージョンが書いた値など）は黙って捨て、
 * 配列でなければ空のキューとして扱う。
 */
export function parseDrafts(raw: unknown): ReviewDraft[] {
  if (!Array.isArray(raw)) return [];
  const drafts: ReviewDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    if (
      typeof d.nodeId === 'string' &&
      d.nodeId.length > 0 &&
      typeof d.nodeName === 'string' &&
      typeof d.path === 'string' &&
      d.path.length > 0 &&
      typeof d.line === 'number' &&
      Number.isInteger(d.line) &&
      d.line >= 1 &&
      typeof d.body === 'string' &&
      d.body.trim().length > 0
    ) {
      drafts.push({
        nodeId: d.nodeId,
        nodeName: d.nodeName,
        path: d.path,
        line: d.line,
        body: d.body,
      });
    }
  }
  return drafts;
}

/**
 * POST /repos/{owner}/{repo}/pulls/{n}/reviews のリクエストボディを組み立てる。
 * event: 'COMMENT' で、全コメントが 1 つのレビューとしてまとめて投稿される。
 */
export function buildReviewRequestBody(
  commitId: string,
  comments: readonly ReviewCommentInput[]
): {
  commit_id: string;
  event: 'COMMENT';
  comments: Array<{ path: string; line: number; side: 'RIGHT'; body: string }>;
} {
  return {
    commit_id: commitId,
    event: 'COMMENT',
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: c.body,
    })),
  };
}
