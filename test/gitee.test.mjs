import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gitee from '../src/channels/gitee.mjs';
import { apiBase, issueUrl, mapComment, resolveGiteeRepo } from '../src/channels/gitee.mjs';
import { buildReminderDoc } from '../src/report.mjs';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function makeDoc() {
  const item = {
    id: 'u1', title: '第一周测验', type: 'quiz', chapter: '第一章', lesson: '1.1',
    courseName: '测试课程', url: 'https://www.icourse163.org/learn/NEU-1002822009?tid=1488060444'
  };
  return buildReminderDoc({
    windowHours: 48, overdueDays: 3, coursesTotal: 1, coursesOk: 1,
    failures: [],
    due: [{ item, kind: 'submit', dueMs: NOW + 24 * HOUR }],
    overdue: [],
    now: NOW
  });
}

function okResponse(data, status = 200) {
  return { ok: true, status, json: async () => data, text: async () => JSON.stringify(data) };
}

function errorResponse(status, text) {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

const ENV = {
  GITEE_TOKEN: 'gitee-token',
  GITEE_REPO_SLUG: 'owner/repo',
  REMINDER_ISSUE_NUMBER: '3'
};

test('gitee 渠道 isConfigured：令牌与仓库路径齐备即可', () => {
  assert.equal(gitee.isConfigured({}), false);
  assert.equal(gitee.isConfigured({ GITEE_TOKEN: 't', GITEE_REPO_SLUG: 'o/r' }), true);
  // GITEE_REPO 只有在含 / 时才被采用；REPO_SLUG 作为通用兜底
  assert.equal(gitee.isConfigured({ GITEE_TOKEN: 't', GITEE_REPO: 'o/r' }), true);
  assert.equal(gitee.isConfigured({ GITEE_TOKEN: 't', GITEE_REPO: 'repo' }), false);
  assert.equal(gitee.isConfigured({ REPO_TOKEN: 't', REPO_SLUG: 'o/r' }), true);
});

test('gitee 仓库路径与地址：显式值优先、默认 gitee.com', () => {
  assert.equal(resolveGiteeRepo({ GITEE_REPO_SLUG: 'o/r', GITEE_REPO: 'a/b' }), 'o/r');
  assert.equal(resolveGiteeRepo({ GITEE_REPO: 'a/b' }), 'a/b');
  assert.equal(resolveGiteeRepo({ GITEE_REPO: 'repo', REPO_SLUG: 'o/r' }), 'o/r');
  assert.equal(resolveGiteeRepo({}), undefined);

  assert.equal(apiBase({}), 'https://gitee.com/api/v5');
  assert.equal(apiBase({ GITEE_API_URL: 'https://gitee.example.com/api/v5/' }), 'https://gitee.example.com/api/v5');
  assert.equal(issueUrl(ENV, 3), 'https://gitee.com/owner/repo/issues/3');
  assert.equal(
    issueUrl({ GITEE_REPO_SLUG: 'o/r', GITEE_WEB_URL: 'https://gitee.example.com/' }, 3),
    'https://gitee.example.com/o/r/issues/3'
  );
});

test('gitee mapComment：默认只按签名识别，可限定作者名', () => {
  const base = { id: 1, body: '提醒\nmoocflow 自动提醒', created_at: '2026-11-01T00:00:00Z' };
  assert.equal(mapComment({ ...base, user: { login: 'someone' } }, ENV).isBot, true);
  assert.equal(
    mapComment({ ...base, user: { login: 'someone' } }, { GITEE_BOT_LOGIN: 'bot' }).isBot,
    false
  );
  assert.equal(
    mapComment({ ...base, user: { login: 'bot' } }, { GITEE_BOT_LOGIN: 'bot' }).isBot,
    true
  );
});

test('gitee deliver：新建评论后按保留期清理旧提醒评论', async () => {
  const notes = [
    {
      id: 1, body: '旧提醒\nmoocflow 自动提醒',
      created_at: new Date(NOW - 10 * DAY).toISOString(), user: { login: 'me' }
    },
    {
      id: 2, body: '普通评论',
      created_at: new Date(NOW - 9 * DAY).toISOString(), user: { login: 'other' }
    },
    {
      id: 3, body: '最近提醒\nmoocflow 自动提醒',
      created_at: new Date(NOW - 1 * DAY).toISOString(), user: { login: 'me' }
    }
  ];
  const stub = stubFetch((url, options) => {
    if (options.method === 'POST') {
      return okResponse({ id: 9, body: new URLSearchParams(options.body).get('body') }, 201);
    }
    if (options.method === 'DELETE') return okResponse({});
    return okResponse(notes);
  });
  try {
    const res = await gitee.deliver(makeDoc(), ENV, NOW);
    assert.equal(res.sent, true);
    assert.equal(
      res.detail,
      '评论已发布：https://gitee.com/owner/repo/issues/3；已清理 1 条超过保留期（7 天）的旧评论'
    );

    const create = stub.calls.find((c) => c.options.method === 'POST');
    assert.equal(create.url, 'https://gitee.com/api/v5/repos/owner/repo/issues/3/comments');
    assert.equal(create.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(create.options.body);
    assert.equal(form.get('access_token'), 'gitee-token');
    assert.match(form.get('body'), /## 📬 MOOC 截止提醒/);

    const list = stub.calls.find((c) => !c.options.method);
    const listUrl = new URL(list.url);
    assert.equal(listUrl.pathname, '/api/v5/repos/owner/repo/issues/3/comments');
    assert.equal(listUrl.searchParams.get('access_token'), 'gitee-token');
    assert.equal(listUrl.searchParams.get('page'), '1');
    assert.equal(listUrl.searchParams.get('per_page'), '100');
    assert.equal(listUrl.searchParams.get('order'), 'asc');

    const deletes = stub.calls.filter((c) => c.options.method === 'DELETE');
    assert.equal(deletes.length, 1);
    const deleteUrl = new URL(deletes[0].url);
    assert.equal(deleteUrl.pathname, '/api/v5/repos/owner/repo/issues/comments/1');
    assert.equal(deleteUrl.searchParams.get('access_token'), 'gitee-token');
  } finally {
    stub.restore();
  }
});

test('gitee deliver：未配置时降级为 sent:false', async () => {
  const res = await gitee.deliver(makeDoc(), {}, NOW);
  assert.deepEqual(res, { sent: false, detail: '未配置 GITEE_TOKEN / GITEE_REPO_SLUG' });
});

test('gitee deliver：401 提示令牌失效或 scope 不足', async () => {
  const stub = stubFetch((url, options) =>
    options.method === 'POST' ? errorResponse(401, '{"message":"401 Unauthorized"}') : okResponse([])
  );
  try {
    await assert.rejects(gitee.deliver(makeDoc(), ENV, NOW), (e) => {
      assert.match(e.message, /Gitee 评论发布失败：HTTP 401/);
      assert.match(e.message, /GITEE_TOKEN 无效/);
      return true;
    });
  } finally {
    stub.restore();
  }
});
