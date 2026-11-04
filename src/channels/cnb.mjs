/**
 * cnb 渠道：向 CNB（cnb.cool）仓库的 issue 追加评论。
 *
 * 与 github 渠道的关键差异：
 *   1. CNB 的 issue 评论 API **没有删除接口**（只有 GET/PATCH），因此不采用
 *      "发新评论 + 清理旧评论"，而是覆盖更新最近一条自己发布的提醒评论，
 *      避免 issue 无限增长（由 issue-factory 的 updateRequest 能力自动选择）。
 *   2. 定时任务由平台固定使用 Asia/Shanghai 时区，cron 无需换算 UTC。
 *   3. 流水线内自动注入临时令牌，无需用户额外配置 PAT。
 *
 * 需要的配置（CNB 流水线大多自动提供）：
 *   CNB_TOKEN         流水线临时令牌（自动注入，结束后销毁），需 repo-notes:rw
 *   CNB_REPO_SLUG     仓库路径（group/repo，自动注入）；也可用 REPO_SLUG 兜底
 *   CNB_API_ENDPOINT  API 地址（自动注入，如 https://api.cnb.cool）；缺省时用默认值
 *   CNB_TOKEN_USER_NAME  令牌对应用户名（自动注入，固定为 cnb），用于识别自己的评论
 *   REMINDER_ISSUE_NUMBER  提醒 issue 编号（非必填，默认 1，见 src/config.mjs）
 *   CNB_ISSUE_UPDATE_MODE  评论更新方式（非必填，默认 1）：
 *                          0 = 每次只发新评论，不修改旧评论；
 *                          1 = 覆盖更新最近一条自己发布的提醒评论
 *
 * 本地调试：自行设置 CNB_TOKEN（个人访问令牌）与 CNB_REPO_SLUG，并把
 * CNB_BOT_LOGIN 设成该令牌对应的用户名，否则无法识别历史评论、会每次新建。
 *
 * 注意：CNB 官方文档未说明 issue 评论会触发站内信/邮件通知，本渠道适合做
 * 平台内留痕；需要可靠送达请用 NOTIFY_CHANNEL=mail。
 */

import { createIssueChannel } from './issue-factory.mjs';
import { buildCommentBody } from './render.mjs';
import { resolveCnbConfig } from '../config.mjs';
import { resolveRepoSlug } from '../repo-env.mjs';

export const name = 'cnb';

const DEFAULT_API_ENDPOINT = 'https://api.cnb.cool';
const DEFAULT_WEB_ENDPOINT = 'https://cnb.cool';

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function apiEndpoint(env) {
  const raw = env.CNB_API_ENDPOINT;
  return trimTrailingSlash(raw && raw.trim() ? raw.trim() : DEFAULT_API_ENDPOINT);
}

function webEndpoint(env) {
  const raw = env.CNB_WEB_ENDPOINT;
  return trimTrailingSlash(raw && raw.trim() ? raw.trim() : DEFAULT_WEB_ENDPOINT);
}

/** 仓库路径：CNB_REPO_SLUG 优先，其次通用别名 REPO_SLUG，便于本地调试。 */
export function resolveCnbRepo(env) {
  const native = env.CNB_REPO_SLUG;
  if (native != null && String(native).trim() !== '') return String(native).trim();
  return resolveRepoSlug(env);
}

function resolveToken(env) {
  const raw = env.CNB_TOKEN;
  return raw != null && String(raw).trim() !== '' ? String(raw).trim() : undefined;
}

/** 评论作者名：流水线内固定为 cnb（CNB_TOKEN_USER_NAME），本地可用 CNB_BOT_LOGIN 覆盖。 */
function botLogin(env) {
  for (const key of ['CNB_BOT_LOGIN', 'CNB_TOKEN_USER_NAME']) {
    const raw = env[key];
    if (raw != null && String(raw).trim() !== '') return String(raw).trim();
  }
  return 'cnb';
}

/** issue 页面地址（用于 detail 展示；CNB 评论没有独立 URL）。 */
export function issueUrl(env, issueNumber) {
  return `${webEndpoint(env)}/${resolveCnbRepo(env)}/-/issues/${issueNumber}`;
}

function apiHeaders(env, json = false) {
  const headers = {
    Authorization: `Bearer ${resolveToken(env)}`,
    Accept: 'application/json',
    'User-Agent': 'moocflow'
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function commentsUrl(env, issueNumber) {
  return `${apiEndpoint(env)}/${resolveCnbRepo(env)}/-/issues/${issueNumber}/comments`;
}

/** CNB 原始评论 -> 归一化评论；作者为令牌用户（cnb）时视为 bot。 */
export function mapComment(raw, env = {}) {
  const login = String(raw?.author?.username || '');
  return {
    id: raw?.id,
    body: raw?.body,
    created_at: raw?.created_at,
    url: undefined,
    isBot: login !== '' && login === botLogin(env)
  };
}

const channel = createIssueChannel({
  name,
  errorLabel: 'CNB',
  isConfigured: (env) => Boolean(resolveToken(env) && resolveCnbRepo(env)),
  unconfiguredDetail: '未配置 CNB_TOKEN / CNB_REPO_SLUG',
  pageSize: 100,
  // CNB 无删除接口：默认覆盖更新同一条评论；CNB_ISSUE_UPDATE_MODE=0 时改为只发新评论
  strategy: (env) => (resolveCnbConfig(env).issueUpdateMode === 1 ? 'update' : 'create'),
  createRequest: (env, issueNumber, body) => ({
    url: commentsUrl(env, issueNumber),
    options: {
      method: 'POST',
      headers: apiHeaders(env, true),
      body: JSON.stringify({ body })
    }
  }),
  listRequest: (env, issueNumber, page) => ({
    url: `${commentsUrl(env, issueNumber)}?sort=created&page=${page}&page_size=100`,
    options: { headers: apiHeaders(env) }
  }),
  // CNB 无删除接口，用覆盖更新同一条评论代替（issue-factory 依此选择 update 策略）
  updateRequest: (env, issueNumber, commentId, body) => ({
    url: `${commentsUrl(env, issueNumber)}/${encodeURIComponent(commentId)}`,
    options: {
      method: 'PATCH',
      headers: apiHeaders(env, true),
      body: JSON.stringify({ body })
    }
  }),
  mapComment,
  mapCreated: (raw, env, issueNumber) => ({
    id: raw?.id,
    url: issueUrl(env, issueNumber)
  }),
  createErrorHints: {
    404: '（常见原因：REMINDER_ISSUE_NUMBER 指向的 issue 不存在，或 CNB_TOKEN 缺少 repo-notes:rw 权限）'
  }
});

export { buildCommentBody };

export const isConfigured = channel.isConfigured;
export const deliver = channel.deliver;
export const renderPreview = channel.renderPreview;
