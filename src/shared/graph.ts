// コールグラフの共有型。background の analyzer が生成し、content の panel が描画する。
// Phase 4 の mermaid 描画・Phase 5 のコメント可否判定（inDiff）もこの型を使う。

/** シンタックスハイライトのトークン種別（panel 側の CSS クラス `tok-<kind>` に対応） */
export type HighlightKind =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'constant'
  | 'function'
  | 'type';

/**
 * sourceText 内のハイライト範囲。[開始オフセット, 終了オフセット, 種別]。
 * オフセットは sourceText 先頭からの UTF-16 コードユニット単位（String#slice にそのまま使える）。
 * 昇順・重複なし。トークン間の隙間は無装飾テキストとして描画する。
 * グラフ全ノード分をメッセージで運ぶため、オブジェクトではなくタプルで持つ。
 */
export type HighlightToken = [start: number, end: number, kind: HighlightKind];

/** グラフのノード = 関数 1 つ */
export interface GraphNode {
  /** `${filePath}#${name}@${startLine}` 形式の一意 ID */
  id: string;
  /** 関数名（export 名ではなくファイル内での定義名） */
  name: string;
  /** export されている場合の公開名（`export { foo as bar }` なら bar）。未 export は undefined */
  exportName?: string;
  /** リポジトリルートからのファイルパス */
  filePath: string;
  /** 1 始まりの行範囲（宣言全体） */
  startLine: number;
  endLine: number;
  /** function_declaration | variable_declarator | method_definition */
  kind: string;
  /**
   * PR の変更ファイル内の関数なら true（ファイル単位の判定）。
   * 行レベルのコメント可否は commentableLines を見ること。
   */
  inDiff: boolean;
  /**
   * 関数の行範囲のうち、レビューコメントを付けられる行（patch の RIGHT サイドに
   * 含まれる行）。昇順。空 = この関数にはコメントできない
   * （diff 外、または変更ファイル内だが関数自体は無変更）。
   */
  commentableLines: number[];
  /** 推奨コメント行（範囲内の最初の追加行、なければ最初のコメント可能行） */
  commentLine?: number;
  /** 関数定義のソーステキスト（Phase 4 のサイドパネル表示用） */
  sourceText: string;
  /** sourceText のシンタックスハイライト（tree-sitter の構文木から抽出） */
  highlightTokens: HighlightToken[];
}

/** グラフのエッジ = 関数から関数への呼び出し */
export interface GraphEdge {
  /** 呼び出し元ノード ID */
  from: string;
  /** 呼び出し先ノード ID */
  to: string;
  /** 呼び出しが書かれている行（呼び出し元ファイル内、1 始まり） */
  callLine: number;
}

/** 解析をスキップしたファイルとその理由 */
export interface SkippedFile {
  path: string;
  /** 例: 'too_large' / 'not_found' / 'parse_error' などの機械可読な理由 */
  reason: string;
}

export interface FunctionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 解析に成功したファイルパス（変更ファイル + 深さ 1 の依存ファイル） */
  analyzedFiles: string[];
  skippedFiles: SkippedFile[];
  /** 関数ノードに解決できなかった呼び出しの総数（console.log や外部パッケージ等） */
  unresolvedCallCount: number;
}

/** BUILD_GRAPH メッセージの応答ペイロード */
export interface GraphPayload {
  graph: FunctionGraph;
  /** 解析対象にしたコミット SHA（PR の head） */
  headSha: string;
  /** SW メモリキャッシュから返した場合 true（レート制限を消費していない） */
  fromCache: boolean;
}
