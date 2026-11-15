/**
 * wechat 聚合渠道：把提醒推送到个人微信。
 *
 * NOTIFY_CHANNEL=wechat 时按 WECHAT_CHANNELS 显式配置的顺序在子渠道间
 * fallback（成功即止；单个失败自动尝试下一个；全部失败才抛错让 step 失败）。
 * 子渠道注册表与 fallback 引擎见 src/channels/push/index.mjs；
 * 渠道契约见 mail.mjs 头注释。
 */

import { deliverOrdered, isConfigured as subsConfigured, buildPushPreview } from './push/index.mjs';

export const name = 'wechat';

const ORDER_VAR = 'WECHAT_CHANNELS';
const ORDER_EXAMPLE = 'serverchan,wxpusher,pushplus';
const TARGET = 'wechat';

export function isConfigured(env) {
  return subsConfigured(env, env[ORDER_VAR]);
}

export async function deliver(doc, env, now = Date.now()) {
  return deliverOrdered({
    orderRaw: env[ORDER_VAR],
    orderVar: ORDER_VAR,
    orderExample: ORDER_EXAMPLE,
    target: TARGET,
    doc,
    env,
    now
  });
}

export function renderPreview(doc, now = Date.now()) {
  return buildPushPreview(doc, now);
}
