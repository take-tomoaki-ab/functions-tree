// テスト用フィクスチャ: PR の変更ファイル想定その 2。
// クラスメソッド + this 呼び出しの解決、自己再帰エッジを含む。

export class Cache {
  private store = new Map<string, string>();

  get(key: string): string | undefined {
    return this.store.get(key); // this.store.get は 2 段の member → 未解決
  }

  refresh(key: string): void {
    this.load(key); // this.method() → 同一ファイル内のメソッドに解決
  }

  load(key: string): void {
    this.store.set(key, key);
  }
}

export function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2); // 自己再帰 → 自分自身へのエッジ
}
