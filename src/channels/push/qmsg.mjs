/**
 * Qmsg酱 子渠道：通过其官方 QQ 机器人推送（私聊或已绑定的群）。
 *
 * 接口 POST https://qmsg.zendee.cn/v3/send/<key>，form 编码 msg（≤1800 字符）；
 * 可选 group 参数发群聊（群须先在其控制台绑定）。免费 500 条/日、3 秒 1 条。
 * 注意：
 *   - v3 内容审核禁止消息中出现 URL / IPv4 / 长数字串，违规可能封 key——
 *     发送前剥离全部 URL（课程链接行整行移除，行内链接替换为占位符）；
 *   - 成功与否看返回 JSON 的 success 字段而非 HTTP 状态码；
 *   - 服务 2026-08 曾整体停运约 2-3 个月后重启，建议作为多渠道之一而非唯一通道。
 *
 * 子渠道 mini 契约见 push/index.mjs 头注释。
 */

import { buildPushMessage, truncateChars } from './render.mjs';

export const name = 'qmsg';

/** 仅服务 qq 聚合渠道（Qmsg 机器人只能送达 QQ）。 */
export const targets = ['qq'];

/** 未配置时的降级提示：列出该子渠道所需的环境变量。 */
export const envHint = ['QMSG_KEY'];

export function isConfigured(env) {
  return Boolean(env.QMSG_KEY);
}

const MSG_MAX_CHARS = 1800;

export async function deliver(doc, env, now = Date.now()) {
  const { text } = buildPushMessage(doc, now);
  const form = new URLSearchParams({ msg: truncateChars(stripUrls(text), MSG_MAX_CHARS) });
  if (env.QMSG_GROUP) {
    form.set('group', env.QMSG_GROUP);
  }
  const res = await fetch(`https://qmsg.zendee.cn/v3/send/${encodeURIComponent(env.QMSG_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const data = await res.json().catch(() => ({}));
  if (data.success !== true) {
    throw new Error(`Qmsg酱 发送失败：HTTP ${res.status} code=${data.code ?? '无'} ${data.message || ''}`.trimEnd());
  }
  return { sent: true, detail: `已提交 Qmsg酱（${env.QMSG_GROUP ? '群聊' : 'QQ 私聊'}）` };
}

/**
 * 剥离正文中的全部 URL：独立成行的课程链接整行移除，行内链接替换为占位符，
 * 再收紧多余空行（Qmsg v3 内容审核禁止 URL）。
 */
export function stripUrls(text) {
  return String(text)
    .replace(/^https?:\/\/\S+\s*$/gm, '')
    .replace(/https?:\/\/\S+/g, '（链接略）')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
