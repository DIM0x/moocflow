/**
 * icourse163.org web/j RPC 拉取。
 *
 * 已验证的调用方式（见 MEMORY.md 6/7 条，2026-11-01 云端全链路验证）：
 *   POST https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey={NTESSTUDYSI}
 *   Content-Type: application/json;charset=UTF-8
 *   Body: {"termId": "1488060444"}   —— 数字/字符串均可；必须带 termId，空 body 返回 result:null
 *   RPC 鉴权需要两枚 cookie：NTESSTUDYSI（CSRF，URL ?csrfKey= 同值）+ STUDY_SESS（会话票据）。
 *   STUDY_PERSIST 是长效“记住我”凭证，但不被 RPC 直接接受；会话失效时用它走
 *   /passport/logingate/changeCookie.htm 静默重登，换发新的 STUDY_SESS/NTESSTUDYSI。
 */

export const ICOURSE_ORIGIN = 'https://www.icourse163.org';
export const MAIN_ENDPOINT = 'web/j/courseBean.getLastLearnedMocTermDto.rpc';

/** SPOC 课程介绍页：无需登录，页面内嵌源课程（OOC）的学期信息。 */
export const SPOC_COURSE_PATH = '/spoc/course/';

export const ICOURSE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

/** Cookie/会话失效类错误：调用方可以据此决定是否触发静默重登。 */
export class AuthExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

/** 从完整 Cookie 串里提取 NTESSTUDYSI 的值（同时用作 csrfKey）。 */
export function extractCsrf(cookie) {
  const m = /NTESSTUDYSI=([^;]+)/i.exec(String(cookie || ''));
  return m ? m[1].trim() : '';
}

/**
 * 拉取一门课的整课 DTO。
 * @param {object} opts
 * @param {string} opts.cookie   完整浏览器 Cookie 串（必须包含 NTESSTUDYSI 与 STUDY_SESS）
 * @param {string|number} opts.termId  学期 id
 * @param {Function} [opts.fetchImpl]  可注入的 fetch（测试用）
 * @returns {Promise<object>} mocTermDto（result.mocTermDto）
 */
export async function fetchTermDto({ cookie, termId, fetchImpl = fetch }) {
  const csrfKey = extractCsrf(cookie);
  if (!csrfKey) {
    throw new AuthExpiredError('Cookie 中未找到 NTESSTUDYSI，无法构造 csrfKey');
  }
  const url = `${ICOURSE_ORIGIN}/${MAIN_ENDPOINT}?csrfKey=${encodeURIComponent(csrfKey)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Cookie: cookie,
      Referer: `${ICOURSE_ORIGIN}/`,
      'User-Agent': ICOURSE_UA
    },
    body: JSON.stringify({ termId: String(termId) })
  });
  if (res.status === 401 || res.status === 403) {
    throw new AuthExpiredError(`HTTP ${res.status} ${res.statusText}（termId=${termId}）`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}（termId=${termId}）`);
  }
  const data = await res.json();
  if (data && data.code !== undefined && Number(data.code) !== 0) {
    if (Number(data.code) === -1002) {
      throw new AuthExpiredError(
        `接口返回 code:-1002 ${data.message || ''}（termId=${termId}，Cookie/CSRF 可能失效）`
      );
    }
    throw new Error(`接口返回 code:${data.code} ${data.message || ''}（termId=${termId}）`);
  }
  const dto = data && data.result && data.result.mocTermDto ? data.result.mocTermDto : data && data.result;
  if (!dto || typeof dto !== 'object') {
    throw new AuthExpiredError(
      `返回 result 为空（termId=${termId}）。常见原因：会话已失效、Cookie 不完整或 NTESSTUDYSI 已过期`
    );
  }
  return dto;
}

/** 截取从 start（必须是 `{`）开始、花括号配平的 JS 对象字面量文本。 */
function sliceBalancedObject(text, start) {
  let depth = 0;
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      i = newline < 0 ? text.length : newline;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** 取页面里 `window.<name> = { ... }` 的对象字面量（页面是 JS 而非 JSON，不能直接 parse）。 */
export function extractWindowObject(html, name) {
  const text = String(html || '');
  const assignment = new RegExp(`window\\.${name}\\s*=`).exec(text);
  if (!assignment) return '';
  const start = text.indexOf('{', assignment.index + assignment[0].length);
  if (start < 0) return '';
  return sliceBalancedObject(text, start);
}

function extractObjectNumber(objectText, field) {
  const m = new RegExp(`\\b${field}\\s*:\\s*['"]?(\\d+)`).exec(objectText || '');
  return m ? m[1] : '';
}

/**
 * 从页面 HTML 解析 SPOC 的源课程 termId。
 *
 * SPOC 的学习页与公开介绍页各暴露一份，两处内容一致：
 * - 公开介绍页 `/spoc/course/{schoolCourseId}`：`window.moocCourseCardDto.currentTermId`
 *   （源课程卡片；无需登录，优先使用）
 * - 学习页 `/spoc/learn/{schoolCourseId}?tid=…`：`window.moocTermDto.id`
 *   （参考项目 spoc-tid-bridge.js 读取的同一个变量；需要有效会话）
 *
 * 注意：学习页的 `window.termDto.id` 是路由 term（老师新增内容），不是源课程 term。
 * @param {string} html
 * @returns {string} 源课程 termId；页面没有该信息时返回空串
 */
export function parseSpocSourceTermId(html) {
  const card = extractWindowObject(html, 'moocCourseCardDto');
  const currentTermId = extractObjectNumber(card, 'currentTermId');
  if (currentTermId) return currentTermId;

  const term = extractWindowObject(html, 'moocTermDto');
  return extractObjectNumber(term, 'id');
}

/**
 * 解析 SPOC 关联的源课程 termId。
 * 先试公开介绍页（不依赖登录态），再回退到学习页（需要 Cookie 中的有效会话）。
 * @param {object} opts
 * @param {string} opts.cookie
 * @param {string} opts.schoolCourseId 形如 NEU-1486300165
 * @param {string} [opts.pageUrl] 课程学习页 URL
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<string>}
 */
export async function fetchSpocSourceTermId({
  cookie,
  schoolCourseId,
  pageUrl,
  fetchImpl = fetch
}) {
  const baseHeaders = {
    Referer: `${ICOURSE_ORIGIN}/`,
    'User-Agent': ICOURSE_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };

  // 公开介绍页刻意不带 Cookie：会话过期时带旧 Cookie 会被 302 到登出页，
  // 反而不带 Cookie 才能拿到正常的公开页面。学习页则必须带 Cookie 才有数据。
  const candidates = [];
  if (schoolCourseId) {
    candidates.push({ url: `${ICOURSE_ORIGIN}${SPOC_COURSE_PATH}${schoolCourseId}`, headers: baseHeaders });
  }
  if (pageUrl && !candidates.some((c) => c.url === pageUrl)) {
    candidates.push({
      url: pageUrl,
      headers: cookie ? { ...baseHeaders, Cookie: cookie } : baseHeaders
    });
  }
  if (candidates.length === 0) throw new Error('缺少 SPOC 课程标识，无法解析源课程 termId');

  const errors = [];
  for (const candidate of candidates) {
    try {
      const res = await fetchImpl(candidate.url, { method: 'GET', headers: candidate.headers });
      if (!res.ok) {
        errors.push(`${candidate.url}: HTTP ${res.status}`);
        continue;
      }
      const termId = parseSpocSourceTermId(await res.text());
      if (termId) return termId;
      errors.push(`${candidate.url}: 页面中未找到源课程 termId`);
    } catch (e) {
      errors.push(`${candidate.url}: ${e.message}`);
    }
  }
  throw new Error(errors.join('；'));
}
