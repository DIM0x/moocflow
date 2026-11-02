import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectChannel, availableChannels, DEFAULT_CHANNEL } from '../src/channels/index.mjs';
import * as github from '../src/channels/github.mjs';
import * as mail from '../src/channels/mail.mjs';
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
  assert.deepEqual(availableChannels().sort(), ['github', 'mail']);
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
  // 渲染不改变文档
  assert.equal(makeDoc().events.length, 2);
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

test('github 渠道契约：isConfigured 三要素', () => {
  assert.equal(github.isConfigured({}), false);
  assert.equal(
    github.isConfigured({ GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', REMINDER_ISSUE_NUMBER: '1' }),
    true
  );
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
  assert.deepEqual(res, { sent: false, detail: '未配置 GITHUB_TOKEN / GITHUB_REPOSITORY / REMINDER_ISSUE_NUMBER' });
});

test('mail.deliver 未配置时降级为 sent:false', async () => {
  const res = await mail.deliver(makeDoc(), {}, NOW);
  assert.match(res.detail, /未配置 SMTP_HOST/);
  assert.equal(res.sent, false);
});
