/**
 * 运行配置的默认值与解析。
 *
 * 默认值只在这里定义一次；修改后请同步 README.agent.md 的环境变量表。
 * GitHub Actions 中 Variable 未设置时环境变量通常是空字符串，因此空串按未设置处理。
 */

export const DEFAULTS = Object.freeze({
  windowHours: 48,
  overdueDays: 3,
  refreshMode: 1,
  cookieSecretName: 'MOOC_COOKIE',
  coursesText: '',
  remindersFile: 'reminders.json',
  notifyChannel: 'github',
  smtpPort: 465,
  commentRetentionDays: 7,
  reminderIssueNumber: 1,
  cnbIssueUpdateMode: 1
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

function readPositiveInteger(env, name, fallback) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是不小于 1 的整数（当前：${raw}）`);
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

/** 读取 0/1 开关；留空回退默认值，其余非法值报错。 */
function readBinaryMode(env, name, fallback) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (![0, 1].includes(value)) {
    throw new Error(`${name} 只能是 0/1（当前：${raw}）`);
  }
  return value;
}

export function resolveDetectionConfig(env = process.env) {
  return {
    windowHours: readNonNegativeNumber(env, 'DUE_WINDOW_HOURS', DEFAULTS.windowHours),
    overdueDays: readNonNegativeNumber(env, 'OVERDUE_DAYS', DEFAULTS.overdueDays),
    refreshMode: readRefreshMode(env),
    cookieSecretName: readString(env, 'MOOC_COOKIE_SECRET_NAME', DEFAULTS.cookieSecretName),
    coursesText: readString(env, 'MOOC_COURSES', DEFAULTS.coursesText),
    remindersFile: readString(env, 'REMINDERS_FILE', DEFAULTS.remindersFile)
  };
}

export function resolveNotifyConfig(env = process.env) {
  return {
    remindersFile: readString(env, 'REMINDERS_FILE', DEFAULTS.remindersFile)
  };
}

/**
 * issue 评论类渠道的通用配置（原 resolveGithubConfig：issue 编号与评论保留
 * 天数对所有「发 issue 评论」的渠道通用，不再 GitHub 专属）。
 */
export function resolveIssueConfig(env = process.env) {
  return {
    reminderIssueNumber: readPositiveInteger(
      env,
      'REMINDER_ISSUE_NUMBER',
      DEFAULTS.reminderIssueNumber
    ),
    commentRetentionDays: readNonNegativeNumber(
      env,
      'COMMENT_RETENTION_DAYS',
      DEFAULTS.commentRetentionDays
    )
  };
}

/** 旧名称，向后兼容。 */
export const resolveGithubConfig = resolveIssueConfig;

/**
 * CNB 渠道专属配置。
 *
 * issueUpdateMode 控制 issue 评论的更新方式（CNB 没有删除评论的接口）：
 *   0 = 每次只发新评论，不修改旧评论（issue 会逐渐变长）
 *   1 = 覆盖更新最近一条自己发布的提醒评论（默认，保持 issue 干净）
 */
export function resolveCnbConfig(env = process.env) {
  return {
    issueUpdateMode: readBinaryMode(env, 'CNB_ISSUE_UPDATE_MODE', DEFAULTS.cnbIssueUpdateMode)
  };
}
