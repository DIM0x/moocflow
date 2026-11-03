import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIssueChannel, isReminderComment, selectExpiredComments } from '../src/channels/issue-factory.mjs';
import * as github from '../src/channels/github.mjs';
import { buildReminderDoc } from '../src/report.mjs';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

function makeDoc({ cookieRefresh } = {}) {
  const itemDue = {
    id: 'u1', title: '第一周测验', type: 'quiz', chapter: '第一章', lesson: '1.1',
    courseName: '测试课程', url: 'https://www.icourse163.org/learn/NEU-1002822009?tid=1488060444'
  };
  const itemOver = { ...itemDue, id: 'u2', title: '第一周作业', type: 'homework' };
  return buildReminderDoc({
    windowHours: 72, overdueDays: 7, coursesTotal: 1, coursesOk: 1,
    failures: ['坏课程: HTTP 500'],
    due: [{ item: itemDue, kind: 'submit', dueMs: NOW + 24 * HOUR }],
    overdue: [{ item: itemOver, kind: 'peerreview', dueMs: NOW - HOUR }],
    cookieRefresh,
    now: NOW
  });
}

function okResponse(data) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function errorResponse(status, text) {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

/**
 * 最小可用的假平台：记录全部请求的内存版 issue API。
 * pageSize 设为 2，便于用少量种子评论覆盖翻页与"碰到新评论即停"的分支。
 */
function fakePlatform() {
  const state = { comments: [], nextId: 1, calls: [], deleteNotFound: false };
  const description = {
    name: 'fakegit',
    errorLabel: 'FakeGit',
    pageSize: 2,
    isConfigured: (env) => Boolean(env.FAKE_TOKEN && env.FAKE_REPO),
    unconfiguredDetail: '未配置 FAKE_TOKEN / FAKE_REPO',
    createRequest: (env, issueNumber, body) => {
      state.calls.push(['create', issueNumber]);
      return {
        url: `https://fake.test/repos/${env.FAKE_REPO}/issues/${issueNumber}/comments`,
        options: { method: 'POST', body }
      };
    },
    listRequest: (env, issueNumber, page) => {
      state.calls.push(['list', issueNumber, page]);
      return { url: `https://fake.test/list?page=${page}`, options: {} };
    },
    deleteRequest: (env, commentId) => {
      state.calls.push(['delete', commentId]);
      return { url: `https://fake.test/comments/${commentId}`, options: { method: 'DELETE' } };
    },
    mapComment: (raw) => ({ id: raw.id, body: raw.body, created_at: raw.created_at, isBot: raw.isBot }),
    mapCreated: (raw) => ({ id: raw.id, url: `https://fake.test/issues/${raw.id}` })
  };

  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      const comment = { id: state.nextId++, body: options.body, created_at: new Date().toISOString() };
      state.comments.push(comment);
      return okResponse({ id: comment.id });
    }
    if (options.method === 'DELETE') {
      if (state.deleteNotFound) return errorResponse(404, 'not found');
      const id = Number(url.split('/').pop());
      state.comments = state.comments.filter((c) => c.id !== id);
      return okResponse({});
    }
    const page = Number(new URL(url).searchParams.get('page'));
    const sorted = [...state.comments].sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
    );
    const items = sorted
      .slice((page - 1) * description.pageSize, page * description.pageSize)
      .map((c) => ({ ...c }));
    return okResponse(items);
  };

  return { description, state, fetchImpl };
}

/** 给假平台播种一批历史评论；签名为正文里含 BODY_SIGNATURE。 */
function seed(state, list) {
  for (const [id, daysAgo, isBot, signed] of list) {
    state.comments.push({
      id,
      body: signed ? `提醒内容\nmoocflow 自动提醒` : '与提醒无关的评论',
      created_at: new Date(NOW - daysAgo * DAY).toISOString(),
      isBot
    });
  }
}

test('归一化评论识别：isBot + 签名才算提醒评论；keepId 与过期时间生效', () => {
  const comments = [
    { id: 1, body: '提醒\nmoocflow 自动提醒', created_at: new Date(NOW - 10 * DAY).toISOString(), isBot: true },
    { id: 2, body: '提醒\nmoocflow 自动提醒', created_at: new Date(NOW - 10 * DAY).toISOString(), isBot: false },
    { id: 3, body: '无关评论', created_at: new Date(NOW - 10 * DAY).toISOString(), isBot: true },
    { id: 4, body: '提醒\nmoocflow 自动提醒', created_at: new Date(NOW - 1 * DAY).toISOString(), isBot: true }
  ];
  assert.deepEqual(selectExpiredComments(comments, NOW - 7 * DAY, 4).map((c) => c.id), [1]);
  assert.equal(isReminderComment(comments[0]), true);
  assert.equal(isReminderComment(comments[1]), false);
  assert.equal(isReminderComment(comments[2]), false);
  assert.equal(isReminderComment({}), false);
  assert.deepEqual(selectExpiredComments([], NOW, 1), []);
});

test('未配置时 deliver 降级为 sent:false，detail 来自平台描述且不发请求', async () => {
  const { description, fetchImpl } = fakePlatform();
  const channel = createIssueChannel(description, {
    fetchImpl: async () => {
      throw new Error('未配置时不应发起请求');
    }
  });
  const res = await channel.deliver(makeDoc(), {}, NOW);
  assert.deepEqual(res, { sent: false, detail: '未配置 FAKE_TOKEN / FAKE_REPO' });
});

test('配置非法时先报错（清理配置在发布前解析），不发出任何请求', async () => {
  const { description, state, fetchImpl } = fakePlatform();
  const channel = createIssueChannel(description, { fetchImpl });
  await assert.rejects(
    channel.deliver(makeDoc(), { FAKE_TOKEN: 't', FAKE_REPO: 'o/r', COMMENT_RETENTION_DAYS: '-1' }, NOW),
    /COMMENT_RETENTION_DAYS/
  );
  assert.deepEqual(state.calls, []);
});

test('deliver 完整流程：发布评论 + 只清理过期且带签名的 bot 旧评论', async () => {
  const { description, state, fetchImpl } = fakePlatform();
  seed(state, [
    [101, 10, true, true],   // 超期 bot 提醒：删除
    [102, 10, false, true],  // 超期但非 bot：保留
    [105, 10, true, true],   // 超期 bot 提醒（第 2 页）：删除
    [103, 9, true, false],   // 超期 bot 但无签名：保留
    [104, 6, true, true],    // 保留期内：保留
    [106, 0, true, true]     // 1 小时前（相对 NOW 为 0 天）：碰到即停翻页
  ]);
  const channel = createIssueChannel(description, { fetchImpl });
  const res = await channel.deliver(
    makeDoc(),
    { FAKE_TOKEN: 't', FAKE_REPO: 'o/r', REMINDER_ISSUE_NUMBER: '7' },
    NOW
  );

  assert.equal(res.sent, true);
  assert.match(res.detail, /评论已发布：https:\/\/fake\.test\/issues\//);
  assert.match(res.detail, /已清理 2 条超过保留期（7 天）的旧评论/);

  // 发布：POST 到 issue 7，正文带签名
  const createCalls = state.calls.filter(([kind]) => kind === 'create');
  assert.deepEqual(createCalls, [['create', 7]]);

  // 翻页：pageSize=2、共 7 条（含新发布的），第 3 页碰到新评论即停，不发第 4 页
  const pages = state.calls.filter(([kind]) => kind === 'list').map(([, , page]) => page);
  assert.deepEqual(pages, [1, 2, 3]);

  // 清理：只删 101 与 105
  const deleted = state.calls.filter(([kind]) => kind === 'delete').map(([, id]) => id);
  assert.deepEqual(deleted, [101, 105]);
});

test('单条删除 404 视为已删除，不影响清理结果', async () => {
  const { description, state, fetchImpl } = fakePlatform();
  seed(state, [[201, 10, true, true]]);
  state.deleteNotFound = true;
  const channel = createIssueChannel(description, { fetchImpl });
  const res = await channel.deliver(makeDoc(), { FAKE_TOKEN: 't', FAKE_REPO: 'o/r' }, NOW);
  assert.equal(res.sent, true);
  assert.match(res.detail, /已清理 1 条超过保留期（7 天）的旧评论/);
  assert.doesNotMatch(res.detail, /删除失败/);
});

test('发布失败：报错带平台名与 404 默认提示', async () => {
  const { description } = fakePlatform();
  const channel = createIssueChannel(description, {
    fetchImpl: async () => errorResponse(404, '{"message":"Not Found"}')
  });
  await assert.rejects(
    channel.deliver(makeDoc(), { FAKE_TOKEN: 't', FAKE_REPO: 'o/r' }, NOW),
    (e) => {
      assert.match(e.message, /FakeGit 评论发布失败：HTTP 404/);
      assert.match(e.message, /REMINDER_ISSUE_NUMBER/);
      return true;
    }
  );
});

test('github 渠道经工厂装配后仍走 GitHub API（全局 fetch 打桩冒烟）', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      return okResponse({ id: 9, html_url: 'https://github.com/o/r/issues/1#issuecomment-9' });
    }
    if (options.method === 'DELETE') return okResponse({});
    return okResponse([]); // 列表为空：无旧评论可清理
  };
  try {
    const env = { GITHUB_TOKEN: 't0', GITHUB_REPOSITORY: 'o/r', REMINDER_ISSUE_NUMBER: '1' };
    const res = await github.deliver(makeDoc(), env, NOW);
    assert.equal(res.sent, true);
    assert.match(res.detail, /评论已发布：https:\/\/github\.com\/o\/r\/issues\/1#issuecomment-9/);

    assert.equal(calls.length, 2); // 1 次发布 + 1 次列表（空页即停）
    assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues/1/comments');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer t0');
    assert.equal(calls[0].options.body, JSON.stringify({ body: github.buildCommentBody(makeDoc(), NOW) }));
    assert.equal(calls[1].url, 'https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
