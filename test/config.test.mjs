import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, resolveDetectionConfig, resolveNotifyConfig } from '../src/config.mjs';

const expectedDefaults = {
  windowHours: 48,
  overdueDays: 3,
  refreshMode: 1,
  cookieSecretName: 'MOOC_COOKIE',
  coursesFile: 'courses.txt',
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
      MOOC_COURSES_FILE: '',
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
      MOOC_COURSES_FILE: 'my-courses.txt',
      REMINDERS_FILE: 'out.json'
    }),
    {
      windowHours: 72,
      overdueDays: 7,
      refreshMode: 2,
      cookieSecretName: 'ALT_COOKIE',
      coursesFile: 'my-courses.txt',
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

test('DEFAULTS 不可变且包含预期默认值', () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.equal(DEFAULTS.windowHours, 48);
  assert.equal(DEFAULTS.overdueDays, 3);
  assert.equal(DEFAULTS.refreshMode, 1);
  assert.equal(DEFAULTS.cookieSecretName, 'MOOC_COOKIE');
  assert.equal(DEFAULTS.coursesFile, 'courses.txt');
  assert.equal(DEFAULTS.remindersFile, 'reminders.json');
  assert.equal(DEFAULTS.notifyChannel, 'github');
  assert.equal(DEFAULTS.smtpPort, 465);
});
