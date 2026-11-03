import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, resolveDetectionConfig, resolveGithubConfig, resolveNotifyConfig } from '../src/config.mjs';

const expectedDefaults = {
  windowHours: 48,
  overdueDays: 3,
  refreshMode: 1,
  cookieSecretName: 'MOOC_COOKIE',
  coursesText: '',
  remindersFile: 'reminders.json'
};

test('resolveDetectionConfig 未设置或空串时使用默认值', () => {
  assert.deepEqual(resolveDetectionConfig({}), expectedDefaults);
  assert.deepEqual(
    resolveDetectionConfig({
      DUE_WINDOW_HOURS: '',
      OVERDUE_DAYS: '   ',
      COOKIE_REFRESH_MODE: '',
      MOOC_COOKIE_SECRET_NAME: ' ',
      MOOC_COURSES: '',
      REMINDERS_FILE: ' '
    }),
    expectedDefaults
  );
});

test('resolveDetectionConfig 读取显式值，并保留 0', () => {
  assert.deepEqual(
    resolveDetectionConfig({
      DUE_WINDOW_HOURS: '72',
      OVERDUE_DAYS: '7',
      COOKIE_REFRESH_MODE: '2',
      MOOC_COOKIE_SECRET_NAME: 'ALT_COOKIE',
      MOOC_COURSES: 'https://www.icourse163.org/learn/A-1?tid=2 # 课程',
      REMINDERS_FILE: 'out.json'
    }),
    {
      windowHours: 72,
      overdueDays: 7,
      refreshMode: 2,
      cookieSecretName: 'ALT_COOKIE',
      coursesText: 'https://www.icourse163.org/learn/A-1?tid=2 # 课程',
      remindersFile: 'out.json'
    }
  );

  const zero = resolveDetectionConfig({ DUE_WINDOW_HOURS: '0', OVERDUE_DAYS: '0' });
  assert.equal(zero.windowHours, 0);
  assert.equal(zero.overdueDays, 0);
});

test('resolveDetectionConfig 拒绝非法数字与刷新模式', () => {
  assert.throws(() => resolveDetectionConfig({ DUE_WINDOW_HOURS: 'abc' }), /DUE_WINDOW_HOURS/);
  assert.throws(() => resolveDetectionConfig({ DUE_WINDOW_HOURS: '-1' }), /DUE_WINDOW_HOURS/);
  assert.throws(() => resolveDetectionConfig({ OVERDUE_DAYS: 'x' }), /OVERDUE_DAYS/);
  assert.throws(() => resolveDetectionConfig({ COOKIE_REFRESH_MODE: '3' }), /COOKIE_REFRESH_MODE/);
  assert.throws(() => resolveDetectionConfig({ COOKIE_REFRESH_MODE: 'abc' }), /COOKIE_REFRESH_MODE/);
});

test('resolveNotifyConfig 未设置或留空时使用默认路径', () => {
  assert.equal(resolveNotifyConfig({}).remindersFile, 'reminders.json');
  assert.equal(resolveNotifyConfig({ REMINDERS_FILE: '   ' }).remindersFile, 'reminders.json');
  assert.equal(resolveNotifyConfig({ REMINDERS_FILE: ' out.json ' }).remindersFile, 'out.json');
});

test('resolveGithubConfig issue 编号：留空默认 1、显式值生效、非法报错', () => {
  assert.equal(resolveGithubConfig({}).reminderIssueNumber, 1);
  assert.equal(resolveGithubConfig({ REMINDER_ISSUE_NUMBER: '   ' }).reminderIssueNumber, 1);
  assert.equal(resolveGithubConfig({ REMINDER_ISSUE_NUMBER: ' 2 ' }).reminderIssueNumber, 2);
  assert.throws(() => resolveGithubConfig({ REMINDER_ISSUE_NUMBER: 'abc' }), /REMINDER_ISSUE_NUMBER/);
  assert.throws(() => resolveGithubConfig({ REMINDER_ISSUE_NUMBER: '0' }), /REMINDER_ISSUE_NUMBER/);
  assert.throws(() => resolveGithubConfig({ REMINDER_ISSUE_NUMBER: '1.5' }), /REMINDER_ISSUE_NUMBER/);
});

test('resolveGithubConfig 评论保留天数：留空回退 7、保留 0、非法报错', () => {
  assert.equal(resolveGithubConfig({}).commentRetentionDays, 7);
  assert.equal(resolveGithubConfig({ COMMENT_RETENTION_DAYS: '   ' }).commentRetentionDays, 7);
  assert.equal(resolveGithubConfig({ COMMENT_RETENTION_DAYS: '14' }).commentRetentionDays, 14);
  assert.equal(resolveGithubConfig({ COMMENT_RETENTION_DAYS: '0' }).commentRetentionDays, 0);
  assert.throws(() => resolveGithubConfig({ COMMENT_RETENTION_DAYS: 'abc' }), /COMMENT_RETENTION_DAYS/);
  assert.throws(() => resolveGithubConfig({ COMMENT_RETENTION_DAYS: '-1' }), /COMMENT_RETENTION_DAYS/);
});

test('DEFAULTS 不可变且包含预期默认值', () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.equal(DEFAULTS.windowHours, 48);
  assert.equal(DEFAULTS.overdueDays, 3);
  assert.equal(DEFAULTS.refreshMode, 1);
  assert.equal(DEFAULTS.cookieSecretName, 'MOOC_COOKIE');
  assert.equal(DEFAULTS.coursesText, '');
  assert.equal(DEFAULTS.remindersFile, 'reminders.json');
  assert.equal(DEFAULTS.notifyChannel, 'github');
  assert.equal(DEFAULTS.smtpPort, 465);
  assert.equal(DEFAULTS.commentRetentionDays, 7);
  assert.equal(DEFAULTS.reminderIssueNumber, 1);
});
