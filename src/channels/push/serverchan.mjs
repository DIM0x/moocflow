/**
 * Server酱·Turbo 子渠道：推送到个人微信（需关注「方糖」服务号接收）。
 *
 * 免费额度 5 条/天（失败的请求也计入）；接口 POST
 * https://sctapi.ftqq.com/<SendKey>.send，form 编码 title（≤32 字符）+ desp
 * （Markdown，≤32KB）；成功返回 JSON 且 code === 0。
 *
 * 子渠道 mini 契约见 push/index.mjs 头注释。
 */

import { buildPushMessage, truncateChars, truncateUtf8Bytes } from './render.mjs';

export const name = 'serverchan';

/** 仅服务 wechat 聚合渠道（Server酱只能送达个人微信）。 */
export const targets = ['wechat'];

/** 未配置时的降级提示：列出该子渠道所需的环境变量。 */
export const envHint = ['SERVERCHAN_SENDKEY'];

export function isConfigured(env) {
  return Boolean(env.SERVERCHAN_SENDKEY);
}

const TITLE_MAX_CHARS = 32;
const DESP_MAX_BYTES = 32 * 1024;

export async function deliver(doc, env, now = Date.now()) {
  const sendKey = env.SERVERCHAN_SENDKEY;
  const { title, text } = buildPushMessage(doc, now);
  const res = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      title: truncateChars(title, TITLE_MAX_CHARS),
      desp: truncateUtf8Bytes(text, DESP_MAX_BYTES)
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(`Server酱 发送失败：HTTP ${res.status} code=${data.code ?? '无'} ${data.message || ''}`.trimEnd());
  }
  return { sent: true, detail: '已提交 Server酱（微信服务号「方糖」推送）' };
}
