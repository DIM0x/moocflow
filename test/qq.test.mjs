import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as qq from '../src/channels/qq.mjs';
import { stripUrls } from '../src/channels/push/qmsg.mjs';
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

test('stripUrls：独立链接行整行移除、行内链接替换、空行收紧', () => {
  const text =
    '共 1 项即将截止。\n\n🔔即将截止【测试课程】第一周测验\n  提交截止：xx\nhttps://www.icourse163.org/learn/a?tid=1\n\n详见 https://example.com/x 和后续内容\n\n—— moocflow';
  const stripped = stripUrls(text);
  assert.doesNotMatch(stripped, /https?:\/\//);
  assert.doesNotMatch(stripped, /icourse163/);
  assert.match(stripped, /（链接略）\s*和后续内容/);
  assert.match(stripped, /—— moocflow/);
  assert.doesNotMatch(stripped, /\n{3,}/);
});

test('qmsg 子渠道：form 发送、剥离 URL、成功看 success 字段', async () => {
  const stub = stubFetch((url) => okResponse({ success: true, message: '操作成功', code: 0, data: 42 }));
  try {
    const res = await qq.deliver(makeDoc(), { QQ_CHANNELS: 'qmsg', QMSG_KEY: 'qmsg-key' }, NOW);
    assert.equal(res.sent, true);
    assert.match(res.detail, /^qmsg：.*QQ 私聊/);

    const call = stub.calls[0];
    assert.equal(call.url, 'https://qmsg.zendee.cn/v3/send/qmsg-key');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.options.body);
    assert.doesNotMatch(form.get('msg'), /https?:\/\//);
    assert.match(form.get('msg'), /共 1 项即将截止/);
    assert.equal(form.get('group'), null);
    assert.ok(form.get('msg').length <= 1800);
  } finally {
    stub.restore();
  }
});

test('qmsg 子渠道：QMSG_GROUP 走群聊参数', async () => {
  const stub = stubFetch(() => okResponse({ success: true, code: 0 }));
  try {
    const res = await qq.deliver(
      makeDoc(),
      { QQ_CHANNELS: 'qmsg', QMSG_KEY: 'k', QMSG_GROUP: '123456' },
      NOW
    );
    assert.match(res.detail, /群聊/);
    const form = new URLSearchParams(stub.calls[0].options.body);
    assert.equal(form.get('group'), '123456');
  } finally {
    stub.restore();
  }
});

test('qmsg 子渠道：HTTP 200 但 success=false 视为失败', async () => {
  const stub = stubFetch(() => okResponse({ success: false, message: '未绑定机器人', code: 500 }));
  try {
    await assert.rejects(
      qq.deliver(makeDoc(), { QQ_CHANNELS: 'qmsg', QMSG_KEY: 'k' }, NOW),
      /HTTP 200 code=500.*未绑定机器人/
    );
  } finally {
    stub.restore();
  }
});

test('qqbot 子渠道：先取 token 再逐群发送，Authorization 头与 msgType 正确', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('getAppAccessToken')) return okResponse({ access_token: 'tok-1', expires_in: 7200 });
    return okResponse({ code: 0, message: '成功' });
  });
  try {
    const res = await qq.deliver(
      makeDoc(),
      {
        QQ_CHANNELS: 'qqbot',
        QQ_BOT_APP_ID: 'appid',
        QQ_BOT_SECRET: 'secret',
        QQ_BOT_GROUP_OPENID: 'GID_1,GID_2'
      },
      NOW
    );
    assert.equal(res.sent, true);
    assert.match(res.detail, /2 个群/);

    assert.equal(stub.calls[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
    assert.deepEqual(JSON.parse(stub.calls[0].options.body), { appId: 'appid', clientSecret: 'secret' });

    assert.equal(stub.calls.length, 3); // 1 次取 token + 2 个群
    for (const send of stub.calls.slice(1)) {
      assert.match(send.url, /https:\/\/api\.bot\.qq\.com\/v2\/groups\/GID_[12]\/messages/);
      assert.equal(send.options.headers.Authorization, 'QQBot tok-1');
      const body = JSON.parse(send.options.body);
      assert.equal(body.msgType, 0);
      assert.match(body.content, /共 1 项即将截止/);
    }
  } finally {
    stub.restore();
  }
});

test('qqbot 子渠道：token 失败（HTTP 200 但 body code 非 0）抛错', async () => {
  const stub = stubFetch(() => okResponse({ code: 100016, message: 'appId 或 secret 不正确' }));
  try {
    await assert.rejects(
      qq.deliver(
        makeDoc(),
        {
          QQ_CHANNELS: 'qqbot',
          QQ_BOT_APP_ID: 'bad',
          QQ_BOT_SECRET: 'bad',
          QQ_BOT_GROUP_OPENID: 'GID_1'
        },
        NOW
      ),
      /获取 token 失败：HTTP 200 code=100016.*appId 或 secret 不正确/
    );
  } finally {
    stub.restore();
  }
});

test('qqbot 子渠道：发送频控（body code 非 0）抛错并指明群', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('getAppAccessToken')) return okResponse({ access_token: 'tok' });
    return okResponse({ code: 40034105, message: '超过主动消息频控' });
  });
  try {
    await assert.rejects(
      qq.deliver(
        makeDoc(),
        {
          QQ_CHANNELS: 'qqbot',
          QQ_BOT_APP_ID: 'a',
          QQ_BOT_SECRET: 'b',
          QQ_BOT_GROUP_OPENID: 'GID_1'
        },
        NOW
      ),
      /群 GID_1.*code=40034105.*频控/
    );
  } finally {
    stub.restore();
  }
});

test('pushplus 子渠道：qq 目标走 channel=qq + txt 模板（标题摘要渠道）', async () => {
  const stub = stubFetch(() => okResponse({ code: 200, msg: '请求成功' }));
  try {
    const res = await qq.deliver(makeDoc(), { QQ_CHANNELS: 'pushplus', PUSHPLUS_TOKEN: 'pp' }, NOW);
    assert.equal(res.sent, true);
    const body = JSON.parse(stub.calls[0].options.body);
    assert.equal(body.channel, 'qq');
    assert.equal(body.template, 'txt');
    assert.match(body.title, /^\[MOOC提醒\]/);
  } finally {
    stub.restore();
  }
});

test('fallback：qmsg 失败自动降级到 pushplus', async () => {
  const stub = stubFetch((url) =>
    url.includes('qmsg.zendee.cn')
      ? okResponse({ success: false, message: '机器人下线', code: 500 })
      : okResponse({ code: 200, msg: 'ok' })
  );
  try {
    const res = await qq.deliver(
      makeDoc(),
      { QQ_CHANNELS: 'qmsg,pushplus', QMSG_KEY: 'k', PUSHPLUS_TOKEN: 'pp' },
      NOW
    );
    assert.equal(res.sent, true);
    assert.match(res.detail, /^pushplus：/);
  } finally {
    stub.restore();
  }
});
