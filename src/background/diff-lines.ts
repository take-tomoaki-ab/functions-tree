// PR の変更ファイルの patch（unified diff）から「レビューコメントを付けられる行」を求める。
// GitHub の POST /pulls/{n}/comments は diff に含まれる行にしかコメントできないため、
// RIGHT サイド（head 側）に存在する行 = 追加行（+）と文脈行（無印）の行番号集合を作り、
// 関数の行範囲と突き合わせてコメント対象行を決める。
// 環境非依存の純粋ロジック（test/diff-lines.test.mjs で検証）。

/** 1 ファイルの patch を解析した、RIGHT サイドのコメント可能行 */
export interface PatchCommentableLines {
  /** RIGHT サイドでコメント可能な行番号（追加行 + 文脈行）。昇順 */
  commentable: number[];
  /** そのうち追加行（+）のみ。昇順 */
  added: number[];
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
  if (!patch) return { commentable, added };

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
      if (leftRemain > 0) leftRemain--;
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
  return { commentable, added };
}

/** 関数の行範囲とコメント可能行集合の突き合わせ結果 */
export interface RangeCommentability {
  /** 範囲内のコメント可能行（昇順）。空なら関数にはコメントできない */
  lines: number[];
  /**
   * 推奨コメント行。範囲内の最初の「追加行」を優先し、
   * 追加行がなければ最初のコメント可能行（文脈行）。lines が空なら undefined
   */
  commentLine?: number;
}

/**
 * 関数の行範囲 [startLine, endLine]（1 始まり・両端含む）に対する
 * コメント可能行と推奨コメント行を返す。
 */
export function commentableLinesForRange(
  info: PatchCommentableLines,
  startLine: number,
  endLine: number
): RangeCommentability {
  const inRange = (n: number): boolean => n >= startLine && n <= endLine;
  const lines = info.commentable.filter(inRange);
  if (lines.length === 0) return { lines };
  const firstAdded = info.added.find(inRange);
  return { lines, commentLine: firstAdded ?? lines[0] };
}
