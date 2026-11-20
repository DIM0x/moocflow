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

test('pushplus 子渠道：wechat 目标走 markdown 模板', async () => {
  const stub = stubFetch((url) => okResponse({ code: 200, msg: '请求成功' }));
  try {
    const res = await wechat.deliver(
      makeDoc(),
      { WECHAT_CHANNELS: 'pushplus', PUSHPLUS_TOKEN: 'pp-token' },
      NOW
    );
    assert.equal(res.sent, true);
    assert.match(res.detail, /^pushplus：/);

    const call = stub.calls[0];
    assert.equal(call.url, 'https://www.pushplus.plus/send');
    const body = JSON.parse(call.options.body);
    assert.equal(body.token, 'pp-token');
    assert.equal(body.template, 'markdown');
    assert.equal(body.channel, undefined);
    assert.match(body.title, /^\[MOOC提醒\]/);
    assert.match(body.content, /共 1 项即将截止/);
  } finally {
    stub.restore();
  }
});

test('pushplus 子渠道：code 非 200 视为失败', async () => {
  const stub = stubFetch(() => okResponse({ code: 905, msg: '未实名' }));
  try {
    await assert.rejects(
      wechat.deliver(makeDoc(), { WECHAT_CHANNELS: 'pushplus', PUSHPLUS_TOKEN: 't' }, NOW),
      /code=905.*未实名/
    );
  } finally {
    stub.restore();
  }
});

test('wxpusher 子渠道：SPT 极简推送（多个 SPT 逐个发送）', async () => {
  const stub = stubFetch((url) => okResponse({ code: 1000, msg: '处理成功' }));
  try {
    const res = await wechat.deliver(
      makeDoc(),
      { WECHAT_CHANNELS: 'wxpusher', WXPUSHER_SPT: 'SPT_a, SPT_b' },
      NOW
    );
    assert.equal(res.sent, true);
    assert.match(res.detail, /SPT 极简推送，2 个接收方/);

    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].url, 'https://wxpusher.zjiecode.com/api/send/message/simple-push');
    const body = JSON.parse(stub.calls[0].options.body);
    assert.equal(body.spt, 'SPT_a');
    assert.equal(body.contentType, 3);
    assert.match(body.content, /共 1 项即将截止/);
    assert.ok(body.summary.length <= 100);
  } finally {
    stub.restore();
  }
});

test('wxpusher 子渠道：标准应用推送（appToken + 多 UID）', async () => {
  const stub = stubFetch((url) => okResponse({ code: 1000, msg: '处理成功' }));
  try {
    const res = await wechat.deliver(
      makeDoc(),
      {
        WECHAT_CHANNELS: 'wxpusher',
        WXPUSHER_APP_TOKEN: 'AT_x',
        WXPUSHER_UID: 'UID_1,UID_2'
      },
      NOW
    );
    assert.equal(res.sent, true);
    assert.match(res.detail, /应用推送，2 个 UID/);

    const body = JSON.parse(stub.calls[0].options.body);
    assert.equal(stub.calls[0].url, 'https://wxpusher.zjiecode.com/api/send/message');
    assert.equal(body.appToken, 'AT_x');
    assert.deepEqual(body.uids, ['UID_1', 'UID_2']);
    assert.equal(body.contentType, 3);
  } finally {
    stub.restore();
  }
});

test('wxpusher 子渠道：code 非 1000 视为失败', async () => {
  const stub = stubFetch(() => okResponse({ code: 1001, msg: 'content 超过最大限制' }));
  try {
    await assert.rejects(
      wechat.deliver(makeDoc(), { WECHAT_CHANNELS: 'wxpusher', WXPUSHER_SPT: 'SPT_a' }, NOW),
      /code=1001/
    );
  } finally {
    stub.restore();
  }
});

test('fallback：第一个子渠道失败自动降级到下一个，detail 指明成功者', async () => {
  const stub = stubFetch((url) =>
    url.includes('sctapi.ftqq.com')
      ? errorResponse(400, '{"code":400,"message":"invalid key"}')
      : okResponse({ code: 1000, msg: '处理成功' })
  );
  try {
    const res = await wechat.deliver(
      makeDoc(),
      {
        WECHAT_CHANNELS: 'serverchan,wxpusher',
        SERVERCHAN_SENDKEY: 'bad',
        WXPUSHER_SPT: 'SPT_a'
      },
      NOW
    );
    assert.equal(res.sent, true);
    assert.match(res.detail, /^wxpusher：/);
    // 第一个请求发给 Server酱，降级后第二个请求发给 WxPusher
    assert.match(stub.calls[0].url, /sctapi\.ftqq\.com/);
    assert.match(stub.calls[1].url, /wxpusher\.zjiecode\.com/);
  } finally {
    stub.restore();
  }
});

test('fallback：全部子渠道失败时抛聚合错误（含每个失败原因）', async () => {
  const stub = stubFetch(() => errorResponse(500, 'server error'));
  try {
    await assert.rejects(
      wechat.deliver(
        makeDoc(),
        {
          WECHAT_CHANNELS: 'serverchan,wxpusher',
          SERVERCHAN_SENDKEY: 'k',
          WXPUSHER_SPT: 'SPT_a'
        },
        NOW
      ),
      (e) => {
        assert.match(e.message, /所有子渠道发送失败/);
        assert.match(e.message, /serverchan：/);
        assert.match(e.message, /wxpusher：/);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});
