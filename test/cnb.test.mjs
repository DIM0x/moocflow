import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cnb from '../src/channels/cnb.mjs';
import { mapComment, issueUrl, resolveCnbRepo } from '../src/channels/cnb.mjs';
import { buildReminderDoc } from '../src/report.mjs';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const HOUR = 3600 * 1000;

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
  CNB_TOKEN: 'cnb-token',
  CNB_REPO_SLUG: 'group/repo',
  CNB_API_ENDPOINT: 'https://api.cnb.cool',
  CNB_TOKEN_USER_NAME: 'cnb',
  REMINDER_ISSUE_NUMBER: '3'
};

test('cnb 渠道 isConfigured：令牌与仓库路径齐备即可（issue 编号有默认值）', () => {
  assert.equal(cnb.isConfigured({}), false);
  assert.equal(cnb.isConfigured({ CNB_TOKEN: 't', CNB_REPO_SLUG: 'g/r' }), true);
  // 通用别名 REPO_SLUG 兜底，便于本地调试
  assert.equal(cnb.isConfigured({ CNB_TOKEN: 't', REPO_SLUG: 'g/r' }), true);
  assert.equal(cnb.isConfigured({ CNB_TOKEN: '   ', CNB_REPO_SLUG: 'g/r' }), false);
});

test('cnb 仓库路径与 issue URL：原生变量优先、可自定义 Web 地址', () => {
  assert.equal(resolveCnbRepo({ CNB_REPO_SLUG: 'g/r', REPO_SLUG: 'a/b' }), 'g/r');
  assert.equal(resolveCnbRepo({ REPO_SLUG: 'a/b' }), 'a/b');
  assert.equal(
    issueUrl({ CNB_REPO_SLUG: 'g/r' }, 5),
    'https://cnb.cool/g/r/-/issues/5'
  );
  assert.equal(
    issueUrl({ CNB_REPO_SLUG: 'g/r', CNB_WEB_ENDPOINT: 'https://cnb.example.com/' }, 5),
    'https://cnb.example.com/g/r/-/issues/5'
  );
});

test('cnb mapComment：作者为令牌用户 cnb 时视为 bot', () => {
  const raw = { id: 'c1', body: '提醒\nmoocflow 自动提醒', created_at: '2026-11-01T00:00:00Z' };
  assert.equal(mapComment({ ...raw, author: { username: 'cnb' } }, ENV).isBot, true);
  assert.equal(mapComment({ ...raw, author: { username: 'someone' } }, ENV).isBot, false);
  assert.equal(mapComment({ ...raw, author: {} }, ENV).isBot, false);
  // 本地调试可覆盖 bot 登录名
  assert.equal(
    mapComment({ ...raw, author: { username: 'me' } }, { CNB_BOT_LOGIN: 'me' }).isBot,
    true
  );
});

test('cnb deliver：已有提醒评论时覆盖更新，不新建', async () => {
  const existing = {
    id: 'c1',
    body: '旧提醒\nmoocflow 自动提醒\n<!-- moocflow-reminder -->',
    created_at: '2026-11-01T00:00:00Z',
    author: { username: 'cnb' }
  };
  const stub = stubFetch((url, options) => {
    if (options.method === 'PATCH') {
      return okResponse({ ...existing, body: JSON.parse(options.body).body });
    }
    return okResponse([existing]);
  });
  try {
    const res = await cnb.deliver(makeDoc(), ENV, NOW);
    assert.equal(res.sent, true);
    assert.equal(res.detail, '评论已更新：https://cnb.cool/group/repo/-/issues/3');

    assert.equal(stub.calls.length, 2);
    assert.equal(
      stub.calls[0].url,
      'https://api.cnb.cool/group/repo/-/issues/3/comments?sort=created&page=1&page_size=100'
    );
    assert.equal(stub.calls[0].options.headers.Authorization, 'Bearer cnb-token');

    assert.equal(
      stub.calls[1].url,
      'https://api.cnb.cool/group/repo/-/issues/3/comments/c1'
    );
    assert.equal(stub.calls[1].options.method, 'PATCH');
    assert.match(JSON.parse(stub.calls[1].options.body).body, /## 📬 MOOC 截止提醒/);
    assert.ok(!stub.calls.some((c) => c.options.method === 'POST'));
  } finally {
    stub.restore();
  }
});

test('cnb deliver：没有历史提醒评论时新建一条', async () => {
  const stub = stubFetch((url, options) => {
    if (options.method === 'POST') {
      return okResponse({ id: 'c9', body: JSON.parse(options.body).body, created_at: new Date().toISOString() }, 201);
    }
    return okResponse([]);
  });
  try {
    const res = await cnb.deliver(makeDoc(), ENV, NOW);
    assert.equal(res.sent, true);
    assert.equal(res.detail, '评论已发布：https://cnb.cool/group/repo/-/issues/3');

    const post = stub.calls.find((c) => c.options.method === 'POST');
    assert.equal(post.url, 'https://api.cnb.cool/group/repo/-/issues/3/comments');
    assert.equal(post.options.headers['Content-Type'], 'application/json');
    assert.match(JSON.parse(post.options.body).body, /moocflow 自动提醒/);
  } finally {
    stub.restore();
  }
});

test('cnb deliver：自定义 API 端点与结尾斜杠归一化', async () => {
  const stub = stubFetch(() => okResponse([]));
  try {
    await cnb.deliver(
      makeDoc(),
      { ...ENV, CNB_API_ENDPOINT: 'https://api.example.com/v1/' },
      NOW
    );
    assert.equal(
      stub.calls[0].url,
      'https://api.example.com/v1/group/repo/-/issues/3/comments?sort=created&page=1&page_size=100'
    );
  } finally {
    stub.restore();
  }
});

test('cnb deliver：CNB_ISSUE_UPDATE_MODE=0 时每次只发新评论，不改旧评论', async () => {
  const stub = stubFetch((url, options) => {
    if (options.method === 'POST') return okResponse({ id: 'c-new' }, 201);
    return okResponse([{ id: 'c-old', body: '旧\nmoocflow 自动提醒', created_at: '2026-01-01T00:00:00Z', author: { username: 'cnb' } }]);
  });
  try {
    const res = await cnb.deliver(makeDoc(), { ...ENV, CNB_ISSUE_UPDATE_MODE: '0' }, NOW);
    assert.equal(res.detail, '评论已发布：https://cnb.cool/group/repo/-/issues/3');
    assert.ok(!stub.calls.some((c) => c.options.method === 'PATCH'));
    assert.equal(stub.calls.filter((c) => c.options.method === 'POST').length, 1);
    // 模式 0 不需要列出历史评论
    assert.ok(!stub.calls.some((c) => c.url.includes('?')));
  } finally {
    stub.restore();
  }
});

test('cnb deliver：CNB_ISSUE_UPDATE_MODE 非法时直接报错', async () => {
  await assert.rejects(
    cnb.deliver(makeDoc(), { ...ENV, CNB_ISSUE_UPDATE_MODE: '2' }, NOW),
    /CNB_ISSUE_UPDATE_MODE 只能是 0\/1/
  );
});

test('cnb deliver：未配置时降级为 sent:false', async () => {
  const res = await cnb.deliver(makeDoc(), {}, NOW);
  assert.deepEqual(res, { sent: false, detail: '未配置 CNB_TOKEN / CNB_REPO_SLUG' });
});

test('cnb deliver：发布失败带平台名与 CNB 专属提示', async () => {
  const stub = stubFetch((url, options) =>
    options.method === 'POST' ? errorResponse(404, '{"message":"not found"}') : okResponse([])
  );
  try {
    await assert.rejects(cnb.deliver(makeDoc(), ENV, NOW), (e) => {
      assert.match(e.message, /CNB 评论发布失败：HTTP 404/);
      assert.match(e.message, /repo-notes:rw/);
      return true;
    });
  } finally {
    stub.restore();
  }
});
