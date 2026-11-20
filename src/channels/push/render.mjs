/**
 * 微信 / QQ 推送类渠道的共享渲染（平台无关）。
 *
 * push/ 下的子渠道（serverchan / pushplus / wxpusher / qmsg / qqbot）正文格式
 * 高度相似：紧凑纯文本（Markdown 渠道直接把它当 Markdown 源），只有传输层
 * （端点、鉴权、字段映射、截断规则）不同——见 push/index.mjs。
 *
 * 与 issue 评论渲染（../render.mjs）不同：聊天推送没有表格能力，逐条换行排列；
 * 标题只保留概况（Server酱等渠道标题即通知卡片文案）。
 */

import { kindLabel, formatBeijing, formatRemaining } from '../../extract.mjs';
import { cookieRefreshNotice } from '../../report.mjs';
import { groupEvents, BODY_SIGNATURE } from '../render.mjs';

const TYPE_LABEL = { quiz: '测验', homework: '作业', exam: '考试' };

function line(ev, tag, now) {
  const it = ev.item;
  const loc = [it.chapter, it.lesson].filter(Boolean).join(' / ');
  return (
    `${tag}【${it.courseName}】${loc ? loc + ' · ' : ''}${it.title}` +
    `（${TYPE_LABEL[it.type] || it.type}）\n` +
    `  ${kindLabel(ev.kind)}：${formatBeijing(ev.dueMs)}（${formatRemaining(ev.dueMs, now)}）\n` +
    `${it.url}`
  );
}

/** 渲染推送正文与标题，所有 push 子渠道共用。 */
export function buildPushMessage(doc, now = Date.now()) {
  const { due, overdue } = groupEvents(doc);
  const s = doc.summary || {};

  const blocks = [];
  for (const ev of overdue) blocks.push(line(ev, '⚠已过期', now));
  for (const ev of due) blocks.push(line(ev, '🔔即将截止', now));

  let text =
    `共 ${due.length} 项即将截止（${doc.windowHours} 小时内），${overdue.length} 项已过期未完成。\n\n` +
    blocks.join('\n\n');
  if (Array.isArray(s.failures) && s.failures.length > 0) {
    text += `\n\n> ⚠️ ${s.coursesFailed} 门课程拉取失败，本轮数据可能不全：${s.failures.join('；')}`;
  }
  const refreshNotice = cookieRefreshNotice(doc.cookieRefresh);
  if (refreshNotice) {
    text += `\n\n🔑 ${refreshNotice}`;
  }
  text += `\n\n—— ${BODY_SIGNATURE}`;

  const title =
    `[MOOC提醒] ${due.length} 项任务将在${doc.windowHours}小时内截止` +
    (overdue.length > 0 ? `，${overdue.length} 项已过期` : '');
  return { title, text };
}

/** 按字符数截断（Qmsg 等按"字符"计长的服务）。 */
export function truncateChars(str, maxChars) {
  const s = String(str);
  return s.length <= maxChars ? s : s.slice(0, maxChars);
}

/** 按 UTF-8 字节数截断（Server酱 desp 等按字节计长的服务）。 */
export function truncateUtf8Bytes(str, maxBytes) {
  const s = String(str);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let end = s.length;
  while (end > 0 && Buffer.byteLength(s.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return s.slice(0, end);
}
