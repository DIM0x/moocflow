/**
 * gitee 渠道：向 Gitee（码云）仓库的 issue 追加评论。
 *
 * 与 github 渠道的差异：
 *   1. 鉴权只支持 `access_token` 参数（GET/DELETE 放 query，POST 放 formData），
 *      官方规范没有定义 Header 认证方式。
 *   2. Gitee 允许删除自己发布的评论，因此沿用「发新评论 + 按保留期清理旧评论」。
 *   3. Gitee Go **没有密文变量**，令牌只能放在明文流水线变量里——这是平台限制，
 *      文档中必须提醒用户使用专用、最小权限、可轮换的令牌。
 *
 * 需要的配置：
 *   GITEE_TOKEN        必填；个人访问令牌，scope 建议 `issues` + `notes`
 *                      （Gitee 未逐接口标注 scope，需实测）
 *   GITEE_REPO_SLUG    仓库路径 `owner/repo`；也可用 GITEE_REPO（需含 /）或 REPO_SLUG
 *   GITEE_API_URL      可选；默认 https://gitee.com/api/v5
 *   GITEE_WEB_URL      可选；默认 https://gitee.com，用于拼接 issue 链接
 *   REMINDER_ISSUE_NUMBER  提醒 issue 编号（非必填，默认 1，见 src/config.mjs）
 *   COMMENT_RETENTION_DAYS 旧评论保留天数（默认 7，见 src/config.mjs）
 *   GITEE_BOT_LOGIN    可选；限定"自己"的评论作者名。不设置时只按正文签名识别。
 *
 * 提醒送达：Gitee 的「任务被评论」站内信默认开启，但**邮件默认关闭**，
 * 需要收件人自行在通知设置里勾选；建议同时配置 mail 渠道或仓库 WebHook。
 */

import { createIssueChannel } from './issue-factory.mjs';
import { buildCommentBody } from './render.mjs';
import { resolveRepoSlug } from '../repo-env.mjs';

export const name = 'gitee';

const DEFAULT_API_URL = 'https://gitee.com/api/v5';
const DEFAULT_WEB_URL = 'https://gitee.com';

function nonEmpty(value) {
  return value != null && String(value).trim() !== '' ? String(value).trim() : undefined;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

export function apiBase(env = {}) {
  return trimTrailingSlash(nonEmpty(env.GITEE_API_URL) || DEFAULT_API_URL);
}

function webBase(env = {}) {
  return trimTrailingSlash(nonEmpty(env.GITEE_WEB_URL) || DEFAULT_WEB_URL);
}

/**
 * 仓库路径：GITEE_REPO_SLUG > GITEE_REPO（必须含 /）> REPO_SLUG。
 * Gitee Go 的 GITEE_REPO 只保证是"代码仓库名"，不含 owner，所以不作为主来源。
 */
export function resolveGiteeRepo(env = {}) {
  const explicit = nonEmpty(env.GITEE_REPO_SLUG);
  if (explicit) return explicit;
  const native = nonEmpty(env.GITEE_REPO);
  if (native && native.includes('/')) return native;
  return resolveRepoSlug(env);
}

function resolveToken(env) {
  return nonEmpty(env.GITEE_TOKEN) || nonEmpty(env.REPO_TOKEN);
}

export function issueUrl(env, issueNumber) {
  return `${webBase(env)}/${resolveGiteeRepo(env)}/issues/${issueNumber}`;
}

function apiHeaders(env, form = false) {
  const headers = { Accept: 'application/json', 'User-Agent': 'moocflow' };
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return headers;
}

function commentsUrl(env, issueNumber) {
  return `${apiBase(env)}/repos/${resolveGiteeRepo(env)}/issues/${issueNumber}/comments`;
}

/** Gitee note -> 归一化评论；默认只按签名识别，可设 GITEE_BOT_LOGIN 限定作者。 */
export function mapComment(raw, env = {}) {
  const login = String(raw?.user?.login || '');
  const configuredBot = nonEmpty(env.GITEE_BOT_LOGIN);
  return {
    id: raw?.id,
    body: raw?.body,
    created_at: raw?.created_at,
    url: undefined,
    isBot: configuredBot ? login === configuredBot : true
  };
}

const channel = createIssueChannel({
  name,
  errorLabel: 'Gitee',
  isConfigured: (env) => Boolean(resolveToken(env) && resolveGiteeRepo(env)),
  unconfiguredDetail: '未配置 GITEE_TOKEN / GITEE_REPO_SLUG',
  pageSize: 100,
  createRequest: (env, issueNumber, body) => ({
    url: commentsUrl(env, issueNumber),
    options: {
      method: 'POST',
      headers: apiHeaders(env, true),
      body: new URLSearchParams({ body, access_token: resolveToken(env) }).toString()
    }
  }),
  listRequest: (env, issueNumber, page) => {
    const params = new URLSearchParams({
      access_token: resolveToken(env),
      page: String(page),
      per_page: '100',
      order: 'asc'
    });
    return {
      url: `${commentsUrl(env, issueNumber)}?${params.toString()}`,
      options: { headers: apiHeaders(env) }
    };
  },
  deleteRequest: (env, commentId) => {
    const params = new URLSearchParams({ access_token: resolveToken(env) });
    return {
      url: `${apiBase(env)}/repos/${resolveGiteeRepo(env)}/issues/comments/${commentId}?${params.toString()}`,
      options: { method: 'DELETE', headers: apiHeaders(env) }
    };
  },
  mapComment,
  mapCreated: (raw, env, issueNumber) => ({
    id: raw?.id,
    url: issueUrl(env, issueNumber)
  }),
  createErrorHints: {
    401: '（GITEE_TOKEN 无效、已过期或 scope 不足）',
    403: '（令牌无权操作该仓库，或缺少 issues/notes 权限）',
    404: '（常见原因：REMINDER_ISSUE_NUMBER 指向的 issue 不存在，或令牌无权访问该仓库）'
  }
});

export { buildCommentBody };

export const isConfigured = channel.isConfigured;
export const deliver = channel.deliver;
export const renderPreview = channel.renderPreview;
