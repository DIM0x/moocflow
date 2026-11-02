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
