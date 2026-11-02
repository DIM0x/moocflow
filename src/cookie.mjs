/**
 * Cookie 刷新：用长效凭证 STUDY_PERSIST 触发 icourse163 的静默重登。
 *
 * 已验证链路（2026-11-02）：
 *   GET https://www.icourse163.org/  (Cookie: STUDY_PERSIST=...)
 *     → 302 /passport/logingate/changeCookie.htm?type=study&returnUrl=...&loginWay=0
 *     → 200 Set-Cookie: STUDY_SESS / STUDY_PERSIST / STUDY_INFO
 *   用返回的新 NTESSTUDYSI + STUDY_SESS 即可继续调 RPC。
 *
 * 刷新失败不代表账号密码错误：只说明 STUDY_PERSIST 也失效了，需要用户重新抓 Cookie。
 */

import { ICOURSE_ORIGIN, ICOURSE_UA } from './icourse163.mjs';

export class CookieRefreshError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CookieRefreshError';
  }
}

export function parseCookieString(cookie) {
  const jar = new Map();
  for (const part of String(cookie || '').split(';')) {
    const s = part.trim();
    const i = s.indexOf('=');
    if (i > 0) jar.set(s.slice(0, i).trim(), s.slice(i + 1).trim());
  }
  return jar;
}

export function serializeCookieJar(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function getSetCookieHeaders(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(/,(?=[^;,]+=)/) : [];
}

function parseSetCookie(header) {
  const [pair, ...attrs] = String(header).split(';');
  const i = pair.indexOf('=');
  if (i <= 0) return null;
  const name = pair.slice(0, i).trim();
  const value = pair.slice(i + 1).trim();
  const attributes = {};
  for (const attr of attrs) {
    const t = attr.trim();
    const j = t.indexOf('=');
    if (j < 0) attributes[t.toLowerCase()] = true;
    else attributes[t.slice(0, j).toLowerCase()] = t.slice(j + 1);
  }
  return { name, value, attributes };
}

function isDeletion({ attributes }) {
  if (attributes['max-age'] !== undefined && Number(attributes['max-age']) <= 0) return true;
  if (attributes.expires) {
    const expiresAt = Date.parse(attributes.expires);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return true;
  }
  return false;
}

/** 把 Set-Cookie 头合并进 jar；同名 cookie 以响应为准，过期/删除标记会移除。 */
export function mergeSetCookieHeaders(jar, headers) {
  for (const header of headers) {
    const parsed = parseSetCookie(header);
    if (!parsed) continue;
    if (isDeletion(parsed)) jar.delete(parsed.name);
    else jar.set(parsed.name, parsed.value);
  }
}

function cookieHeader(jar) {
  return serializeCookieJar(jar);
}

/**
 * 用 STUDY_PERSIST 触发静默重登，返回刷新后的完整 Cookie 串。
 * @param {object} opts
 * @param {string} opts.cookie 当前完整 Cookie 串（必须包含 STUDY_PERSIST）
 * @param {Function} [opts.fetchImpl] 可注入的 fetch（测试用）
 * @param {string} [opts.origin]
 * @param {number} [opts.maxRedirects]
 * @returns {Promise<{cookie: string, jar: Map<string,string>}>}
 */
export async function refreshCookie({
  cookie,
  fetchImpl = fetch,
  origin = ICOURSE_ORIGIN,
  maxRedirects = 6
} = {}) {
  const resultJar = parseCookieString(cookie);
  if (!resultJar.get('STUDY_PERSIST')) {
    throw new CookieRefreshError('Cookie 中缺少 STUDY_PERSIST，无法自动刷新');
  }

  // 请求时先去掉会话/CSRF cookie，强制服务器走 changeCookie 重新签发。
  const requestJar = new Map(resultJar);
  requestJar.delete('STUDY_SESS');
  requestJar.delete('NTESSTUDYSI');

  let sawNewSession = false;
  let url = origin + '/';
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': ICOURSE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: origin + '/',
        ...(requestJar.size ? { Cookie: cookieHeader(requestJar) } : {})
      }
    });

    const setCookies = getSetCookieHeaders(res);
    if (setCookies.some((header) => /^\s*STUDY_SESS\s*=/i.test(header))) sawNewSession = true;
    mergeSetCookieHeaders(resultJar, setCookies);
    mergeSetCookieHeaders(requestJar, setCookies);

    const location = res.headers.get('location');
    if (location && res.status >= 300 && res.status < 400) {
      url = new URL(location, url).href;
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new CookieRefreshError(`刷新请求返回 HTTP ${res.status}`);
    }
    break;
  }

  if (!sawNewSession) {
    throw new CookieRefreshError('刷新响应未下发新的 STUDY_SESS，STUDY_PERSIST 可能已失效');
  }
  const missing = ['STUDY_SESS', 'NTESSTUDYSI', 'STUDY_PERSIST'].filter(
    (name) => !resultJar.get(name)
  );
  if (missing.length) {
    throw new CookieRefreshError(`刷新后仍缺少 ${missing.join('、')}，STUDY_PERSIST 可能已失效`);
  }

  return { cookie: serializeCookieJar(resultJar), jar: resultJar };
}
