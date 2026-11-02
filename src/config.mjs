/**
 * 运行配置的默认值与解析。
 *
 * 默认值只在这里定义一次；修改后请同步 README.md 的环境变量表。
 * GitHub Actions 中 Variable 未设置时环境变量通常是空字符串，因此空串按未设置处理。
 */

export const DEFAULTS = Object.freeze({
  windowHours: 48,
  overdueDays: 3,
  refreshMode: 0,
  cookieSecretName: 'MOOC_COOKIE',
  coursesFile: 'courses.txt',
  remindersFile: 'reminders.json',
  notifyChannel: 'github',
  smtpPort: 465
});

function readString(env, name, fallback) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return String(raw).trim();
}

function readNonNegativeNumber(env, name, fallback) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} 必须是不小于 0 的数字（当前：${raw}）`);
  }
  return value;
}

function readRefreshMode(env) {
  const raw = env.COOKIE_REFRESH_MODE;
  if (raw == null || String(raw).trim() === '') return DEFAULTS.refreshMode;
  const value = Number(raw);
  if (![0, 1, 2].includes(value)) {
    throw new Error(`COOKIE_REFRESH_MODE 只能是 0/1/2（当前：${raw}）`);
  }
  return value;
}

export function resolveDetectionConfig(env = process.env) {
  return {
    windowHours: readNonNegativeNumber(env, 'DUE_WINDOW_HOURS', DEFAULTS.windowHours),
    overdueDays: readNonNegativeNumber(env, 'OVERDUE_DAYS', DEFAULTS.overdueDays),
    refreshMode: readRefreshMode(env),
    cookieSecretName: readString(env, 'MOOC_COOKIE_SECRET_NAME', DEFAULTS.cookieSecretName),
    coursesFile: readString(env, 'MOOC_COURSES_FILE', DEFAULTS.coursesFile),
    remindersFile: readString(env, 'REMINDERS_FILE', DEFAULTS.remindersFile)
  };
}

export function resolveNotifyConfig(env = process.env) {
  return {
    remindersFile: readString(env, 'REMINDERS_FILE', DEFAULTS.remindersFile)
  };
}
