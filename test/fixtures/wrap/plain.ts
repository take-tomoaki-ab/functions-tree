// 関数を包まない呼び出しは関数定義として扱わない（issue #28 E の誤検知回帰テスト）。

// PascalCase だが、コールバックはオブジェクトリテラルの中なのでラップではない
export const Config = createConfig({ onClick: () => undefined });

// 大文字始まりでも小文字を含まない定数は対象外
export const EXTENSIONS = ['ts', 'tsx'].map((e) => `.${e}`);

export function createConfig(value: unknown): unknown {
  return value;
}
