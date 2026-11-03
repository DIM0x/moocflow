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
