import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRepoSlug, resolveRepoToken } from '../src/repo-env.mjs';

test('仓库令牌解析：平台原生变量优先于通用别名，空串视为未设置', () => {
  assert.equal(resolveRepoToken({ GITHUB_TOKEN: 'g', REPO_TOKEN: 'r' }), 'g');
  assert.equal(resolveRepoToken({ REPO_TOKEN: 'r' }), 'r');
  assert.equal(resolveRepoToken({}), undefined);
  assert.equal(resolveRepoToken({ GITHUB_TOKEN: '  ' }), undefined); // 纯空白按未设置
  assert.equal(resolveRepoToken({ GITHUB_TOKEN: ' g ' }), 'g');
});

test('仓库全名解析：GITHUB_REPOSITORY 优先于 REPO_SLUG，取值去除首尾空白', () => {
  assert.equal(resolveRepoSlug({ GITHUB_REPOSITORY: 'o/r', REPO_SLUG: 'a/b' }), 'o/r');
  assert.equal(resolveRepoSlug({ REPO_SLUG: ' a/b ' }), 'a/b');
  assert.equal(resolveRepoSlug({}), undefined);
  assert.equal(resolveRepoSlug({ GITHUB_REPOSITORY: '' }), undefined);
});
