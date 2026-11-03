/**
 * Issue 评论的共享渲染（平台无关）。
 *
 * GitHub/Gitea/GitLab/Gitee/AtomGit 等托管平台的 issue 评论都支持 Markdown
 * 表格与链接，因此「往 issue 发评论」类渠道共用同一份评论体，只有传输层
 * （API 路径、鉴权、字段映射）不同——见 issue-factory.mjs。
 *
 * 评论体带固定签名与隐藏标记，供渠道清理旧评论时识别"自己发布的历史评论"。
 * 修改渲染输出时注意：签名与标记同时被清理逻辑匹配，需保持一致。
 */

import { kindLabel, formatBeijing, formatRemaining } from '../extract.mjs';
import { cookieRefreshNotice } from '../report.mjs';

/** 提醒评论签名：正文包含此字符串才可能被旧评论清理识别。 */
export const BODY_SIGNATURE = 'moocflow 自动提醒';

/** 隐藏标记：附在评论体末尾，兼容无标记的旧评论。 */
export const REMINDER_MARKER = '<!-- moocflow-reminder -->';

const TYPE_LABEL = { quiz: '测验', homework: '作业', exam: '考试' };

/** 按状态把提醒事件分组：due（即将截止）/ overdue（已过期）。 */
export function groupEvents(doc) {
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

/** 渲染为 Markdown 评论体（表格 + 链接），所有 issue 评论类渠道共用。 */
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
  lines.push(REMINDER_MARKER);
  return lines.join('\n');
}
