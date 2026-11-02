import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCookieString,
  serializeCookieJar,
  mergeSetCookieHeaders,
  refreshCookie,
  CookieRefreshError
} from '../src/cookie.mjs';

test('parse/serialize cookie 串保持名字与值', () => {
  const jar = parseCookieString('a=1; STUDY_PERSIST=abc=def; b=2');
  assert.equal(jar.get('a'), '1');
  assert.equal(jar.get('STUDY_PERSIST'), 'abc=def');
  assert.equal(serializeCookieJar(jar), 'a=1; STUDY_PERSIST=abc=def; b=2');
});

test('mergeSetCookieHeaders 更新同名 cookie，并处理 Max-Age=0 删除', () => {
  const jar = parseCookieString('a=1; b=2');
  mergeSetCookieHeaders(jar, ['a=9; Path=/', 'b=; Max-Age=0', 'c=3; Path=/; HttpOnly']);
  assert.equal(jar.get('a'), '9');
  assert.equal(jar.has('b'), false);
  assert.equal(jar.get('c'), '3');
});

test('refreshCookie 走主页 302 → changeCookie，并换发新的会话/CSRF/persist', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://www.icourse163.org/') {
      const headers = new Headers({ Location: 'https://www.icourse163.org/passport/logingate/changeCookie.htm?type=study&returnUrl=x&loginWay=0' });
      headers.append('Set-Cookie', 'NTESSTUDYSI=newcsrf; Path=/');
      return new Response(null, { status: 302, headers });
    }
    if (url.includes('/passport/logingate/changeCookie.htm')) {
      const headers = new Headers();
      headers.append('Set-Cookie', 'STUDY_INFO=newinfo; Path=/');
      headers.append('Set-Cookie', 'STUDY_SESS=newsess; Path=/; HttpOnly');
      headers.append('Set-Cookie', 'STUDY_PERSIST=newpersist; Path=/; HttpOnly; Max-Age=2592000');
      return new Response('<html></html>', { status: 200, headers });
    }
    throw new Error('unexpected url ' + url);
  };

  const original =
    'WM_TID=abc; NTESSTUDYSI=oldcsrf; STUDY_INFO=oldinfo; STUDY_SESS=oldsess; STUDY_PERSIST=oldpersist; EDUWEBDEVICE=dev';
  const result = await refreshCookie({ cookie: original, fetchImpl });
  const jar = parseCookieString(result.cookie);

  assert.equal(jar.get('WM_TID'), 'abc');
  assert.equal(jar.get('EDUWEBDEVICE'), 'dev');
  assert.equal(jar.get('NTESSTUDYSI'), 'newcsrf');
  assert.equal(jar.get('STUDY_SESS'), 'newsess');
  assert.equal(jar.get('STUDY_PERSIST'), 'newpersist');
  assert.equal(jar.get('STUDY_INFO'), 'newinfo');

  // 第一次请求刻意去掉旧的会话/CSRF，强制服务器重新签发
  assert.match(calls[0].init.headers.Cookie, /STUDY_PERSIST=oldpersist/);
  assert.doesNotMatch(calls[0].init.headers.Cookie, /STUDY_SESS=/);
  assert.doesNotMatch(calls[0].init.headers.Cookie, /NTESSTUDYSI=/);
  // 第二次请求应带上 302 新下发的 NTESSTUDYSI
  assert.match(calls[1].init.headers.Cookie, /NTESSTUDYSI=newcsrf/);
});

test('refreshCookie 缺少 STUDY_PERSIST 时拒绝刷新', async () => {
  await assert.rejects(
    () => refreshCookie({ cookie: 'NTESSTUDYSI=x; STUDY_SESS=y', fetchImpl: async () => {
      throw new Error('不应发起请求');
    } }),
    CookieRefreshError
  );
});

test('refreshCookie 未拿到新会话时抛错（即使旧串里有 STUDY_SESS/NTESSTUDYSI）', async () => {
  await assert.rejects(
    () =>
      refreshCookie({
        cookie: 'STUDY_PERSIST=old; STUDY_SESS=oldsess; NTESSTUDYSI=oldcsrf',
        fetchImpl: async () => new Response('<html>ok</html>', { status: 200 })
      }),
    CookieRefreshError
  );
});
