// describeGithubError / describeRequiredPermissions のテスト（issue #34）。
// fine-grained token では「トークンのスコープ外」も 404 で返る（実機で確認済み）ため、
// 404 のメッセージがユーザーを誤誘導しないことを重点的に確認する。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { describeGithubError, describeRequiredPermissions } = await import(
  '../dist-test/github.mjs'
);

describe('describeRequiredPermissions', () => {
  it('X-Accepted-GitHub-Permissions を読める形に直す', () => {
    assert.equal(
      describeRequiredPermissions('pull_requests=write,contents=read'),
      'Pull requests: write / Contents: read'
    );
  });

  it('単一の権限も扱える', () => {
    assert.equal(describeRequiredPermissions('metadata=read'), 'Metadata: read');
  });

  it('allows_permissionless_access は権限名ではないので落とす', () => {
    assert.equal(describeRequiredPermissions('allows_permissionless_access=true'), null);
  });

  it('未指定（GraphQL 応答にはヘッダが載らない）は null', () => {
    assert.equal(describeRequiredPermissions(undefined), null);
    assert.equal(describeRequiredPermissions(''), null);
  });
});

describe('describeGithubError', () => {
  describe('not_found', () => {
    it('トークン未登録なら「owner 用のトークンを登録して」と言う', () => {
      const msg = describeGithubError({
        kind: 'not_found',
        status: 404,
        message: 'Not Found',
        owner: 'octocat',
        tokenRegistered: false,
      });
      assert.match(msg, /octocat/);
      assert.match(msg, /登録してください/);
      // 未登録の人に Repository access の確認を促すのは誤誘導
      assert.doesNotMatch(msg, /Repository access/);
    });

    it('トークン登録済みなら Repository access の確認を促す', () => {
      const msg = describeGithubError({
        kind: 'not_found',
        status: 404,
        message: 'Not Found',
        owner: 'octocat',
        tokenRegistered: true,
      });
      assert.match(msg, /Repository access/);
      assert.match(msg, /octocat/);
      assert.match(msg, /PR 番号/);
    });

    it('owner 不明でも破綻しない', () => {
      const msg = describeGithubError({ kind: 'not_found', status: 404, message: 'Not Found' });
      assert.match(msg, /404/);
      assert.equal(typeof msg, 'string');
    });

    it('旧文言の「PAT が設定されているか」は残っていない', () => {
      for (const tokenRegistered of [true, false]) {
        const msg = describeGithubError({
          kind: 'not_found',
          status: 404,
          message: 'Not Found',
          owner: 'octocat',
          tokenRegistered,
        });
        assert.doesNotMatch(msg, /PAT/);
      }
    });
  });

  describe('forbidden', () => {
    it('不足権限が分かるなら名指しする', () => {
      const msg = describeGithubError({
        kind: 'forbidden',
        status: 403,
        message: 'Resource not accessible',
        requiredPermissions: 'pull_requests=write',
      });
      assert.match(msg, /Pull requests: write/);
    });

    it('ヘッダが無い（GraphQL 経由）ときは権限の記載を出さない', () => {
      const msg = describeGithubError({
        kind: 'forbidden',
        status: 403,
        message: 'Resource not accessible',
      });
      assert.doesNotMatch(msg, /必要な権限/);
      assert.match(msg, /403/);
    });
  });

  describe('fork_unreadable', () => {
    it('fork 元リポジトリ名と、そこ用のトークンが要ることを伝える', () => {
      const msg = describeGithubError({
        kind: 'fork_unreadable',
        message: 'fork 元リポジトリ contributor/functions-tree のファイルを取得できません',
        forkRepo: 'contributor/functions-tree',
        owner: 'contributor',
      });
      assert.match(msg, /contributor\/functions-tree/);
      // fork 側 owner のトークンを登録すれば解決することを案内する
      assert.match(msg, /contributor/);
      assert.match(msg, /トークンを登録/);
    });

    it('forkRepo 不明でも破綻しない', () => {
      const msg = describeGithubError({ kind: 'fork_unreadable', message: 'x' });
      assert.match(msg, /解析できません/);
    });
  });

  describe('token_required', () => {
    it('owner 名を出して登録を促す', () => {
      const msg = describeGithubError({
        kind: 'token_required',
        message: '下書きの追加にはトークンの登録が必要です',
        owner: 'octocat',
        tokenRegistered: false,
      });
      assert.match(msg, /octocat/);
      assert.match(msg, /pending review/);
    });
  });

  describe('その他', () => {
    it('unauthorized は期限切れの可能性に触れる（fine-grained は必ず期限がある運用）', () => {
      const msg = describeGithubError({
        kind: 'unauthorized',
        status: 401,
        message: 'Bad credentials',
        owner: 'octocat',
      });
      assert.match(msg, /401/);
      assert.match(msg, /期限切れ/);
      assert.match(msg, /octocat/);
    });

    it('rate_limited はリセット時刻を出す', () => {
      const msg = describeGithubError({
        kind: 'rate_limited',
        status: 403,
        message: 'API rate limit exceeded',
        rateLimitReset: Date.parse('2026-08-05T10:00:00Z'),
      });
      assert.match(msg, /レート制限/);
      assert.match(msg, /リセット/);
    });

    it('too_large / network / unexpected も文字列を返す', () => {
      for (const kind of ['too_large', 'network', 'unexpected']) {
        const msg = describeGithubError({ kind, message: 'x', status: 500 });
        assert.equal(typeof msg, 'string');
        assert.ok(msg.length > 0);
      }
    });
  });
});
