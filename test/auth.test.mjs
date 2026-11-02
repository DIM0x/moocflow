import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTermDto, AuthExpiredError } from '../src/icourse163.mjs';

const okCookie = 'NTESSTUDYSI=csrf123';
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

test('fetchTermDto 在 result 为空时抛 AuthExpiredError', async () => {
  await assert.rejects(
    () =>
      fetchTermDto({
        cookie: okCookie,
        termId: '1',
        fetchImpl: async () => json({ code: 0, result: null })
      }),
    AuthExpiredError
  );
});

test('fetchTermDto 在 code:-1002 时抛 AuthExpiredError', async () => {
  await assert.rejects(
    () =>
      fetchTermDto({
        cookie: okCookie,
        termId: '1',
        fetchImpl: async () => json({ code: -1002, message: '非法跨域请求', result: null })
      }),
    AuthExpiredError
  );
});

test('fetchTermDto 在 HTTP 401/403 时抛 AuthExpiredError', async () => {
  await assert.rejects(
    () =>
      fetchTermDto({
        cookie: okCookie,
        termId: '1',
        fetchImpl: async () => new Response('no', { status: 401 })
      }),
    AuthExpiredError
  );
});

test('fetchTermDto 对非鉴权业务错误仍抛普通 Error', async () => {
  await assert.rejects(
    () =>
      fetchTermDto({
        cookie: okCookie,
        termId: '1',
        fetchImpl: async () => json({ code: -1007, message: '参数错误', result: null })
      }),
    (e) => e instanceof Error && !(e instanceof AuthExpiredError) && /-1007/.test(e.message)
  );
});

test('fetchTermDto 成功时返回 mocTermDto', async () => {
  const dto = await fetchTermDto({
    cookie: okCookie,
    termId: '1',
    fetchImpl: async () => json({ code: 0, result: { mocTermDto: { courseName: '课程' } } })
  });
  assert.equal(dto.courseName, '课程');
});
