import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTermDto, AuthExpiredError } from '../src/icourse163.mjs';

const okCookie = 'NTESSTUDYSI=csrf123';
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
const noSleep = async () => {};

test('fetchTermDto 在 result 为空时抛 AuthExpiredError', async () => {
  await assert.rejects(
    () =>
      fetchTermDto({
        cookie: okCookie,
        termId: '1',
        fetchImpl: async () => json({ code: 0, result: null }),
        sleepImpl: noSleep
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
        fetchImpl: async () => json({ code: -1002, message: '非法跨域请求', result: null }),
        sleepImpl: noSleep
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
        fetchImpl: async () => new Response('no', { status: 401 }),
        sleepImpl: noSleep
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
        fetchImpl: async () => json({ code: -1007, message: '参数错误', result: null }),
        sleepImpl: noSleep
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

test('fetchTermDto 失败后按 3 秒间隔重试，第三次尝试成功', async () => {
  const delays = [];
  let calls = 0;
  const dto = await fetchTermDto({
    cookie: okCookie,
    termId: '1',
    fetchImpl: async () => {
      calls++;
      return calls < 3
        ? json({ code: 0, result: null })
        : json({ code: 0, result: { mocTermDto: { courseName: '课程' } } });
    },
    sleepImpl: async (ms) => {
      delays.push(ms);
    }
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [3000, 3000]);
  assert.equal(dto.courseName, '课程');
});

test('fetchTermDto 对鉴权错误也重试，连续失败共尝试 4 次', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchTermDto({
        cookie: okCookie,
        termId: '1',
        fetchImpl: async () => {
          calls++;
          return json({ code: -1002, message: '非法跨域请求', result: null });
        },
        sleepImpl: noSleep
      }),
    AuthExpiredError
  );
  assert.equal(calls, 4);
});

test('fetchTermDto 对普通业务错误同样重试', async () => {
  let calls = 0;
  const dto = await fetchTermDto({
    cookie: okCookie,
    termId: '1',
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? json({ code: -1007, message: '参数错误', result: null })
        : json({ code: 0, result: { mocTermDto: { courseName: '课程' } } });
    },
    sleepImpl: noSleep
  });
  assert.equal(calls, 2);
  assert.equal(dto.courseName, '课程');
});

test('fetchTermDto 为请求设置超时信号', async () => {
  let signal;
  await fetchTermDto({
    cookie: okCookie,
    termId: '1',
    fetchImpl: async (url, opts) => {
      signal = opts.signal;
      return json({ code: 0, result: { mocTermDto: { courseName: '课程' } } });
    }
  });
  assert.ok(signal instanceof AbortSignal);
});
