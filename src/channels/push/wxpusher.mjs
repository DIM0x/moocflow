/**
 * WxPusher 子渠道：推送到个人微信（公众号「WxPusher」接收）。
 *
 * 两种接入形态（二选一，优先 SPT）：
 *   SPT 极简推送：用户扫官方二维码拿 WXPUSHER_SPT，免建应用、免 UID；
 *     POST https://wxpusher.zjiecode.com/api/send/message/simple-push，
 *     JSON { content, summary, contentType, spt }，多个 SPT 逐个发送。
 *   标准应用推送：WXPUSHER_APP_TOKEN + WXPUSHER_UID（逗号分隔多个 UID）；
 *     POST https://wxpusher.zjiecode.com/api/send/message，
 *     JSON { appToken, content, summary, contentType: 3(markdown), uids }。
 * 成功返回 HTTP 200 且 code === 1000（异步受理，不代表最终送达）。
 * 免费额度无每日条数限制（限流约 2 QPS，对每天 2 条无压力）。
 *
 * 子渠道 mini 契约见 push/index.mjs 头注释。
 */

import { buildPushMessage } from './render.mjs';

export const name = 'wxpusher';

/** 仅服务 wechat 聚合渠道（WxPusher 公众号只送达微信）。 */
export const targets = ['wechat'];

/** 未配置时的降级提示：列出该子渠道所需的环境变量。 */
export const envHint = ['WXPUSHER_SPT 或 WXPUSHER_APP_TOKEN / WXPUSHER_UID'];

export function isConfigured(env) {
  return Boolean(env.WXPUSHER_SPT || (env.WXPUSHER_APP_TOKEN && env.WXPUSHER_UID));
}

const BASE = 'https://wxpusher.zjiecode.com/api';
const SUMMARY_MAX_CHARS = 100;

function splitList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function deliver(doc, env, now = Date.now()) {
  const { title, text } = buildPushMessage(doc, now);
  const summary = title.slice(0, SUMMARY_MAX_CHARS);

  if (env.WXPUSHER_SPT) {
    const spts = splitList(env.WXPUSHER_SPT);
    for (const spt of spts) {
      const res = await fetch(`${BASE}/send/message/simple-push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, summary, contentType: 3, spt })
      });
      await assertAccepted(res);
    }
    return { sent: true, detail: `已提交 WxPusher（SPT 极简推送，${spts.length} 个接收方）` };
  }

  const uids = splitList(env.WXPUSHER_UID);
  const res = await fetch(`${BASE}/send/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appToken: env.WXPUSHER_APP_TOKEN, content: text, summary, contentType: 3, uids })
  });
  await assertAccepted(res);
  return { sent: true, detail: `已提交 WxPusher（应用推送，${uids.length} 个 UID）` };
}

async function assertAccepted(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 1000) {
    throw new Error(`WxPusher 发送失败：HTTP ${res.status} code=${data.code ?? '无'} ${data.msg || ''}`.trimEnd());
  }
}
