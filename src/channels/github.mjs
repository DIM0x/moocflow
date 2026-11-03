/**
 * github 渠道：向用户手动创建的 issue 追加评论，借 GitHub 通知邮件送达用户。
 *
 * 送达原理：用户是 issue 的 author/participant（手动创建即自动订阅），
 * 该 thread 上的新评论——包括 github-actions[bot] 的评论——会触发参与者的
 * 通知邮件。注意这条路不依赖 @mention：bot 的 @mention 通知会被 GitHub
 * 压制，而 thread 参与者通知不会，这正是本渠道绕开压制的方式。
 *
 * 需要的配置（Actions 环境大多自动提供）：
 *   GITHUB_TOKEN            自动提供；workflow 需声明 permissions: issues: write
 *   GITHUB_REPOSITORY       自动提供（"owner/repo"）
 *   REMINDER_ISSUE_NUMBER   用户手动创建提醒 issue 后，把编号存为仓库 Variable；
 *                           非必填，留空默认 1（仓库首个 issue 必为 1 号，见 src/config.mjs）
 *   COMMENT_RETENTION_DAYS  旧评论保留天数（默认 7，见 src/config.mjs）；0 = 只保留最新一条
 *
 * 每次发布新评论后，会删除超过保留期的旧 bot 评论，避免 issue 无限变长。
 * 删除不会撤回已发出的通知邮件；清理失败只记日志，不影响本次提醒。
 */

import { kindLabel, formatBeijing, formatRemaining } from '../extract.mjs';
import { cookieRefreshNotice } from '../report.mjs';
import { resolveGithubConfig } from '../config.mjs';

export const name = 'github';

const API_ROOT = 'https://api.github.com';
const TYPE_LABEL = { quiz: '测验', homework: '作业', exam: '考试' };
const DAY_MS = 24 * 60 * 60 * 1000;
const BODY_SIGNATURE = 'moocflow 自动提醒';
const MARKER = '<!-- moocflow-reminder -->';

export function isConfigured(env) {
  return Boolean(env.GITHUB_TOKEN && env.GITHUB_REPOSITORY);
}

function groupEvents(doc) {
  const events = Array.isArray(doc.events) ? doc.events : [];
  return {
    due: events.filter((ev) => ev.status === 'due'),
    overdue: events.filter((ev) => ev.status === 'overdue')
  };
}

function typeLabel(t) {
  return TYPE_LABEL[t] || t;
}

function row(ev, tag, now) {
  const it = ev.item;
  const loc = [it.chapter, it.lesson].filter(Boolean).join(' / ');
  const title = it.url ? `[${it.title}](${it.url})` : it.title;
  return (
    `| ${tag} | ${it.courseName} | ${loc ? loc + ' · ' : ''}${title}（${typeLabel(it.type)}）` +
    ` | ${kindLabel(ev.kind)} ${formatBeijing(ev.dueMs)} | ${formatRemaining(ev.dueMs, now)} |`
  );
}

/** 渲染为 GitHub Markdown 评论体（表格 + 链接）。 */
export function buildCommentBody(doc, now = Date.now()) {
  const { due, overdue } = groupEvents(doc);
  const s = doc.summary || {};

  const lines = [];
  lines.push('## 📬 MOOC 截止提醒');
  lines.push('');
  lines.push(
    `共 **${due.length}** 项即将截止（${doc.windowHours} 小时内），**${overdue.length}** 项已过期未完成。`
  );
  if (Array.isArray(s.failures) && s.failures.length > 0) {
    lines.push('');
    lines.push(`> ⚠️ ${s.coursesFailed} 门课程拉取失败，本轮数据可能不全：${s.failures.join('；')}`);
  }
  lines.push('');
  lines.push('| 状态 | 课程 | 任务 | 时间 | 剩余 |');
  lines.push('|---|---|---|---|---|');
  for (const ev of overdue) lines.push(row(ev, '⚠ 已过期', now));
  for (const ev of due) lines.push(row(ev, '🔔 即将截止', now));
  const refreshNotice = cookieRefreshNotice(doc.cookieRefresh);
  if (refreshNotice) {
    lines.push('');
    lines.push(`> 🔑 ${refreshNotice}`);
  }
  lines.push('');
  lines.push(`<sub>—— ${BODY_SIGNATURE} · 检测时间 ${formatBeijing(now)}（北京时间）</sub>`);
  lines.push(MARKER);
  return lines.join('\n');
}

export function renderPreview(doc, now = Date.now()) {
  return buildCommentBody(doc, now);
}

function apiHeaders(env, json = false) {
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'moocflow'
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

/** 由 bot 发布、且带本项目签名（隐藏标记或页脚）的评论才算提醒评论。 */
export function isReminderComment(comment) {
  const author = comment?.user;
  const login = String(author?.login || '');
  const isBot = author?.type === 'Bot' || login.endsWith('[bot]');
  return isBot && typeof comment.body === 'string' && comment.body.includes(BODY_SIGNATURE);
}

/** 从评论列表中挑出早于 cutoffMs、且不是本次刚发布的那条。 */
export function selectExpiredComments(comments, cutoffMs, keepId) {
  return (Array.isArray(comments) ? comments : []).filter(
    (c) => c.id !== keepId && isReminderComment(c) && Date.parse(c.created_at) < cutoffMs
  );
}

/** 评论按创建时间升序返回，碰到不早于截止时间的评论即可停止翻页。 */
async function fetchCommentsBefore(env, issueNumber, cutoffMs) {
  const base = `${API_ROOT}/repos/${env.GITHUB_REPOSITORY}/issues/${issueNumber}/comments`;
  const collected = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${base}?per_page=100&page=${page}`, { headers: apiHeaders(env) });
    if (!res.ok) {
      throw new Error(`获取 issue 评论失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const items = await res.json();
    const freshIndex = items.findIndex((c) => Date.parse(c.created_at) >= cutoffMs);
    collected.push(...(freshIndex === -1 ? items : items.slice(0, freshIndex)));
    if (freshIndex !== -1 || items.length < 100) break;
  }
  return collected;
}

async function deleteComment(env, id) {
  const res = await fetch(`${API_ROOT}/repos/${env.GITHUB_REPOSITORY}/issues/comments/${id}`, {
    method: 'DELETE',
    headers: apiHeaders(env)
  });
  // 404 = 已经不存在，视作删除成功
  if (!res.ok && res.status !== 404) {
    throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

async function removeExpiredComments(env, issueNumber, keepId, cutoffMs) {
  const comments = await fetchCommentsBefore(env, issueNumber, cutoffMs);
  const expired = selectExpiredComments(comments, cutoffMs, keepId);
  let removed = 0;
  let failed = 0;
  for (const c of expired) {
    try {
      await deleteComment(env, c.id);
      removed++;
    } catch (e) {
      failed++;
      console.error(`[moocflow] 删除旧评论 ${c.id} 失败：${e.message}`);
    }
  }
  return { removed, failed };
}

export async function deliver(doc, env, now = Date.now()) {
  if (!isConfigured(env)) {
    return {
      sent: false,
      detail: '未配置 GITHUB_TOKEN / GITHUB_REPOSITORY'
    };
  }
  // 先解析配置：值非法时直接报错，避免评论已发布却因清理配置失败而报发送失败
  const { commentRetentionDays, reminderIssueNumber } = resolveGithubConfig(env);
  const url = `${API_ROOT}/repos/${env.GITHUB_REPOSITORY}/issues/${reminderIssueNumber}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(env, true),
    body: JSON.stringify({ body: buildCommentBody(doc, now) })
  });
  if (!res.ok) {
    const text = await res.text();
    const hint =
      res.status === 404
        ? '（常见原因：REMINDER_ISSUE_NUMBER 指向的 issue 不存在，或 token 缺少 issues: write 权限）'
        : '';
    throw new Error(`GitHub 评论发布失败：HTTP ${res.status} ${text.slice(0, 200)}${hint}`);
  }
  const data = await res.json();

  // 清理属于 best-effort：失败只记日志，不影响本次提醒已送达
  let cleanup = '';
  try {
    const { removed, failed } = await removeExpiredComments(
      env,
      reminderIssueNumber,
      data.id,
      now - commentRetentionDays * DAY_MS
    );
    if (removed > 0) cleanup = `；已清理 ${removed} 条超过保留期（${commentRetentionDays} 天）的旧评论`;
    if (failed > 0) cleanup += `；${failed} 条旧评论删除失败（详见日志）`;
  } catch (e) {
    cleanup = `；旧评论清理失败（不影响本次提醒）：${e.message}`;
    console.error(`[moocflow] github 渠道旧评论清理失败：${e.message}`);
  }
  return { sent: true, detail: `评论已发布：${data.html_url}${cleanup}` };
}
