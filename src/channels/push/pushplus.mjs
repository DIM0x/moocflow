/**
 * PushPlus 子渠道：同时服务 wechat（公众号推送）与 qq（QQ 机器人渠道）两个聚合渠道。
 *
 * 接口 POST https://www.pushplus.plus/send，JSON { token, title, content, template, channel }；
 * 成功返回 HTTP 200 且 code === 200（异步受理，不代表最终送达）。
 * 微信：template=markdown；QQ：channel=qq + template=txt（QQ 渠道仅展示标题摘要，
 * 且不支持代码块/HTML 的 Markdown，用纯文本最稳）。
 * 免费额度：实名用户 200 次/天（未实名不能发送；失败的请求也计入）。
 *
 * 子渠道 mini 契约见 push/index.mjs 头注释。
 */

import { buildPushMessage } from './render.mjs';

export const name = 'pushplus';

/** 未配置时的降级提示：列出该子渠道所需的环境变量。 */
export const envHint = ['PUSHPLUS_TOKEN'];

export function isConfigured(env) {
  return Boolean(env.PUSHPLUS_TOKEN);
}

const ENDPOINT = 'https://www.pushplus.plus/send';

export async function deliver(doc, env, now = Date.now(), ctx = {}) {
  const { title, text } = buildPushMessage(doc, now);
  const payload =
    ctx.target === 'qq'
      ? { token: env.PUSHPLUS_TOKEN, title, content: text, template: 'txt', channel: 'qq' }
      : { token: env.PUSHPLUS_TOKEN, title, content: text, template: 'markdown' };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 200) {
    throw new Error(`PushPlus 发送失败：HTTP ${res.status} code=${data.code ?? '无'} ${data.msg || ''}`.trimEnd());
  }
  return { sent: true, detail: `已提交 PushPlus（${ctx.target === 'qq' ? 'QQ 机器人' : '微信公众号'}渠道）` };
}
