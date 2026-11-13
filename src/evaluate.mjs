/**
 * 互评/自评完成状态检测(2026-11 实测逆向,详见分支 feat/peer-review-detection)。
 *
 * mocTermDto 里只有互评窗口字段(evaluateStart/evaluateEnd/enableEvaluation/scorePubStatus),
 * 不含「我自己评了几份」。互评完成状态来自作业详情页数据源(与页面上
 * `.j-status` 方框 done 类一一对应):
 *
 *   POST {origin}/dwr/call/plaincall/MocEvaluateBean.getEvaluateStatus.dwr
 *   Content-Type: text/plain; charset=UTF-8
 *   body: callCount=1 … c0-param0=NUMBER:<testId> c0-param1=NUMBER:<userId> batchId=1 …
 *
 * 返回 DWR 回调文本:{evaluateStart, evaluateEnd, testId, evaluatorId,
 * stepSubmitted, stepTrained, stepEvaluated, stepSelfEvaluated}。
 *
 * 实测约束(2026-11-12):
 *   - batchId 必须携带,缺失时 DWR 抛 SecurityException;UA/Referer 可省略。
 *   - Cookie 可带可不带:接口按显式 (testId, userId) 查询,不校验会话;
 *     但为行为稳定仍随 Cookie 一起发送。
 *   - userId 不在 mocTermDto 中。主来源:Cookie 的 NETEASE_WDA_UID=<id>#|#…;
 *     fallback:课程页 HTML 内嵌的 webUser(旧版 window.webUser={id:"…"},
 *     新版 business-runtime-globals JSON 的 "webUser":{"id":"…"})。
 */

import { ICOURSE_ORIGIN, ICOURSE_UA } from './icourse163.mjs';

/** DWR 请求单次超时,与 fetchTermDto 对齐。 */
const REQUEST_TIMEOUT_MS = 15000;

/** 互评状态并发查询上限;作业数通常个位数,防多课程叠加时请求过密。 */
const DEFAULT_CONCURRENCY = 4;

/** 从 Cookie 串解析用户 id:NETEASE_WDA_UID=1594594547#|#…(主方案)。 */
export function parseUserIdFromCookie(cookie) {
  const m = /NETEASE_WDA_UID=(\d+)/.exec(String(cookie || ''));
  return m ? m[1] : '';
}

/**
 * 从课程页 HTML 解析用户 id(fallback 方案),兼容两种内嵌格式:
 *   旧版:window.webUser = { …, id:"1594594547", … }
 *   新版:<script id="business-runtime-globals">…"webUser":{"id":"1594594547",…}…
 * 取 webUser 对象起始位置后在一个窗口内找 id 字段,避免整页贪婪匹配误取他人 id。
 */
export function parseUserIdFromHtml(html) {
  const text = String(html || '');
  // 旧版 `window.webUser = {`,新版 `"webUser":{`(键带引号)
  const anchor = /webUser["']?\s*[:=]\s*\{/.exec(text);
  if (!anchor) return '';
  const window = text.slice(anchor.index, anchor.index + 800);
  const m = /["{,]\s*"?id"?\s*[:=]\s*["'](\d{4,})["']/.exec(window);
  return m ? m[1] : '';
}

/**
 * 解析用户 id:先 Cookie(主方案),失败再抓课程页 HTML(fallback)。
 * @param {object} opts
 * @param {string} opts.cookie       完整 Cookie 串
 * @param {Array<object>} [opts.courses]  课程列表(用于构造 fallback 页面候选)
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{userId: string, source: 'cookie'|'page'|''}>}
 *   全部失败时 userId 为空串、source 为 '',调用方按「跳过互评检测」处理。
 */
export async function resolveUserId({ cookie, courses = [], fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const fromCookie = parseUserIdFromCookie(cookie);
  if (fromCookie) return { userId: fromCookie, source: 'cookie' };

  for (const url of buildPageCandidates(courses)) {
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Cookie: cookie,
          Referer: `${ICOURSE_ORIGIN}/`,
          'User-Agent': ICOURSE_UA
        },
        signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
      });
      if (!res.ok) continue;
      const userId = parseUserIdFromHtml(await res.text());
      if (userId) return { userId, source: 'page' };
    } catch {
      /* 换下一个候选页 */
    }
  }
  return { userId: '', source: '' };
}

/** fallback 页面候选:课程自带 pageUrl + 标准 learn 页,最多取 3 个。 */
function buildPageCandidates(courses) {
  const urls = [];
  for (const course of courses) {
    if (course.pageUrl && !urls.includes(course.pageUrl)) urls.push(course.pageUrl);
    if (course.schoolCourseId && course.termId) {
      const learnUrl = `${ICOURSE_ORIGIN}/learn/${course.schoolCourseId}?tid=${course.termId}`;
      if (!urls.includes(learnUrl)) urls.push(learnUrl);
    }
    if (urls.length >= 3) break;
  }
  return urls;
}

/**
 * 挑选需要查询互评状态的条目:启用互评、已提交、成绩未公布的作业。
 * 只有这些条目可能产生互评提醒,其余无需查询(与 collectDueEvents 的
 * 互评分支前置条件保持一致)。
 */
export function pickPeerReviewItems(items) {
  return (items || []).filter(
    (item) =>
      item.type === 'homework' &&
      item.enableEvaluation &&
      item.usedTryCount > 0 &&
      item.scorePubStatus !== 2 &&
      item.testId
  );
}

/** 构造 DWR 请求体。字段顺序与实测报文一致,batchId 缺失会被服务端拒绝。 */
function buildDwrBody(testId, userId, batchId) {
  return [
    'callCount=1',
    'windowName=',
    'c0-scriptName=MocEvaluateBean',
    'c0-methodName=getEvaluateStatus',
    'c0-id=0',
    `c0-param0=NUMBER:${testId}`,
    `c0-param1=NUMBER:${userId}`,
    `batchId=${batchId}`,
    `page=${encodeURIComponent('/learn/')}`,
    'scriptSessionId=' + encodeURIComponent('${scriptSessionId}')
  ].join('\n');
}

/**
 * 解析 DWR 回调文本为状态对象;异常回调/缺字段一律返回 null(调用方按
 * 「未知状态」处理,不抑制提醒)。
 */
export function parseEvaluateStatusResponse(text) {
  const t = String(text || '');
  if (/_remoteHandleException/.test(t)) return null;
  const m = /_remoteHandleCallback\('1','0',\{(.+)\}\)/.exec(t);
  if (!m) return null;
  const body = m[1];
  const flag = (name) => {
    const b = new RegExp(`${name}:(true|false)`).exec(body);
    return b ? b[1] === 'true' : null;
  };
  const status = {
    stepSubmitted: flag('stepSubmitted'),
    stepTrained: flag('stepTrained'),
    stepEvaluated: flag('stepEvaluated'),
    stepSelfEvaluated: flag('stepSelfEvaluated')
  };
  // 关键字段缺失视为解析失败,宁可多提醒不可漏提醒
  if (status.stepEvaluated == null || status.stepSelfEvaluated == null) return null;
  return status;
}

/**
 * 查询单个作业的互评状态;任何失败返回 null。
 * @returns {Promise<{stepSubmitted: boolean, stepTrained: boolean,
 *   stepEvaluated: boolean, stepSelfEvaluated: boolean}|null>}
 */
export async function fetchEvaluateStatus({
  cookie,
  testId,
  userId,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  batchId = 1,
  origin = ICOURSE_ORIGIN
}) {
  try {
    const res = await fetchImpl(
      `${origin}/dwr/call/plaincall/MocEvaluateBean.getEvaluateStatus.dwr`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=UTF-8',
          Cookie: cookie,
          Referer: `${ICOURSE_ORIGIN}/`,
          'User-Agent': ICOURSE_UA
        },
        body: buildDwrBody(testId, userId, batchId),
        signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
      }
    );
    if (!res.ok) return null;
    return parseEvaluateStatusResponse(await res.text());
  } catch {
    return null;
  }
}

/**
 * 批量查询条目的互评状态。
 * @param {object} opts
 * @param {Array<object>} opts.items  extractItems 产物(需含 testId)
 * @param {string} opts.userId        用户 id;为空时直接返回空 map(跳过检测)
 * @param {number} [opts.concurrency]
 * @returns {Promise<Object<string, object>>} testId → 状态对象(仅含成功查询的条目)
 */
export async function fetchEvaluateStatuses({
  cookie,
  items,
  userId,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  origin = ICOURSE_ORIGIN
} = {}) {
  const candidates = pickPeerReviewItems(items);
  const map = {};
  if (!userId || candidates.length === 0) return map;

  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const item = candidates[cursor++];
      const status = await fetchEvaluateStatus({
        cookie,
        testId: item.testId,
        userId,
        fetchImpl,
        timeoutMs,
        origin
      });
      if (status) map[item.testId] = status;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, worker)
  );
  return map;
}
