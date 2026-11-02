/**
 * mail 渠道：SMTP 邮件提醒。
 *
 * 渠道统一契约（新增渠道照此实现，见 index.mjs）：
 *   name          渠道名（= NOTIFY_CHANNEL 的取值）
 *   isConfigured(env)   该渠道所需配置是否齐全
 *   deliver(doc, env, now)  发送提醒文档 doc；成功返回 { sent: true, detail }，
 *                           配置缺失时返回 { sent: false, detail }（由调用方打印
 *                           renderPreview 降级为控制台输出）；硬失败抛异常
 *   renderPreview(doc, now) 渠道格式的人类可读预览（降级打印用）
 */

import nodemailer from 'nodemailer';
import { kindLabel, formatBeijing, formatRemaining } from '../extract.mjs';
import { DEFAULTS } from '../config.mjs';

export const name = 'mail';

export function isConfigured(env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.NOTIFY_TO);
}

function smtpConfigFromEnv(env) {
  const port = Number(env.SMTP_PORT || DEFAULTS.smtpPort);
  const secureRaw = env.SMTP_SECURE;
  const secure =
    secureRaw == null || String(secureRaw).trim() === ''
      ? port === DEFAULTS.smtpPort
      : secureRaw !== 'false';
  return {
    host: env.SMTP_HOST,
    port,
    secure,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    from: env.SMTP_FROM || env.SMTP_USER,
    to: env.NOTIFY_TO
  };
}

function groupEvents(doc) {
  const events = Array.isArray(doc.events) ? doc.events : [];
  return {
    due: events.filter((ev) => ev.status === 'due'),
    overdue: events.filter((ev) => ev.status === 'overdue')
  };
}

export function buildMessage(events, { now = Date.now(), windowHours } = {}) {
  const { due, overdue } = events;
  const lines = [];
  const htmlRows = [];

  const emit = (ev, tag) => {
    const it = ev.item;
    const loc = [it.chapter, it.lesson].filter(Boolean).join(' / ');
    const line =
      `${tag}【${it.courseName}】${loc ? loc + ' · ' : ''}${it.title}` +
      `（${it.type === 'quiz' ? '测验' : it.type === 'exam' ? '考试' : '作业'}）\n` +
      `    ${kindLabel(ev.kind)}：${formatBeijing(ev.dueMs)}（${formatRemaining(ev.dueMs, now)}）\n` +
      `    ${it.url}`;
    lines.push(line);
    htmlRows.push({
      tag,
      course: it.courseName,
      title: it.title,
      type: it.type,
      kind: kindLabel(ev.kind),
      due: formatBeijing(ev.dueMs),
      remain: formatRemaining(ev.dueMs, now),
      url: it.url,
      loc
    });
  };

  for (const ev of overdue) emit(ev, '⚠已过期');
  for (const ev of due) emit(ev, '🔔即将截止');

  const text =
    `共 ${due.length} 项即将截止（${windowHours} 小时内），${overdue.length} 项已过期未完成。\n\n` +
    lines.join('\n') +
    `\n\n—— moocflow 自动提醒`;

  const rowsHtml = htmlRows
    .map(
      (r) => `<tr>
        <td style="padding:4px 8px;white-space:nowrap;">${r.tag}</td>
        <td style="padding:4px 8px;">${escapeHtml(r.course)}</td>
        <td style="padding:4px 8px;">${r.loc ? escapeHtml(r.loc) + ' · ' : ''}<a href="${r.url}">${escapeHtml(r.title)}</a>（${r.type === 'quiz' ? '测验' : r.type === 'exam' ? '考试' : '作业'}）</td>
        <td style="padding:4px 8px;white-space:nowrap;">${r.kind} ${r.due}</td>
        <td style="padding:4px 8px;white-space:nowrap;">${r.remain}</td>
      </tr>`
    )
    .join('');
  const html = `<p>共 <b>${due.length}</b> 项即将截止（${windowHours} 小时内），<b>${overdue.length}</b> 项已过期未完成。</p>
<table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0f0f0;"><th style="padding:4px 8px;">状态</th><th style="padding:4px 8px;">课程</th><th style="padding:4px 8px;">任务</th><th style="padding:4px 8px;">时间</th><th style="padding:4px 8px;">剩余</th></tr>
  ${rowsHtml}
</table>
<p style="color:#888;font-size:12px;">—— moocflow 自动提醒</p>`;

  return { text, html };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function renderPreview(doc, now = Date.now()) {
  return buildMessage(groupEvents(doc), { now, windowHours: doc.windowHours }).text;
}

export async function deliver(doc, env, now = Date.now()) {
  const cfg = smtpConfigFromEnv(env);
  if (!isConfigured(env) || !cfg.host || !cfg.auth.user || !cfg.auth.pass || !cfg.to) {
    return { sent: false, detail: '未配置 SMTP_HOST / SMTP_USER / SMTP_PASS / NOTIFY_TO' };
  }
  const grouped = groupEvents(doc);
  const { text, html } = buildMessage(grouped, { now, windowHours: doc.windowHours });
  const subject =
    `[MOOC提醒] ${grouped.due.length} 项任务将在${doc.windowHours}小时内截止` +
    (grouped.overdue.length > 0 ? `，${grouped.overdue.length} 项已过期` : '');
  const info = await sendMail(cfg, { subject, text, html });
  return { sent: true, detail: `邮件已发送：${info.messageId}` };
}

async function sendMail(cfg, { subject, text, html }) {
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.auth
  });
  return transporter.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject,
    text,
    html
  });
}
