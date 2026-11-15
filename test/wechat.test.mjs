import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as wechat from '../src/channels/wechat.mjs';
import { resolveOrder, deliverOrdered, buildPushPreview } from '../src/channels/push/index.mjs';
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

test('resolveOrder：逗号分隔、大小写不敏感、过滤空项、未设置为空数组', () => {
  assert.deepEqual(resolveOrder('ServerChan, WXPusher ,,pushplus'), ['serverchan', 'wxpusher', 'pushplus']);
  assert.deepEqual(resolveOrder(''), []);
  assert.deepEqual(resolveOrder(undefined), []);
  assert.deepEqual(resolveOrder('  '), []);
});

test('wechat renderPreview：输出共享推送正文', () => {
  const preview = wechat.renderPreview(makeDoc(), NOW);
  assert.match(preview, /共 1 项即将截止（48 小时内），0 项已过期未完成/);
  assert.match(preview, /🔔即将截止【测试课程】第一章 \/ 1\.1 · 第一周测验（测验）/);
  assert.match(preview, /https:\/\/www\.icourse163\.org/);
  assert.match(preview, /moocflow 自动提醒/);
});

test('deliverOrdered：未知子渠道名抛错（配置错误必须可见）', async () => {
  await assert.rejects(
    deliverOrdered({
      orderRaw: 'serverchan,telegram', orderVar: 'WECHAT_CHANNELS', orderExample: 'serverchan',
      target: 'wechat', doc: makeDoc(), env: {}, now: NOW
    }),
    /子渠道不可用：telegram/
  );
});

test('deliverOrdered：按顺序成功发送，detail 标明实际子渠道', async () => {
  const stub = stubFetch((url) => okResponse({ code: 0 }));
  try {
    const res = await wechat.deliver(
      makeDoc(),
      { WECHAT_CHANNELS: 'serverchan', SERVERCHAN_SENDKEY: 'SCT-key-1' },
      NOW
    );
    assert.equal(res.sent, true);
    assert.match(res.detail, /^serverchan：/);

    const call = stub.calls[0];
    assert.equal(call.url, 'https://sctapi.ftqq.com/SCT-key-1.send');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.options.body);
    assert.match(form.get('title'), /^\[MOOC提醒\]/);
    assert.ok(form.get('title').length <= 32);
    assert.match(form.get('desp'), /共 1 项即将截止/);
  } finally {
    stub.restore();
  }
});

test('deliverOrdered：SendKey 非法（HTTP 4xx）时抛错且 step 失败', async () => {
  const stub = stubFetch(() => errorResponse(400, '{"code":400,"message":"invalid key"}'));
  try {
    await assert.rejects(
      wechat.deliver(makeDoc(), { WECHAT_CHANNELS: 'serverchan', SERVERCHAN_SENDKEY: 'bad' }, NOW),
      /Server酱 发送失败：HTTP 400/
    );
  } finally {
    stub.restore();
  }
});

test('deliverOrdered：HTTP 200 但业务 code 非 0 也视为失败', async () => {
  const stub = stubFetch(() => okResponse({ code: 40001, message: '超出每日 5 条限制' }));
  try {
    await assert.rejects(
      wechat.deliver(makeDoc(), { WECHAT_CHANNELS: 'serverchan', SERVERCHAN_SENDKEY: 'k' }, NOW),
      /code=40001.*超出每日 5 条限制/
    );
  } finally {
    stub.restore();
  }
});
