/**
 * gitlab 渠道：向 GitLab / 极狐 GitLab 仓库的 issue 追加评论。
 *
 * 与 github 渠道的差异：
 *   1. 鉴权用 `PRIVATE-TOKEN` 头，令牌需要 `api` scope。**CI_JOB_TOKEN 不行**
 *      （官方权限清单里只有只读的 MR notes，没有任何写评论的通路）。
 *   2. issue 编号在 API 里叫 iid，评论叫 note。
 *   3. GitLab 允许删除自己发布的 note，因此沿用「发新评论 + 按保留期清理旧评论」，
 *      `COMMENT_RETENTION_DAYS` 与 github 渠道语义一致。
 *   4. 极狐 GitLab SaaS 免费版**不能用项目访问令牌**（付费功能），
 *      只能用个人访问令牌（PAT，scope=api，令牌用户需为项目成员）。
 *
 * 需要的配置（CI 中大多自动提供）：
 *   GITLAB_TOKEN       必填；个人访问令牌（本地调试可改用 REPO_TOKEN 别名）
 *   CI_PROJECT_ID      CI 自动提供；项目 ID（本地调试可用 GITLAB_PROJECT 覆盖）
 *   CI_API_V4_URL      CI 自动提供；API 地址（如 https://jihulab.com/api/v4）
 *   CI_PROJECT_URL     CI 自动提供；项目页面地址，用于拼接 issue 链接
 *   REMINDER_ISSUE_NUMBER  提醒 issue 编号（非必填，默认 1，见 src/config.mjs）
 *   COMMENT_RETENTION_DAYS 旧评论保留天数（默认 7，见 src/config.mjs）
 *   GITLAB_BOT_LOGIN   可选；限定"自己"的评论作者名。不设置时只按正文签名识别，
 *                      兼容 PAT 与项目访问令牌（后者的作者是 project_xxx_bot）。
 *
 * 提醒送达：GitLab 会给 issue 参与者发送 "New comment" 通知（邮件/站内），
 * 因此由你手动建 issue、bot 只评论的模式与 github 渠道一致。
 */

import { createIssueChannel } from './issue-factory.mjs';
import { buildCommentBody } from './render.mjs';

export const name = 'gitlab';

const DEFAULT_API_URL = 'https://gitlab.com/api/v4';

function nonEmpty(value) {
  return value != null && String(value).trim() !== '' ? String(value).trim() : undefined;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

/** API 地址：GITLAB_API_URL（本地调试）> CI_API_V4_URL > gitlab.com。 */
export function apiBase(env = {}) {
  return trimTrailingSlash(
    nonEmpty(env.GITLAB_API_URL) || nonEmpty(env.CI_API_V4_URL) || DEFAULT_API_URL
  );
}

function resolveToken(env) {
  return nonEmpty(env.GITLAB_TOKEN) || nonEmpty(env.REPO_TOKEN);
}

/** 项目标识：GITLAB_PROJECT > CI_PROJECT_ID > REPO_SLUG；路径形式的项目需要 URL 编码。 */
export function resolveGitlabProject(env = {}) {
  const explicit = nonEmpty(env.GITLAB_PROJECT);
  if (explicit) return /^\d+$/.test(explicit) ? explicit : encodeURIComponent(explicit);
  const id = nonEmpty(env.CI_PROJECT_ID);
  if (id) return id;
  const slug = nonEmpty(env.REPO_SLUG);
  return slug ? encodeURIComponent(slug) : undefined;
}

/** issue 页面地址（用于 detail 展示；GitLab note 没有稳定的独立 URL）。 */
export function issueUrl(env, issueNumber) {
  const projectUrl = nonEmpty(env.GITLAB_PROJECT_URL) || nonEmpty(env.CI_PROJECT_URL);
  if (projectUrl) return `${trimTrailingSlash(projectUrl)}/-/issues/${issueNumber}`;
  const origin = apiBase(env).replace(/\/api\/v4$/, '');
  const slug = nonEmpty(env.REPO_SLUG);
  return slug
    ? `${origin}/${slug}/-/issues/${issueNumber}`
    : `${origin}/-/issues/${issueNumber}`;
}

function apiHeaders(env, json = false) {
  const headers = {
    'PRIVATE-TOKEN': resolveToken(env),
    Accept: 'application/json',
    'User-Agent': 'moocflow'
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function notesUrl(env, issueNumber) {
  return `${apiBase(env)}/projects/${resolveGitlabProject(env)}/issues/${issueNumber}/notes`;
}

/**
 * GitLab note -> 归一化评论。
 * 系统 note（如"changed the description"）永远不算提醒评论；作者名默认不校验，
 * 因为项目访问令牌的作者是 `project_xxx_bot`，无法从环境变量推断。
 */
export function mapComment(raw, env = {}) {
  const login = String(raw?.author?.username || '');
  const configuredBot = nonEmpty(env.GITLAB_BOT_LOGIN);
  return {
    id: raw?.id,
    body: raw?.body,
    created_at: raw?.created_at,
    url: raw?.web_url,
    isBot: raw?.system === true ? false : configuredBot ? login === configuredBot : true
  };
}

const channel = createIssueChannel({
  name,
  errorLabel: 'GitLab',
  isConfigured: (env) => Boolean(resolveToken(env) && resolveGitlabProject(env)),
  unconfiguredDetail: '未配置 GITLAB_TOKEN / CI_PROJECT_ID',
  pageSize: 100,
  createRequest: (env, issueNumber, body) => ({
    url: notesUrl(env, issueNumber),
    options: {
      method: 'POST',
      headers: apiHeaders(env, true),
      body: JSON.stringify({ body })
    }
  }),
  listRequest: (env, issueNumber, page) => ({
    url: `${notesUrl(env, issueNumber)}?order_by=created_at&sort=asc&per_page=100&page=${page}`,
    options: { headers: apiHeaders(env) }
  }),
  deleteRequest: (env, commentId, issueNumber) => ({
    url: `${notesUrl(env, issueNumber)}/${commentId}`,
    options: { method: 'DELETE', headers: apiHeaders(env) }
  }),
  mapComment,
  mapCreated: (raw, env, issueNumber) => ({
    id: raw?.id,
    url: issueUrl(env, issueNumber)
  }),
  createErrorHints: {
    401: '（GITLAB_TOKEN 无效或已过期）',
    403: '（GITLAB_TOKEN 缺少 api scope，或令牌用户不是项目成员）',
    404: '（常见原因：REMINDER_ISSUE_NUMBER 指向的 issue 不存在，或令牌无权访问该项目）'
  }
});

export { buildCommentBody };

export const isConfigured = channel.isConfigured;
export const deliver = channel.deliver;
export const renderPreview = channel.renderPreview;
