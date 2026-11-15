/**
 * 微信 / QQ 推送子渠道注册表与 fallback 引擎。
 *
 * 聚合渠道（wechat / qq，NOTIFY_CHANNEL 取值）按用户在 WECHAT_CHANNELS /
 * QQ_CHANNELS 里显式配置的顺序尝试子渠道：成功即返回；某个子渠道失败
 * （网络错误、HTTP 非 2xx）打印警告并尝试下一个；全部失败才抛错让 CI step
 * 失败。子渠道 mini 契约：
 *   name              子渠道名（= 顺序变量里的取值）
 *   envHint           未配置时的降级提示（所需环境变量）
 *   targets           可服务的聚合渠道（如 ['wechat']；缺省 = wechat/qq 均可）
 *   isConfigured(env) 该子渠道所需配置是否齐全
 *   deliver(doc, env, now, ctx) 发送；成功返回 { sent: true, detail }，失败抛异常
 * ctx = { target: 'wechat' | 'qq' }，同一子渠道可服务两个聚合渠道（如 pushplus）。
 */

import * as serverchan from './serverchan.mjs';
import { buildPushMessage } from './render.mjs';

const SUBS = { serverchan };

export function availableSubs() {
  return Object.keys(SUBS);
}

/** 解析顺序变量：逗号分隔、大小写不敏感、过滤空项；未设置返回空数组。 */
export function resolveOrder(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 聚合渠道 isConfigured：顺序已配置且其中至少一个子渠道配置齐全。 */
export function isConfigured(env, orderRaw) {
  return resolveOrder(orderRaw).some((n) => SUBS[n] && SUBS[n].isConfigured(env));
}

/**
 * fallback 发送：按 orderNames 顺序尝试已配置的子渠道。
 * 返回值遵循渠道契约（见 ../mail.mjs 头注释）；全部失败抛聚合错误。
 * @param {object} opts
 * @param {string} opts.orderRaw  顺序变量原始值
 * @param {string} opts.orderVar  顺序变量名（报错文案用）
 * @param {string} opts.orderExample  顺序示例（报错文案用）
 * @param {'wechat'|'qq'} opts.target
 * @param {object} opts.doc  提醒文档
 * @param {object} opts.env
 * @param {number} [opts.now]
 */
export async function deliverOrdered({ orderRaw, orderVar, orderExample, target, doc, env, now = Date.now() }) {
  const names = resolveOrder(orderRaw);
  if (names.length === 0) {
    return { sent: false, detail: `未配置 ${orderVar}（子渠道顺序，逗号分隔，如 ${orderVar}=${orderExample}）` };
  }
  const unknown = names.filter((n) => !SUBS[n] || (SUBS[n].targets && !SUBS[n].targets.includes(target)));
  if (unknown.length > 0) {
    throw new Error(
      `${orderVar} 中的子渠道不可用：${unknown.join(', ')}。` +
        `${target} 可用子渠道：${availableSubs().filter((n) => !SUBS[n].targets || SUBS[n].targets.includes(target)).join(', ')}`
    );
  }
  const unconfigured = names.filter((n) => !SUBS[n].isConfigured(env));
  if (unconfigured.length === names.length) {
    return {
      sent: false,
      detail: `子渠道均未配置所需变量：${unconfigured.map((n) => `${n}（${SUBS[n].envHint.join(' / ')}）`).join('，')}`
    };
  }
  const failures = [];
  for (const name of names) {
    const sub = SUBS[name];
    if (!sub.isConfigured(env)) {
      console.error(`[moocflow] ${target} 子渠道 ${name} 未配置（${sub.envHint.join(' / ')}），跳过`);
      continue;
    }
    try {
      const res = await sub.deliver(doc, env, now, { target });
      return { sent: true, detail: `${name}：${res.detail}` };
    } catch (e) {
      console.error(`[moocflow] ${target} 子渠道 ${name} 发送失败，尝试下一个：${e.message}`);
      failures.push(`${name}：${e.message}`);
    }
  }
  throw new Error(`${target} 所有子渠道发送失败（${failures.join('；')}）`);
}

/** 聚合渠道 renderPreview：无 env 参数、无法感知子渠道，统一用共享正文。 */
export function buildPushPreview(doc, now = Date.now()) {
  return buildPushMessage(doc, now).text;
}
