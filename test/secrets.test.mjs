import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSecretStore } from '../src/secrets.mjs';

test('selectSecretStore：默认 github、大小写不敏感、未知取值报错', () => {
  assert.equal(selectSecretStore({}).name, 'github');
  assert.equal(selectSecretStore({ COOKIE_SECRET_STORE: ' ' }).name, 'github');
  assert.equal(selectSecretStore({ COOKIE_SECRET_STORE: 'GitHub' }).name, 'github');
  assert.throws(
    () => selectSecretStore({ COOKIE_SECRET_STORE: 'gitlab' }),
    /未知 Cookie Secret 存储方式 "gitlab"（COOKIE_SECRET_STORE）/
  );
});

test('github store 启动校验：缺 PAT、缺仓库时给出原文案；通用别名可用', () => {
  const store = selectSecretStore({});
  assert.equal(store.validate({}).reason, 'COOKIE_REFRESH_MODE=2 需要配置 MOOC_REFRESH_PAT（Fine-grained PAT）');
  assert.equal(
    store.validate({ MOOC_REFRESH_PAT: 'p' }).reason,
    'COOKIE_REFRESH_MODE=2 需要 GITHUB_REPOSITORY（owner/repo）'
  );
  assert.deepEqual(store.validate({ MOOC_REFRESH_PAT: 'p', GITHUB_REPOSITORY: 'o/r' }), { ok: true });
  // 平台无关别名 REPO_SLUG 同样被接受（见 src/repo-env.mjs）
  assert.deepEqual(store.validate({ MOOC_REFRESH_PAT: 'p', REPO_SLUG: 'o/r' }), { ok: true });
});

test('github store 模式 3：校验 App 安装令牌，写回使用该令牌而非 PAT', async () => {
  const store = selectSecretStore({});
  assert.match(
    store.validate({}, 3).reason,
    /COOKIE_REFRESH_MODE=3 需要 GitHub App 安装令牌 MOOC_REFRESH_APP_TOKEN/
  );
  assert.equal(
    store.validate({ MOOC_REFRESH_APP_TOKEN: 't' }, 3).reason,
    'COOKIE_REFRESH_MODE=3 需要 GITHUB_REPOSITORY（owner/repo）'
  );
  assert.deepEqual(
    store.validate({ MOOC_REFRESH_APP_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, 3),
    { ok: true }
  );

  const auths = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    auths.push(init.headers?.Authorization);
    if (String(url).endsWith('/actions/secrets/public-key')) {
      return new Response(
        JSON.stringify({ key_id: 'k', key: Buffer.alloc(32, 1).toString('base64') }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 201 });
  };
  const env = { MOOC_REFRESH_PAT: 'pat', MOOC_REFRESH_APP_TOKEN: 'app-token', GITHUB_REPOSITORY: 'o/r' };
  try {
    await store.write(env, { name: 'MOOC_COOKIE', value: 'cookie=1', mode: 3 });
    await store.write(env, { name: 'MOOC_COOKIE', value: 'cookie=1', mode: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(auths, ['Bearer app-token', 'Bearer app-token', 'Bearer pat', 'Bearer pat']);
});
