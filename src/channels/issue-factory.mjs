/**
 * Issue 类通知渠道工厂：通用流程与平台差异分离。
 *
 * 所有「向仓库 issue 追加评论」的通知渠道（github / gitea / gitlab / gitee …）
 * 共享同一套流程：渲染（render.mjs）→ 发布评论 → 按保留期清理自己发布的旧评论。
 * 平台差异（API 路径、鉴权头、bot 识别、评论字段映射）全部收敛在平台描述对象里，
 * 新增平台 = 写一个描述对象 + 在 channels/index.mjs 注册一行，流程代码零改动。
 *
 * 平台描述契约：
 *   name                 渠道名（= NOTIFY_CHANNEL 取值）
 *   errorLabel           报错文案里的平台名（如 "GitHub"）
 *   isConfigured(env)    渠道所需配置是否齐全
 *   unconfiguredDetail   未配置时 deliver 返回的 detail 文案
 *   createRequest(env, issueNumber, body) -> { url, options }   发布评论的 fetch 参数
 *   listRequest(env, issueNumber, page)   -> { url, options }   按页列出评论
 *   deleteRequest(env, commentId)         -> { url, options }   删除单条评论
 *   pageSize              列表分页大小（"不足一页即到底"的判断依据）
 *   mapComment(raw)       平台原始评论 -> 归一化评论 { id, body, created_at, isBot, url? }
 *   mapCreated(raw)       发布响应 -> { id, url }
 *   createErrorHints      可选；{ [status]: string } 覆盖发布失败的默认提示
 *
 * 归一化评论沿用 GitHub 风格字段（created_at / isBot），各平台的清理语义保持一致。
 */

import { buildCommentBody, BODY_SIGNATURE } from './render.mjs';
import { resolveIssueConfig } from '../config.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 发布评论失败时的默认提示（issue 类 API 语义一致，平台描述可覆盖）。 */
const DEFAULT_CREATE_HINTS = {
  404: '（常见原因：REMINDER_ISSUE_NUMBER 指向的 issue 不存在，或 token 缺少 issues: write 权限）'
};

/** 归一化评论是否为本项目发布的提醒评论：bot 身份 + 正文含签名。 */
export function isReminderComment(comment) {
  return (
    Boolean(comment?.isBot) &&
    typeof comment?.body === 'string' &&
    comment.body.includes(BODY_SIGNATURE)
  );
}

/** 从归一化评论列表中挑出早于 cutoffMs、且不是本次刚发布的那条。 */
export function selectExpiredComments(comments, cutoffMs, keepId) {
  return (Array.isArray(comments) ? comments : []).filter(
    (c) => c.id !== keepId && isReminderComment(c) && Date.parse(c.created_at) < cutoffMs
  );
}

/**
 * 装配一个 issue 评论类渠道。
 * @param {object} description 平台描述，契约见文件头注释
 * @param {{fetchImpl?: Function}} [deps] 注入 fetch 便于测试；默认用全局 fetch
 */
export function createIssueChannel(description, { fetchImpl } = {}) {
  // 默认延迟到调用时才取全局 fetch：渠道模块在加载期装配，若在装配期固化
  // fetch 引用，测试就无法通过替换 globalThis.fetch 打桩。
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));

  /** 发布评论；失败抛错（带平台名与状态码提示）。 */
  async function createComment(env, issueNumber, body) {
    const { url, options } = description.createRequest(env, issueNumber, body);
    const res = await doFetch(url, options);
    if (!res.ok) {
      const text = await res.text();
      const hints = description.createErrorHints || DEFAULT_CREATE_HINTS;
      const hint = hints[res.status] ?? '';
      throw new Error(
        `${description.errorLabel} 评论发布失败：HTTP ${res.status} ${text.slice(0, 200)}${hint}`
      );
    }
    const data = await res.json();
    return description.mapCreated(data);
  }

  /** 评论按创建时间升序返回，碰到不早于截止时间的评论即可停止翻页。 */
  async function fetchCommentsBefore(env, issueNumber, cutoffMs) {
    const collected = [];
    for (let page = 1; ; page++) {
      const { url, options } = description.listRequest(env, issueNumber, page);
      const res = await doFetch(url, options);
      if (!res.ok) {
        throw new Error(`获取 issue 评论失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
      const items = await res.json();
      const mapped = (Array.isArray(items) ? items : []).map(description.mapComment);
      const freshIndex = mapped.findIndex((c) => Date.parse(c.created_at) >= cutoffMs);
      collected.push(...(freshIndex === -1 ? mapped : mapped.slice(0, freshIndex)));
      if (freshIndex !== -1 || mapped.length < description.pageSize) break;
    }
    return collected;
  }

  async function deleteComment(env, id) {
    const { url, options } = description.deleteRequest(env, id);
    const res = await doFetch(url, options);
    // 404 = 已经不存在，视作删除成功
    if (!res.ok && res.status !== 404) {
      throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  async function removeExpiredComments(env, issueNumber, keepId, cutoffMs) {
    const comments = await fetchCommentsBefore(env, issueNumber, cutoffMs);
    const expired = selectExpiredComments(comments, cutoffMs, keepId);
    let removed = 0;
    let failed = 0;
    for (const c of expired) {
      try {
        await deleteComment(env, c.id);
        removed++;
      } catch (e) {
        failed++;
        console.error(`[moocflow] 删除旧评论 ${c.id} 失败：${e.message}`);
      }
    }
    return { removed, failed };
  }

  return {
    name: description.name,

    isConfigured(env) {
      return description.isConfigured(env);
    },

    buildCommentBody,

    renderPreview(doc, now = Date.now()) {
      return buildCommentBody(doc, now);
    },

    async deliver(doc, env, now = Date.now()) {
      if (!description.isConfigured(env)) {
        return { sent: false, detail: description.unconfiguredDetail };
      }
      // 先解析配置：值非法时直接报错，避免评论已发布却因清理配置失败而报发送失败
      const { commentRetentionDays, reminderIssueNumber } = resolveIssueConfig(env);
      const created = await createComment(env, reminderIssueNumber, buildCommentBody(doc, now));

      // 清理属于 best-effort：失败只记日志，不影响本次提醒已送达
      let cleanup = '';
      try {
        const { removed, failed } = await removeExpiredComments(
          env,
          reminderIssueNumber,
          created.id,
          now - commentRetentionDays * DAY_MS
        );
        if (removed > 0) cleanup = `；已清理 ${removed} 条超过保留期（${commentRetentionDays} 天）的旧评论`;
        if (failed > 0) cleanup += `；${failed} 条旧评论删除失败（详见日志）`;
      } catch (e) {
        cleanup = `；旧评论清理失败（不影响本次提醒）：${e.message}`;
        console.error(`[moocflow] ${description.name} 渠道旧评论清理失败：${e.message}`);
      }
      return { sent: true, detail: `评论已发布：${created.url}${cleanup}` };
    }
  };
}
