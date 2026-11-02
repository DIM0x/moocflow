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
 *   REMINDER_ISSUE_NUMBER   用户手动创建提醒 issue 后，把编号存为仓库 Variable
 */

import { kindLabel, formatBeijing, formatRemaining } from '../extract.mjs';
import { cookieRefreshNotice } from '../report.mjs';

export const name = 'github';

const API_ROOT = 'https://api.github.com';
const TYPE_LABEL = { quiz: '测验', homework: '作业', exam: '考试' };

export function isConfigured(env) {
  return Boolean(env.GITHUB_TOKEN && env.GITHUB_REPOSITORY && env.REMINDER_ISSUE_NUMBER);
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
  lines.push(`<sub>—— moocflow 自动提醒 · 检测时间 ${formatBeijing(now)}（北京时间）</sub>`);
  return lines.join('\n');
}

export function renderPreview(doc, now = Date.now()) {
  return buildCommentBody(doc, now);
}

export async function deliver(doc, env, now = Date.now()) {
  if (!isConfigured(env)) {
    return {
      sent: false,
      detail: '未配置 GITHUB_TOKEN / GITHUB_REPOSITORY / REMINDER_ISSUE_NUMBER'
    };
  }
  const url = `${API_ROOT}/repos/${env.GITHUB_REPOSITORY}/issues/${env.REMINDER_ISSUE_NUMBER}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'moocflow'
    },
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
  return { sent: true, detail: `评论已发布：${data.html_url}` };
}
