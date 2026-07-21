// テスト用フィクスチャ: namespace import（import * as logger）で参照される依存ファイル。

export function write(msg: string): void {
  console.log(msg);
}

export function flush(): void {}
