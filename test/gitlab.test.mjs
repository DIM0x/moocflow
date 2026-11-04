import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gitlab from '../src/channels/gitlab.mjs';
import {
  apiBase,
  issueUrl,
  mapComment,
  resolveGitlabProject
} from '../src/channels/gitlab.mjs';
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
  GITLAB_TOKEN: 'glpat-test',
  CI_PROJECT_ID: '42',
  CI_API_V4_URL: 'https://jihulab.com/api/v4',
  CI_PROJECT_URL: 'https://jihulab.com/group/repo',
  REMINDER_ISSUE_NUMBER: '3'
};

test('gitlab 渠道 isConfigured：令牌与项目标识齐备即可', () => {
  assert.equal(gitlab.isConfigured({}), false);
  assert.equal(gitlab.isConfigured({ GITLAB_TOKEN: 't', CI_PROJECT_ID: '42' }), true);
  // 本地调试可用通用别名
  assert.equal(gitlab.isConfigured({ REPO_TOKEN: 't', REPO_SLUG: 'g/r' }), true);
  assert.equal(gitlab.isConfigured({ GITLAB_TOKEN: '  ', CI_PROJECT_ID: '42' }), false);
});

test('gitlab 项目标识与 API 地址：显式值优先、路径需编码', () => {
  assert.equal(resolveGitlabProject({ CI_PROJECT_ID: '42' }), '42');
  assert.equal(resolveGitlabProject({ GITLAB_PROJECT: 'group/repo' }), 'group%2Frepo');
  assert.equal(resolveGitlabProject({ GITLAB_PROJECT: '77' }), '77');
  assert.equal(resolveGitlabProject({ REPO_SLUG: 'a/b' }), 'a%2Fb');
  assert.equal(resolveGitlabProject({}), undefined);

  assert.equal(apiBase({}), 'https://gitlab.com/api/v4');
  assert.equal(apiBase({ CI_API_V4_URL: 'https://jihulab.com/api/v4/' }), 'https://jihulab.com/api/v4');
  assert.equal(apiBase({ GITLAB_API_URL: 'https://example.com/api/v4' }), 'https://example.com/api/v4');
});

test('gitlab issue URL：优先项目页面地址，其次由 API 地址推导', () => {
  assert.equal(issueUrl(ENV, 3), 'https://jihulab.com/group/repo/-/issues/3');
  assert.equal(
    issueUrl({ CI_API_V4_URL: 'https://jihulab.com/api/v4', REPO_SLUG: 'g/r' }, 3),
    'https://jihulab.com/g/r/-/issues/3'
  );
});

test('gitlab mapComment：系统 note 不算；默认按签名识别，可限定作者名', () => {
  const base = { id: 1, body: '提醒\nmoocflow 自动提醒', created_at: '2026-11-01T00:00:00Z' };
  assert.equal(mapComment({ ...base, system: true }, ENV).isBot, false);
  assert.equal(mapComment({ ...base, author: { username: 'someone' } }, ENV).isBot, true);
  assert.equal(
    mapComment({ ...base, author: { username: 'someone' } }, { GITLAB_BOT_LOGIN: 'bot' }).isBot,
    false
  );
  assert.equal(
    mapComment({ ...base, author: { username: 'bot' } }, { GITLAB_BOT_LOGIN: 'bot' }).isBot,
    true
  );
});

test('gitlab deliver：新建评论后按保留期清理旧提醒 note', async () => {
  const notes = [
    {
      id: 1, system: false, body: '旧提醒\nmoocflow 自动提醒',
      created_at: new Date(NOW - 10 * DAY).toISOString(), author: { username: 'me' }
    },
    {
      id: 2, system: false, body: '普通评论',
      created_at: new Date(NOW - 9 * DAY).toISOString(), author: { username: 'other' }
    },
    {
      id: 3, system: false, body: '最近提醒\nmoocflow 自动提醒',
      created_at: new Date(NOW - 1 * DAY).toISOString(), author: { username: 'me' }
    }
  ];
  const stub = stubFetch((url, options) => {
    if (options.method === 'POST') {
      return okResponse({ id: 9, body: JSON.parse(options.body).body, created_at: new Date().toISOString() }, 201);
    }
    if (options.method === 'DELETE') return okResponse({});
    return okResponse(notes);
  });
  try {
    const res = await gitlab.deliver(makeDoc(), ENV, NOW);
    assert.equal(res.sent, true);
    assert.equal(
      res.detail,
      '评论已发布：https://jihulab.com/group/repo/-/issues/3；已清理 1 条超过保留期（7 天）的旧评论'
    );

    const create = stub.calls.find((c) => c.options.method === 'POST');
    assert.equal(create.url, 'https://jihulab.com/api/v4/projects/42/issues/3/notes');
    assert.equal(create.options.headers['PRIVATE-TOKEN'], 'glpat-test');
    assert.equal(create.options.headers['Content-Type'], 'application/json');
    assert.match(JSON.parse(create.options.body).body, /## 📬 MOOC 截止提醒/);

    const list = stub.calls.find((c) => !c.options.method);
    assert.equal(
      list.url,
      'https://jihulab.com/api/v4/projects/42/issues/3/notes?order_by=created_at&sort=asc&per_page=100&page=1'
    );

    const deletes = stub.calls.filter((c) => c.options.method === 'DELETE');
    assert.deepEqual(deletes.map((c) => c.url), [
      'https://jihulab.com/api/v4/projects/42/issues/3/notes/1'
    ]);
  } finally {
    stub.restore();
  }
});

test('gitlab deliver：未配置时降级为 sent:false', async () => {
  const res = await gitlab.deliver(makeDoc(), {}, NOW);
  assert.deepEqual(res, { sent: false, detail: '未配置 GITLAB_TOKEN / CI_PROJECT_ID' });
});

test('gitlab deliver：403 提示 token scope 或成员权限', async () => {
  const stub = stubFetch((url, options) =>
    options.method === 'POST' ? errorResponse(403, '{"message":"403 Forbidden"}') : okResponse([])
  );
  try {
    await assert.rejects(gitlab.deliver(makeDoc(), ENV, NOW), (e) => {
      assert.match(e.message, /GitLab 评论发布失败：HTTP 403/);
      assert.match(e.message, /api scope/);
      return true;
    });
  } finally {
    stub.restore();
  }
});
