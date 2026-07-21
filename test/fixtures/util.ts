// テスト用フィクスチャ: app.ts が import する依存ファイル（深さ 1 で取得される想定）。
// export の 3 形態（直接 export / export clause の alias / export const）を含む。

export function toUpper(s: string): string {
  return s.toUpperCase(); // member 呼び出し → 未解決
}

const helper = (s: string): string => {
  return trim(s);
};

function trim(s: string): string {
  return s.trim();
}

export { helper as helperFn };

export const formatDate = (d: Date): string => String(d);
