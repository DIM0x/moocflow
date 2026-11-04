/**
 * Issue 类通知渠道工厂：通用流程与平台差异分离。
 *
 * 所有「向仓库 issue 追加评论」的通知渠道（github / gitea / gitlab / gitee …）
 * 共享同一套流程：渲染（render.mjs）→ 发布评论 → 按保留期清理自己发布的旧评论。
 * 平台差异（API 路径、鉴权头、bot 识别、评论字段映射）全部收敛在平台描述对象里，
 * 新增平台 = 写一个描述对象 + 在 channels/index.mjs 注册一行，流程代码零改动。
 *
 * 按平台能力自动选择三种策略：
 *   1. update（如 CNB 无删除接口）→ 覆盖更新最近一条自己的评论；没有则新建。
 *   2. create-cleanup（如 GitHub）→ 新建评论，并按保留期清理旧的自己评论。
 *   3. create → 每次新建，不清理。
 * 平台也可以用可选的 strategy(env) 在运行时指定策略（如 CNB 的更新开关）。
 *
 * 平台描述契约：
 *   name                 渠道名（= NOTIFY_CHANNEL 取值）
 *   errorLabel           报错文案里的平台名（如 "GitHub"）
 *   isConfigured(env)    渠道所需配置是否齐全
 *   unconfiguredDetail   未配置时 deliver 返回的 detail 文案
 *   strategy(env)        可选；返回 "update" | "create-cleanup" | "create"，
 *                        缺省时按 updateRequest / deleteRequest 的能力自动推断
 *   createRequest(env, issueNumber, body) -> { url, options }   发布评论的 fetch 参数
 *   listRequest(env, issueNumber, page)   -> { url, options }   按页列出评论
 *   updateRequest(env, issueNumber, commentId, body) -> { url, options }  可选；覆盖更新评论
 *   deleteRequest(env, commentId, issueNumber) -> { url, options }   可选；删除单条评论
 *   pageSize              列表分页大小（"不足一页即到底"的判断依据）
 *   mapComment(raw, env)  平台原始评论 -> 归一化评论 { id, body, created_at, isBot, url? }
 *   mapCreated(raw, env, issueNumber)   发布/更新响应 -> { id, url }
 *   createErrorHints      可选；{ [status]: string } 覆盖发布失败的默认提示
 *   updateErrorHints      可选；{ [status]: string } 覆盖更新失败的默认提示
 *
 * 归一化评论沿用 GitHub 风格字段（created_at / isBot），各平台的清理语义保持一致。
 */

import { buildCommentBody, BODY_SIGNATURE } from './render.mjs';
import { resolveIssueConfig } from '../config.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const STRATEGIES = new Set(['update', 'create-cleanup', 'create']);

/** 平台未显式指定策略时，按它实现了哪些请求能力推断。 */
function defaultStrategy(description) {
  if (typeof description.updateRequest === 'function') return 'update';
  if (typeof description.deleteRequest === 'function') return 'create-cleanup';
  return 'create';
}

function resolveStrategy(description, env) {
  if (typeof description.strategy !== 'function') return defaultStrategy(description);
  const strategy = description.strategy(env);
  if (!STRATEGIES.has(strategy)) {
    throw new Error(`${description.name} 渠道返回了未知策略 "${strategy}"`);
  }
  if (strategy === 'update' && typeof description.updateRequest !== 'function') {
    throw new Error(`${description.name} 渠道选择了 update 策略，但未实现 updateRequest`);
  }
  if (strategy === 'create-cleanup' && typeof description.deleteRequest !== 'function') {
    throw new Error(`${description.name} 渠道选择了 create-cleanup 策略，但未实现 deleteRequest`);
  }
  return strategy;
}

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
    return description.mapCreated(data, env, issueNumber);
  }

  /** 覆盖更新一条已有评论；失败抛错。平台描述未实现 updateRequest 时不可调用。 */
  async function updateComment(env, issueNumber, commentId, body) {
    const { url, options } = description.updateRequest(env, issueNumber, commentId, body);
    const res = await doFetch(url, options);
    if (!res.ok) {
      const text = await res.text();
      const hints = description.updateErrorHints || description.createErrorHints || DEFAULT_CREATE_HINTS;
      const hint = hints[res.status] ?? '';
      throw new Error(
        `${description.errorLabel} 评论更新失败：HTTP ${res.status} ${text.slice(0, 200)}${hint}`
      );
    }
    const data = await res.json();
    return description.mapCreated(data, env, issueNumber);
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
      const mapped = (Array.isArray(items) ? items : []).map((c) => description.mapComment(c, env));
      const freshIndex = mapped.findIndex((c) => Date.parse(c.created_at) >= cutoffMs);
      collected.push(...(freshIndex === -1 ? mapped : mapped.slice(0, freshIndex)));
      if (freshIndex !== -1 || mapped.length < description.pageSize) break;
    }
    return collected;
  }

  async function deleteComment(env, issueNumber, id) {
    const { url, options } = description.deleteRequest(env, id, issueNumber);
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
        await deleteComment(env, issueNumber, c.id);
        removed++;
      } catch (e) {
        failed++;
        console.error(`[moocflow] 删除旧评论 ${c.id} 失败：${e.message}`);
      }
    }
    return { removed, failed };
  }

  /** 找到本项目最近发布的一条提醒评论；没有则返回 null。 */
  async function findLatestReminderComment(env, issueNumber) {
    // cutoffMs = Infinity：不按时间截断，取全部评论
    const comments = await fetchCommentsBefore(env, issueNumber, Infinity);
    const own = comments.filter(isReminderComment);
    return own.length > 0 ? own[own.length - 1] : null;
  }

  async function deliver(doc, env, now) {
    if (!description.isConfigured(env)) {
      return { sent: false, detail: description.unconfiguredDetail };
    }
    // 先解析配置：值非法时直接报错，避免评论已发布却因清理配置失败而报发送失败
    const { commentRetentionDays, reminderIssueNumber } = resolveIssueConfig(env);
    const body = buildCommentBody(doc, now);
    const strategy = resolveStrategy(description, env);

    // 平台不支持删除评论、改为覆盖更新同一条评论（如 CNB 默认行为），
    // 否则 issue 会无限增长；这是该策略下唯一能保持 issue 干净的做法。
    if (strategy === 'update') {
      const existing = await findLatestReminderComment(env, reminderIssueNumber);
      if (existing) {
        const updated = await updateComment(env, reminderIssueNumber, existing.id, body);
        return { sent: true, detail: `评论已更新：${updated.url}` };
      }
      const created = await createComment(env, reminderIssueNumber, body);
      return { sent: true, detail: `评论已发布：${created.url}` };
    }

    const created = await createComment(env, reminderIssueNumber, body);

    // create 策略：每次新增，不清理（如 CNB_ISSUE_UPDATE_MODE=0）
    if (strategy === 'create') {
      return { sent: true, detail: `评论已发布：${created.url}` };
    }

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

  return {
    name: description.name,

    isConfigured(env) {
      return description.isConfigured(env);
    },

    buildCommentBody,

    renderPreview(doc, now = Date.now()) {
      return buildCommentBody(doc, now);
    },

    deliver
  };
}
