/**
 * QQ 官方机器人 子渠道：通过 QQ 开放平台机器人 API 发送群聊消息（合规、官方）。
 *
 * 配置：QQ_BOT_APP_ID / QQ_BOT_SECRET / QQ_BOT_GROUP_OPENID（逗号分隔多个群）。
 * group_openid 只能从群事件回调（@机器人）中获取，管理端查不到——但只需本地
 * 跑一次临时脚本采集并永久复用，CI 之后纯 HTTP 主动发送即可。
 * 鉴权：POST https://api.bot.qq.com/app/getAppAccessToken（appId + clientSecret，
 * 有效期 7200 秒，CI 每次现取即可）；发消息头 Authorization: QQBot <token>。
 * 群消息：POST /v2/groups/<group_openid>/messages，msgType=0（纯文本）。
 * 注意：接口失败也返回 HTTP 200，必须检查响应 body 的 code（0 = 成功）。
 * 前提：群主需在群设置中开启"机器人主动发言"；每群每天主动消息上限 1000 条。
 *
 * 子渠道 mini 契约见 push/index.mjs 头注释。
 */

import { buildPushMessage } from './render.mjs';

export const name = 'qqbot';

/** 仅服务 qq 聚合渠道（官方机器人 API 只送达 QQ）。 */
export const targets = ['qq'];

/** 未配置时的降级提示：列出该子渠道所需的环境变量。 */
export const envHint = ['QQ_BOT_APP_ID', 'QQ_BOT_SECRET', 'QQ_BOT_GROUP_OPENID'];

export function isConfigured(env) {
  return Boolean(env.QQ_BOT_APP_ID && env.QQ_BOT_SECRET && env.QQ_BOT_GROUP_OPENID);
}

const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';

function splitList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function deliver(doc, env, now = Date.now()) {
  const token = await fetchToken(env.QQ_BOT_APP_ID, env.QQ_BOT_SECRET);
  const { text } = buildPushMessage(doc, now);
  const groups = splitList(env.QQ_BOT_GROUP_OPENID);
  for (const groupOpenId of groups) {
    const res = await fetch(`https://api.bot.qq.com/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`
      },
      body: JSON.stringify({ content: text, msgType: 0, msgSeq: 1 })
    });
    await assertAccepted(res, groupOpenId);
  }
  return { sent: true, detail: `已提交 QQ 官方机器人（${groups.length} 个群）` };
}

async function fetchToken(appId, clientSecret) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code) {
    throw new Error(
      `QQ 机器人获取 token 失败：HTTP ${res.status} code=${data.code ?? '无'} ${data.message || ''}`.trimEnd()
    );
  }
  return data.access_token;
}

async function assertAccepted(res, groupOpenId) {
  const data = await res.json().catch(() => ({}));
  // QQ 机器人接口失败也返回 HTTP 200，错误在 body.code（如 40034105 频控）
  if (data.code !== 0) {
    throw new Error(
      `QQ 机器人发送失败（群 ${groupOpenId}）：HTTP ${res.status} code=${data.code ?? '无'} ${data.message || ''}`.trimEnd()
    );
  }
}
