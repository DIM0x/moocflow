/**
 * github 渠道：向用户手动创建的 issue 追加评论，借 GitHub 通知邮件送达用户。
 *
 * 送达原理：用户是 issue 的 author/participant（手动创建即自动订阅），
 * 该 thread 上的新评论——包括 github-actions[bot] 的评论——会触发参与者的
 * 通知邮件。注意这条路不依赖 @mention：bot 的 @mention 通知会被 GitHub
 * 压制，而 thread 参与者通知不会，这正是本渠道绕开压制的方式。
 *
 * 本文件只描述 GitHub 的平台差异（API 路径、鉴权头、bot 识别、字段映射），
 * 发布/清理的通用流程见 issue-factory.mjs。新增其他托管平台的 issue 通知
 * 渠道时，照此写一个平台描述对象并在 channels/index.mjs 注册即可。
 *
 * 需要的配置（Actions 环境大多自动提供；也接受平台无关别名 REPO_TOKEN/REPO_SLUG，
 * 见 src/repo-env.mjs）：
 *   GITHUB_TOKEN / REPO_TOKEN       API 令牌；workflow 需声明 permissions: issues: write
 *   GITHUB_REPOSITORY / REPO_SLUG   仓库全名（"owner/repo"）
 *   REMINDER_ISSUE_NUMBER   用户手动创建提醒 issue 后，把编号存为仓库 Variable；
 *                           非必填，留空默认 1（仓库首个 issue 必为 1 号，见 src/config.mjs）
 *   COMMENT_RETENTION_DAYS  旧评论保留天数（默认 7，见 src/config.mjs）；0 = 只保留最新一条
 *
 * 每次发布新评论后，会删除超过保留期的旧 bot 评论，避免 issue 无限变长。
 * 删除不会撤回已发出的通知邮件；清理失败只记日志，不影响本次提醒。
 */

import {
  createIssueChannel,
  isReminderComment as isNormalizedReminderComment,
  selectExpiredComments as selectExpiredNormalized
} from './issue-factory.mjs';
import { buildCommentBody } from './render.mjs';
import { resolveRepoSlug, resolveRepoToken } from '../repo-env.mjs';

export const name = 'github';
export { buildCommentBody };

const API_ROOT = 'https://api.github.com';

function apiHeaders(env, json = false) {
  const headers = {
    Authorization: `Bearer ${resolveRepoToken(env)}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'moocflow'
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function issueCommentsUrl(env, issueNumber) {
  return `${API_ROOT}/repos/${resolveRepoSlug(env)}/issues/${issueNumber}/comments`;
}

/** GitHub 原始评论 -> 归一化评论；bot 判定：type 为 Bot，或 login 以 [bot] 结尾。 */
export function mapComment(raw) {
  const login = String(raw?.user?.login || '');
  return {
    id: raw?.id,
    body: raw?.body,
    created_at: raw?.created_at,
    url: raw?.html_url,
    isBot: raw?.user?.type === 'Bot' || login.endsWith('[bot]')
  };
}

/** 由 bot 发布、且带本项目签名（隐藏标记或页脚）的评论才算提醒评论。 */
export function isReminderComment(comment) {
  return isNormalizedReminderComment(mapComment(comment));
}

/** 从评论列表中挑出早于 cutoffMs、且不是本次刚发布的那条。 */
export function selectExpiredComments(comments, cutoffMs, keepId) {
  const normalized = (Array.isArray(comments) ? comments : []).map(mapComment);
  return selectExpiredNormalized(normalized, cutoffMs, keepId);
}

const channel = createIssueChannel({
  name,
  errorLabel: 'GitHub',
  isConfigured: (env) => Boolean(resolveRepoToken(env) && resolveRepoSlug(env)),
  unconfiguredDetail: '未配置 GITHUB_TOKEN / GITHUB_REPOSITORY',
  pageSize: 100,
  createRequest: (env, issueNumber, body) => ({
    url: issueCommentsUrl(env, issueNumber),
    options: { method: 'POST', headers: apiHeaders(env, true), body: JSON.stringify({ body }) }
  }),
  listRequest: (env, issueNumber, page) => ({
    url: `${issueCommentsUrl(env, issueNumber)}?per_page=100&page=${page}`,
    options: { headers: apiHeaders(env) }
  }),
  deleteRequest: (env, commentId) => ({
    url: `${API_ROOT}/repos/${resolveRepoSlug(env)}/issues/comments/${commentId}`,
    options: { method: 'DELETE', headers: apiHeaders(env) }
  }),
  mapComment,
  mapCreated: (raw) => ({ id: raw?.id, url: raw?.html_url })
});

export const isConfigured = channel.isConfigured;
export const deliver = channel.deliver;
export const renderPreview = channel.renderPreview;
