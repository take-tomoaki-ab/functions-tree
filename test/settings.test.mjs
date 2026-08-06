// owner キーのトークンストア（issue #34）のテスト。
// settings.ts は chrome.storage.local しか外部依存が無いので、
// import 前に globalThis.chrome を差し替えて実挙動を検証する。

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/** chrome.storage.local の最小実装（get の引数は string / string[] のみ使う） */
const store = new Map();

function reset() {
  store.clear();
}

globalThis.chrome = {
  storage: {
    local: {
      get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) {
          if (store.has(k)) out[k] = structuredClone(store.get(k));
        }
        return Promise.resolve(out);
      },
      set(items) {
        for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
        return Promise.resolve();
      },
      remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        return Promise.resolve();
      },
    },
  },
};

const {
  TOKENS_KEY,
  LEGACY_PAT_KEY,
  LEGACY_STASH_KEY,
  clearLegacyPat,
  daysUntilExpiry,
  getLegacyPat,
  getTokenFor,
  getTokenStore,
  hasTokenFor,
  migrateLegacyPat,
  normalizeOwner,
  parseTokenExpiration,
  recordVerifiedRepo,
  removeToken,
  setToken,
  updateTokenMeta,
} = await import('../dist-test/settings.mjs');

describe('normalizeOwner', () => {
  it('owner は case-insensitive なので lowercase に正規化する', () => {
    assert.equal(normalizeOwner('OctoCat'), 'octocat');
    assert.equal(normalizeOwner('  OctoCat  '), 'octocat');
  });
});

describe('parseTokenExpiration', () => {
  it('GitHub-Authentication-Token-Expiration の実フォーマットを ISO8601 に直す', () => {
    // 実機で観測した値: "2026-08-12 06:13:53 UTC"（ISO8601 ではない）
    assert.equal(parseTokenExpiration('2026-08-12 06:13:53 UTC'), '2026-08-12T06:13:53.000Z');
  });

  it('UTC 表記が無くても ISO 風なら受ける', () => {
    assert.equal(parseTokenExpiration('2026-08-12T06:13:53Z'), '2026-08-12T06:13:53.000Z');
  });

  it('ヘッダが無い（無期限トークン）場合は undefined', () => {
    assert.equal(parseTokenExpiration(null), undefined);
    assert.equal(parseTokenExpiration(undefined), undefined);
    assert.equal(parseTokenExpiration(''), undefined);
  });

  it('パースできない文字列は undefined（Date に食わせて環境依存にしない）', () => {
    assert.equal(parseTokenExpiration('next tuesday'), undefined);
    assert.equal(parseTokenExpiration('2026/08/12'), undefined);
  });
});

describe('daysUntilExpiry', () => {
  const now = Date.parse('2026-08-05T00:00:00Z');

  it('残日数を切り捨てで返す', () => {
    assert.equal(daysUntilExpiry('2026-08-12T00:00:00Z', now), 7);
    assert.equal(daysUntilExpiry('2026-08-12T12:00:00Z', now), 7);
  });

  it('期限切れは負値', () => {
    assert.equal(daysUntilExpiry('2026-08-04T00:00:00Z', now), -1);
  });

  it('期限なしは null', () => {
    assert.equal(daysUntilExpiry(undefined, now), null);
  });
});

describe('トークンストア', () => {
  beforeEach(reset);

  it('owner キーで保存・取得できる', async () => {
    await setToken('octocat', 'github_pat_aaa');
    const entry = await getTokenFor('octocat');
    assert.equal(entry.token, 'github_pat_aaa');
    assert.equal(await hasTokenFor('octocat'), true);
  });

  it('owner の大小文字が違っても引ける', async () => {
    await setToken('OctoCat', 'github_pat_aaa');
    assert.equal((await getTokenFor('octocat')).token, 'github_pat_aaa');
    assert.equal((await getTokenFor('OCTOCAT')).token, 'github_pat_aaa');
    // 保存側も正規化されているのでキーは 1 つだけ
    assert.deepEqual(Object.keys(await getTokenStore()), ['octocat']);
  });

  it('別 owner のトークンは共存する（1 トークン = 1 owner）', async () => {
    await setToken('octocat', 'token-a');
    await setToken('acme-inc', 'token-b');
    assert.equal((await getTokenFor('octocat')).token, 'token-a');
    assert.equal((await getTokenFor('acme-inc')).token, 'token-b');
  });

  it('未登録の owner は null（旧 PAT へフォールバックしない）', async () => {
    store.set(LEGACY_STASH_KEY, 'ghp_old_classic_token');
    await setToken('octocat', 'token-a');
    assert.equal(await getTokenFor('other-owner'), null);
    assert.equal(await hasTokenFor('other-owner'), false);
  });

  it('削除できる', async () => {
    await setToken('octocat', 'token-a');
    await removeToken('OctoCat');
    assert.equal(await getTokenFor('octocat'), null);
  });

  it('label を保持し、省略時は既存の label を引き継ぐ', async () => {
    await setToken('octocat', 'token-a', '仕事用');
    assert.equal((await getTokenFor('octocat')).label, '仕事用');
    await setToken('octocat', 'token-a');
    assert.equal((await getTokenFor('octocat')).label, '仕事用');
  });

  it('トークン文字列が変わったら過去の期限・確認結果を捨てる', async () => {
    await setToken('octocat', 'token-a');
    await updateTokenMeta('octocat', { expiresAt: '2026-08-12T00:00:00.000Z' });
    await recordVerifiedRepo('octocat', 'hello-world');
    assert.equal((await getTokenFor('octocat')).expiresAt, '2026-08-12T00:00:00.000Z');

    await setToken('octocat', 'token-b');
    const entry = await getTokenFor('octocat');
    assert.equal(entry.token, 'token-b');
    assert.equal(entry.expiresAt, undefined);
    assert.equal(entry.verifiedRepos, undefined);
  });

  it('同じトークンを保存し直したときは期限・確認結果を保つ', async () => {
    await setToken('octocat', 'token-a');
    await updateTokenMeta('octocat', { expiresAt: '2026-08-12T00:00:00.000Z' });
    await setToken('octocat', 'token-a');
    assert.equal((await getTokenFor('octocat')).expiresAt, '2026-08-12T00:00:00.000Z');
  });

  it('updateTokenMeta は未登録 owner を復活させない（削除直後の書き戻し対策）', async () => {
    await updateTokenMeta('ghost', { expiresAt: '2026-08-12T00:00:00.000Z' });
    assert.equal(await getTokenFor('ghost'), null);
  });

  it('recordVerifiedRepo は重複せず lowercase で積む', async () => {
    await setToken('octocat', 'token-a');
    await recordVerifiedRepo('octocat', 'Hello-World');
    await recordVerifiedRepo('octocat', 'hello-world');
    await recordVerifiedRepo('octocat', 'another');
    assert.deepEqual((await getTokenFor('octocat')).verifiedRepos, ['another', 'hello-world']);
  });

  it('壊れたエントリは捨てて、正しいものだけ返す', async () => {
    store.set(TOKENS_KEY, {
      octocat: { token: 'token-a' },
      broken: { token: '' },
      alsoBroken: 'not-an-object',
      nullish: null,
    });
    assert.deepEqual(Object.keys(await getTokenStore()), ['octocat']);
  });

  it('ストアが配列など想定外の形でも空として扱う', async () => {
    store.set(TOKENS_KEY, ['nope']);
    assert.deepEqual(await getTokenStore(), {});
  });

  it('並行した書き込みでロストアップデートが起きない', async () => {
    await Promise.all([
      setToken('a', 'token-a'),
      setToken('b', 'token-b'),
      setToken('c', 'token-c'),
    ]);
    assert.deepEqual(Object.keys(await getTokenStore()).sort(), ['a', 'b', 'c']);
  });
});

describe('旧 PAT の移行', () => {
  beforeEach(reset);

  it('githubPat が残っていれば legacyPat へ退避して元キーを消す', async () => {
    store.set(LEGACY_PAT_KEY, 'ghp_old_classic_token');
    await migrateLegacyPat();
    assert.equal(store.has(LEGACY_PAT_KEY), false);
    assert.equal(await getLegacyPat(), 'ghp_old_classic_token');
  });

  it('自動で owner キーのストアへは移さない（どの owner か決まらないため）', async () => {
    store.set(LEGACY_PAT_KEY, 'ghp_old_classic_token');
    await migrateLegacyPat();
    assert.deepEqual(await getTokenStore(), {});
  });

  it('冪等（SW 起動のたびに呼んでよい）', async () => {
    store.set(LEGACY_PAT_KEY, 'ghp_old_classic_token');
    await migrateLegacyPat();
    await migrateLegacyPat();
    assert.equal(await getLegacyPat(), 'ghp_old_classic_token');
  });

  it('旧 PAT が無ければ何もしない', async () => {
    await migrateLegacyPat();
    assert.equal(await getLegacyPat(), null);
  });

  it('明示削除で退避先も元キーも消える', async () => {
    store.set(LEGACY_PAT_KEY, 'ghp_old_classic_token');
    await migrateLegacyPat();
    await clearLegacyPat();
    assert.equal(await getLegacyPat(), null);
    assert.equal(store.has(LEGACY_PAT_KEY), false);
  });
});
