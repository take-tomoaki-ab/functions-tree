// パネルのソース表示を git diff 風の行単位ビューに組み立てる純粋ロジック。
// panel.ts は結果の SourceRow[] を DOM に流し込むだけにして、行番号の対応・
// 削除行の挿入位置・ハイライトトークンの行分割をここでテスト可能にする。
//
// 前提: sourceText の i 行目（0 始まり）はファイルの startLine + i 行目に対応する
// （analyzer が関数の宣言ノードをそのまま切り出しているため）。

import type { DeletedDiffLine, HighlightToken } from '../shared/graph';

/** 行の差分種別。add = 追加行 / del = 削除行 / context = 変更なし */
export type SourceRowKind = 'add' | 'del' | 'context';

/** ソース表示 1 行分 */
export interface SourceRow {
  kind: SourceRowKind;
  /** head 側の行番号。削除行は head に存在しないので undefined */
  lineNo?: number;
  text: string;
  /** text 先頭を 0 としたハイライト範囲（削除行は旧内容なので常に空） */
  tokens: HighlightToken[];
}

/** SourceRow[] を組み立てるのに必要な情報（GraphNode の部分集合） */
export interface SourceDiffInput {
  sourceText: string;
  /** sourceText の 1 行目に対応するファイルの行番号（1 始まり） */
  startLine: number;
  highlightTokens?: HighlightToken[];
  addedLines?: number[];
  deletedLines?: DeletedDiffLine[];
}

/**
 * ハイライトトークンを行ごとに切り分け、各行内の相対オフセットに変換する。
 * 複数行にまたがるトークン（ブロックコメント・テンプレートリテラル等）は
 * 行境界で分割する。tokens は昇順・重複なしを前提とする。
 */
export function splitTokensByLine(
  text: string,
  tokens: HighlightToken[]
): HighlightToken[][] {
  const lines = text.split('\n');
  const perLine: HighlightToken[][] = lines.map(() => []);
  let lineStart = 0;
  let from = 0; // これより前のトークンは走査済み（行末までに終わっている）
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = lineStart + lines[i].length;
    while (from < tokens.length && tokens[from][1] <= lineStart) from++;
    for (let j = from; j < tokens.length; j++) {
      const [start, end, kind] = tokens[j];
      if (start >= lineEnd) break; // 昇順なのでこれ以降は後続行
      const clippedStart = Math.max(start, lineStart);
      const clippedEnd = Math.min(end, lineEnd);
      if (clippedEnd > clippedStart) {
        perLine[i].push([clippedStart - lineStart, clippedEnd - lineStart, kind]);
      }
    }
    lineStart = lineEnd + 1; // 改行 1 文字分
  }
  return perLine;
}

/**
 * ソース表示の行リストを組み立てる。
 * 削除行は「直後に来る head 行（beforeLine）の直前」に差し込むので、
 * git diff と同じ「削除 → 追加」の並びになる。
 */
export function buildSourceRows(node: SourceDiffInput): SourceRow[] {
  const lines = node.sourceText.split('\n');
  const tokensByLine = splitTokensByLine(
    node.sourceText,
    node.highlightTokens ?? []
  );
  const addedSet = new Set(node.addedLines ?? []);
  const deletedByBefore = new Map<number, string[]>();
  for (const d of node.deletedLines ?? []) {
    const list = deletedByBefore.get(d.beforeLine);
    if (list) list.push(d.text);
    else deletedByBefore.set(d.beforeLine, [d.text]);
  }

  const rows: SourceRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = node.startLine + i;
    for (const text of deletedByBefore.get(lineNo) ?? []) {
      rows.push({ kind: 'del', text, tokens: [] });
    }
    rows.push({
      kind: addedSet.has(lineNo) ? 'add' : 'context',
      lineNo,
      text: lines[i],
      tokens: tokensByLine[i],
    });
  }
  return rows;
}

/** 行リストの差分サマリ（`+n -m` 表示用） */
export interface DiffStat {
  added: number;
  deleted: number;
}

export function diffStat(rows: SourceRow[]): DiffStat {
  let added = 0;
  let deleted = 0;
  for (const row of rows) {
    if (row.kind === 'add') added++;
    else if (row.kind === 'del') deleted++;
  }
  return { added, deleted };
}
