import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectChannel, availableChannels, DEFAULT_CHANNEL } from '../src/channels/index.mjs';
import * as github from '../src/channels/github.mjs';
import * as mail from '../src/channels/mail.mjs';
import * as wechat from '../src/channels/wechat.mjs';
import * as qq from '../src/channels/qq.mjs';
import { buildReminderDoc } from '../src/report.mjs';

const NOW = Date.now();
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

test('selectChannel 渠道选择：默认 github、大小写不敏感、未知报错', () => {
  assert.equal(selectChannel(undefined).name, 'github');
  assert.equal(selectChannel('').name, 'github');
  assert.equal(selectChannel('GITHUB').name, 'github');
  assert.equal(selectChannel(' mail ').name, 'mail');
  assert.deepEqual(availableChannels().sort(), ['cnb', 'gitee', 'github', 'gitlab', 'mail', 'qq', 'wechat']);
  assert.equal(DEFAULT_CHANNEL, 'github');
  let errMessage = '';
  try {
    selectChannel('telegram');
  } catch (e) {
    errMessage = e.message;
  }
  assert.match(errMessage, /未知通知方式 "telegram"/);
  assert.match(errMessage, /github/);
  assert.match(errMessage, /mail/);
});

test('github.buildCommentBody 渲染 markdown 表格与失败提示', () => {
  const body = github.buildCommentBody(makeDoc(), NOW);
  assert.match(body, /## 📬 MOOC 截止提醒/);
  assert.match(body, /共 \*\*1\*\* 项即将截止（72 小时内），\*\*1\*\* 项已过期未完成/);
  assert.match(body, /\| ⚠ 已过期 \| 测试课程 \|.*\[第一周作业\]\(https:\/\/www\.icourse163\.org[^\)]*\)（作业）/);
  assert.match(body, /\| 🔔 即将截止 \| 测试课程 \|.*\[第一周测验\]\(https:\/\/www\.icourse163\.org[^\)]*\)（测验）/);
  assert.match(body, /互评截止|提交截止/);
  assert.match(body, /1 门课程拉取失败[^：]*：坏课程: HTTP 500/);
  // 隐藏标记用于识别本项目发布的评论，供旧评论清理使用
  assert.match(body, /<!-- moocflow-reminder -->/);
  // 渲染不改变文档
  assert.equal(makeDoc().events.length, 2);
});

test('github 旧评论筛选：只删超过保留期的 bot 提醒评论', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  const day = 24 * HOUR;
  const bot = { type: 'Bot', login: 'github-actions[bot]' };
  const human = { type: 'User', login: 'someone' };
  const make = (id, daysAgo, { user = bot, body = '提醒\nmoocflow 自动提醒' } = {}) => ({
    id,
    user,
    body,
    created_at: new Date(now - daysAgo * day).toISOString()
  });

  const comments = [
    make(1, 10), // 超期 bot 提醒：删除
    make(2, 8, { user: human, body: '普通评论 moocflow 自动提醒' }), // 超期但由人类发布：保留
    make(3, 9, { body: '与提醒无关的 bot 评论' }), // 超期 bot 但无签名：保留
    make(4, 6), // 在保留期内：保留
    make(5, 20) // 超期但就是本次刚发布的那条：保留
  ];
  const expired = github.selectExpiredComments(comments, now - 7 * day, 5);
  assert.deepEqual(expired.map((c) => c.id), [1]);
  assert.equal(github.isReminderComment(comments[0]), true);
  assert.equal(github.isReminderComment(comments[1]), false);
  assert.equal(github.isReminderComment(comments[2]), false);
  assert.equal(github.isReminderComment(human), false);
  assert.deepEqual(github.selectExpiredComments([], now, 1), []);
});

test('两个渠道在自动刷新 Cookie 后于课程列表下方附带提示', () => {
  const mode1 = { mode: 1 };
  const mode2 = { mode: 2 };
  const github1 = github.buildCommentBody(makeDoc({ cookieRefresh: mode1 }), NOW);
  const github2 = github.buildCommentBody(makeDoc({ cookieRefresh: mode2 }), NOW);
  assert.match(github1, /🔔 即将截止[^\n]*\n\n> 🔑 检测到 Cookie 失效.*仓库 Secret 中的 Cookie 仍为已失效/);
  assert.match(github2, /> 🔑 检测到 Cookie 失效.*自动刷新，并将新 Cookie 存储到仓库 Secret/);

  const mail1 = mail.renderPreview(makeDoc({ cookieRefresh: mode1 }), NOW);
  const mail2 = mail.renderPreview(makeDoc({ cookieRefresh: mode2 }), NOW);
  assert.match(mail1, /🔔即将截止【测试课程】[\s\S]*\n\n🔑 检测到 Cookie 失效.*仓库 Secret 中的 Cookie 仍为已失效/);
  assert.match(mail2, /🔑 检测到 Cookie 失效.*自动刷新，并将新 Cookie 存储到仓库 Secret/);

  assert.doesNotMatch(github.buildCommentBody(makeDoc(), NOW), /🔑/);
  assert.doesNotMatch(mail.renderPreview(makeDoc(), NOW), /🔑/);
});

test('github 渠道契约：isConfigured 只看 token 与仓库名（issue 编号有默认值）', () => {
  assert.equal(github.isConfigured({}), false);
  assert.equal(github.isConfigured({ GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }), true);
});

test('mail 渠道契约：isConfigured 四要素、preview 输出文本', () => {
  assert.equal(mail.isConfigured({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }), false); // 缺 NOTIFY_TO
  assert.equal(
    mail.isConfigured({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', NOTIFY_TO: 'a@b.c' }),
    true
  );
  const preview = mail.renderPreview(makeDoc(), NOW);
  assert.match(preview, /共 1 项即将截止（72 小时内），1 项已过期未完成/);
  assert.match(preview, /⚠已过期【测试课程】.*第一周作业（作业）/);
  assert.match(preview, /🔔即将截止【测试课程】.*第一周测验（测验）/);
});

test('github.deliver 未配置时降级为 sent:false', async () => {
  const res = await github.deliver(makeDoc(), {}, NOW);
  assert.deepEqual(res, { sent: false, detail: '未配置 GITHUB_TOKEN / GITHUB_REPOSITORY' });
});

test('mail.deliver 未配置时降级为 sent:false', async () => {
  const res = await mail.deliver(makeDoc(), {}, NOW);
  assert.match(res.detail, /未配置 SMTP_HOST/);
  assert.equal(res.sent, false);
});

test('wechat 渠道契约：顺序未配或子渠道均未配置时降级为 sent:false', async () => {
  const res1 = await wechat.deliver(makeDoc(), {}, NOW);
  assert.equal(res1.sent, false);
  assert.match(res1.detail, /未配置 WECHAT_CHANNELS/);
  const res2 = await wechat.deliver(makeDoc(), { WECHAT_CHANNELS: 'serverchan' }, NOW);
  assert.equal(res2.sent, false);
  assert.match(res2.detail, /子渠道均未配置所需变量/);
  assert.match(res2.detail, /SERVERCHAN_SENDKEY/);
});

test('qq 渠道契约：顺序未配或子渠道均未配置时降级为 sent:false', async () => {
  const res1 = await qq.deliver(makeDoc(), {}, NOW);
  assert.equal(res1.sent, false);
  assert.match(res1.detail, /未配置 QQ_CHANNELS/);
  const res2 = await qq.deliver(makeDoc(), { QQ_CHANNELS: 'qmsg,qqbot' }, NOW);
  assert.equal(res2.sent, false);
  assert.match(res2.detail, /子渠道均未配置所需变量/);
  assert.match(res2.detail, /QMSG_KEY/);
});

test('聚合渠道 isConfigured：顺序已配且有子渠道可用才为 true', async () => {
  assert.equal(wechat.isConfigured({}), false);
  assert.equal(wechat.isConfigured({ WECHAT_CHANNELS: 'serverchan' }), false); // 缺 SendKey
  assert.equal(wechat.isConfigured({ WECHAT_CHANNELS: 'serverchan', SERVERCHAN_SENDKEY: 'k' }), true);
  assert.equal(qq.isConfigured({ QQ_CHANNELS: 'qmsg' }), false); // 缺 key
  assert.equal(qq.isConfigured({ QQ_CHANNELS: 'qmsg', QMSG_KEY: 'k' }), true);
  assert.equal(qq.isConfigured({ QQ_CHANNELS: 'pushplus', PUSHPLUS_TOKEN: 't' }), true);
  // wechat 子渠道不能出现在 qq 渠道的顺序里（targets 校验在 deliver 时抛错）
  assert.equal(qq.isConfigured({ QQ_CHANNELS: 'serverchan', SERVERCHAN_SENDKEY: 'k' }), true);
  await assert.rejects(
    qq.deliver(makeDoc(), { QQ_CHANNELS: 'serverchan', SERVERCHAN_SENDKEY: 'k' }, NOW),
    /子渠道不可用：serverchan/
  );
});
