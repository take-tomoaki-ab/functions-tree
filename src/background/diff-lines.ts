// PR の変更ファイルの patch（unified diff）から「レビューコメントを付けられる行」を求める。
// GitHub の POST /pulls/{n}/comments は diff に含まれる行にしかコメントできないため、
// RIGHT サイド（head 側）に存在する行 = 追加行（+）と文脈行（無印）の行番号集合を作り、
// 関数の行範囲と突き合わせてコメント対象行を決める。
// 環境非依存の純粋ロジック（test/diff-lines.test.mjs で検証）。
//
// パネルのソース表示を git diff 風にハイライトするため、追加行・削除行も併せて返す
// （削除行は head 側に存在しないので「RIGHT のどの行の直前か」で位置を持つ）。

import type { DeletedDiffLine } from '../shared/graph';

/** 1 ファイルの patch を解析した、RIGHT サイドのコメント可能行と差分の内訳 */
export interface PatchCommentableLines {
  /** RIGHT サイドでコメント可能な行番号（追加行 + 文脈行）。昇順 */
  commentable: number[];
  /** そのうち追加行（+）のみ。昇順 */
  added: number[];
  /** 削除行（-）。RIGHT サイドの挿入位置（beforeLine）の昇順 */
  deleted: DeletedDiffLine[];
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * unified diff の patch をパースして RIGHT サイドのコメント可能行を返す。
 * patch がない場合（バイナリ / 巨大ファイル / 変更なしリネーム）は空集合。
 */
export function parsePatchCommentableLines(
  patch: string | null | undefined
): PatchCommentableLines {
  const commentable: number[] = [];
  const added: number[] = [];
  const deleted: DeletedDiffLine[] = [];
  if (!patch) return { commentable, added, deleted };

  let rightLine = 0;
  // hunk ヘッダの行数を数え、超過分（patch 末尾の空文字列等）を文脈行と誤認しないようにする
  let leftRemain = 0;
  let rightRemain = 0;

  for (const line of patch.split('\n')) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      leftRemain = hunk[1] !== undefined ? Number(hunk[1]) : 1;
      rightLine = Number(hunk[2]);
      rightRemain = hunk[3] !== undefined ? Number(hunk[3]) : 1;
      continue;
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+')) {
      if (rightRemain > 0) {
        added.push(rightLine);
        commentable.push(rightLine);
        rightLine++;
        rightRemain--;
      }
    } else if (line.startsWith('-')) {
      if (leftRemain > 0) {
        // 削除行は RIGHT に行番号を持たないので、次に来る RIGHT 行の直前に置く
        deleted.push({ beforeLine: rightLine, text: line.slice(1) });
        leftRemain--;
      }
    } else {
      // 文脈行（先頭が半角スペース。空行の文脈は '' になることがある）
      if (leftRemain > 0 && rightRemain > 0) {
        commentable.push(rightLine);
        rightLine++;
        rightRemain--;
        leftRemain--;
      }
    }
  }
  return { commentable, added, deleted };
}

/** 関数の行範囲とコメント可能行集合の突き合わせ結果 */
export interface RangeCommentability {
  /** 範囲内のコメント可能行（昇順）。空なら関数にはコメントできない */
  lines: number[];
  /** 範囲内の追加行（昇順）。lines の部分集合。パネルの diff ハイライト用 */
  added: number[];
  /**
   * 推奨コメント行。範囲内の最初の「追加行」を優先し、
   * 追加行がなければ最初のコメント可能行（文脈行）。lines が空なら undefined
   */
  commentLine?: number;
}

/**
 * 関数の行範囲 [startLine, endLine]（1 始まり・両端含む）に対する
 * コメント可能行・追加行と推奨コメント行を返す。
 */
export function commentableLinesForRange(
  info: PatchCommentableLines,
  startLine: number,
  endLine: number
): RangeCommentability {
  const inRange = (n: number): boolean => n >= startLine && n <= endLine;
  const lines = info.commentable.filter(inRange);
  const added = info.added.filter(inRange);
  if (lines.length === 0) return { lines, added };
  return { lines, added, commentLine: added[0] ?? lines[0] };
}

/**
 * 関数の行範囲 [startLine, endLine] の中に挿入される削除行を返す。
 * 判定は「削除行の直後に来る RIGHT 行（beforeLine）が範囲内にあるか」で行うため、
 * 関数の直前・直後で消えた行は含まれない（隣の関数の差分を混ぜない）。
 */
export function deletedLinesForRange(
  info: PatchCommentableLines,
  startLine: number,
  endLine: number
): DeletedDiffLine[] {
  return info.deleted.filter(
    (d) => d.beforeLine >= startLine && d.beforeLine <= endLine
  );
}
