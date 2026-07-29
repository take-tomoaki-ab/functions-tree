// ソース 1 行分のテキストを「描画単位（セグメント）」へ分割する純粋ロジック。
// panel.ts は結果をそのまま span / テキストノードに流し込むだけにして、
// ハイライトトークンの適用と識別子の切り出しをここでテスト可能にする。
//
// 識別子を独立したセグメントにするのは、クリックで選択して同名の識別子を
// まとめてハイライトする（issue #22）ため。
// ハイライトトークンで塗られない隙間（識別子・記号・空白）のうち、
// 識別子の形をした部分だけを拾う。

import type { HighlightKind, HighlightToken } from '../shared/graph';

/** ソース表示の描画単位。text を連結すると元の行テキストに戻る */
export interface SourceSegment {
  text: string;
  /** シンタックスハイライトの種別。無装飾なら undefined */
  kind?: HighlightKind;
  /** 識別子（クリックで選択できる）なら true */
  identifier?: boolean;
}

/**
 * 識別子として扱う文字列。先頭は文字 / `_` / `$` で、以降は数字も許す。
 * 非 ASCII の識別子（日本語の変数名など）も拾えるよう Unicode プロパティを使う。
 */
const IDENTIFIER_PATTERN = '[\\p{L}_$][\\p{L}\\p{N}_$]*';
const IDENTIFIER_SCAN = new RegExp(IDENTIFIER_PATTERN, 'gu');
const IDENTIFIER_WHOLE = new RegExp(`^${IDENTIFIER_PATTERN}$`, 'u');

/**
 * 識別子として選択できるハイライト種別。
 * - function / type: 関数名・型名そのものなので選択対象
 * - keyword / string / comment / number: 識別子ではない
 * - constant: 各言語の設定では `true` / `null` / `nil` などのリテラル専用なので対象外
 */
const SELECTABLE_KINDS: ReadonlySet<HighlightKind> = new Set<HighlightKind>([
  'function',
  'type',
]);

/** トークン 1 つが「選択できる識別子」か（`dict[str, int]` のような複合トークンは対象外） */
function isSelectableToken(text: string, kind: HighlightKind): boolean {
  return SELECTABLE_KINDS.has(kind) && IDENTIFIER_WHOLE.test(text);
}

/** ハイライトされない隙間を 識別子 / それ以外（記号・空白）に切り分ける */
function splitGap(text: string, out: SourceSegment[]): void {
  if (text === '') return;
  IDENTIFIER_SCAN.lastIndex = 0;
  let pos = 0;
  for (let m = IDENTIFIER_SCAN.exec(text); m !== null; m = IDENTIFIER_SCAN.exec(text)) {
    if (m.index > pos) out.push({ text: text.slice(pos, m.index) });
    out.push({ text: m[0], identifier: true });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
}

/**
 * 行テキストをハイライトトークンに沿って分割し、隙間から識別子を切り出す。
 * 範囲外・逆順のトークンは無視して素のテキストとして扱う（描画を壊さない）。
 *
 * tokens が空の行（削除行など）はテキスト全体が隙間になるため、キーワードも
 * 識別子として拾われる。ハイライト情報がない行では区別できないので許容する
 * （同名の識別子がハイライトされる利点を優先）。
 */
export function splitSourceSegments(
  text: string,
  tokens: HighlightToken[]
): SourceSegment[] {
  const segments: SourceSegment[] = [];
  let pos = 0;
  for (const [start, end, kind] of tokens) {
    if (start < pos || end > text.length || start >= end) continue;
    if (start > pos) splitGap(text.slice(pos, start), segments);
    const tokenText = text.slice(start, end);
    segments.push(
      isSelectableToken(tokenText, kind)
        ? { text: tokenText, kind, identifier: true }
        : { text: tokenText, kind }
    );
    pos = end;
  }
  if (pos < text.length) splitGap(text.slice(pos), segments);
  return segments;
}
