// パース対象のサンプル TypeScript コード
// 関数宣言 / アロー関数 / クラスメソッド / 呼び出し式 / import を網羅する
export const SAMPLE_TS = `import { fetchUser } from './api/user';
import * as utils from './utils';
import Logger from './logger';

export function greet(name: string): string {
  const upper = utils.toUpper(name);
  return \`Hello, \${upper}\`;
}

const add = (a: number, b: number): number => {
  log(a);
  return a + b;
};

export class UserService {
  private cache = new Map<string, unknown>();

  async getUser(id: string) {
    if (this.cache.has(id)) return this.cache.get(id);
    const user = await fetchUser(id);
    this.cache.set(id, user);
    return user;
  }

  clear() {
    this.cache.clear();
  }
}

function log(value: unknown) {
  console.log(value);
  Logger.write(String(value));
}
`;
