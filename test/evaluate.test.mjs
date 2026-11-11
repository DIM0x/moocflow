import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUserIdFromCookie,
  parseUserIdFromHtml,
  resolveUserId,
  pickPeerReviewItems,
  parseEvaluateStatusResponse,
  fetchEvaluateStatus,
  fetchEvaluateStatuses
} from '../src/evaluate.mjs';

// ── userId 解析:主方案(Cookie) ──

test('parseUserIdFromCookie 从 NETEASE_WDA_UID 取用户 id', () => {
  const cookie = 'a=1; NETEASE_WDA_UID=1594594547#|#1757336354453; b=2';
  assert.equal(parseUserIdFromCookie(cookie), '1594594547');
});

test('parseUserIdFromCookie 缺失/畸形 Cookie 返回空串', () => {
  assert.equal(parseUserIdFromCookie('a=1; b=2'), '');
  assert.equal(parseUserIdFromCookie('NETEASE_WDA_UID=#|#123'), '');
  assert.equal(parseUserIdFromCookie(''), '');
  assert.equal(parseUserIdFromCookie(null), '');
});

// ── userId 解析:fallback(课程页 HTML) ──

test('parseUserIdFromHtml 兼容旧版 window.webUser 内嵌', () => {
  const html =
    'ow.serverTime = 1794416497800; window.webUser = { rightsTime: "-1", ' +
    'lastRightsTime: "-1", id:"1594594547", nickName:"张三", roles:[ ], ' +
    'passport:"a@163.com" };';
  assert.equal(parseUserIdFromHtml(html), '1594594547');
});

test('parseUserIdFromHtml 兼容新版 business-runtime-globals JSON', () => {
  const html =
    '<script id="business-runtime-globals">(() => { const s = ' +
    '{"webUser":{"id":"1594594547","userId":"1594594547","name":"张三",' +
    '"realname":"张三"}}; })();</script>';
  assert.equal(parseUserIdFromHtml(html), '1594594547');
});

test('parseUserIdFromHtml 无 webUser 或无 id 时返回空串', () => {
  assert.equal(parseUserIdFromHtml('<html>普通页面</html>'), '');
  assert.equal(parseUserIdFromHtml('window.webUser = { nickName:"张三" };'), '');
  assert.equal(parseUserIdFromHtml(''), '');
  assert.equal(parseUserIdFromHtml(null), '');
});

// ── resolveUserId:主方案命中时不发请求,fallback 逐候选尝试 ──

test('resolveUserId 主方案:Cookie 可解析时不发任何请求', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called++;
    throw new Error('不应发起请求');
  };
  const { userId, source } = await resolveUserId({
    cookie: 'NETEASE_WDA_UID=1594594547#|#1',
    courses: [{ pageUrl: 'https://www.icourse163.org/learn/X?tid=1' }],
    fetchImpl
  });
  assert.equal(userId, '1594594547');
  assert.equal(source, 'cookie');
  assert.equal(called, 0);
});

test('resolveUserId fallback:Cookie 缺失时抓课程页解析 webUser.id', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return {
      ok: true,
      text: async () =>
        `<script>const s = {"webUser":{"id":"1594594547","name":"x"}};</script>`
    };
  };
  const { userId, source } = await resolveUserId({
    cookie: 'a=1',
    courses: [{ pageUrl: 'https://www.icourse163.org/mooc/learn/X/announce?tid=1' }],
    fetchImpl
  });
  assert.equal(userId, '1594594547');
  assert.equal(source, 'page');
  assert.deepEqual(urls, ['https://www.icourse163.org/mooc/learn/X/announce?tid=1']);
});

test('resolveUserId fallback:第一个候选失败自动换下一个;全失败返回空', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (urls.length === 1) return { ok: false, status: 302, text: async () => '' };
    if (urls.length === 2) throw new Error('网络错误');
    return {
      ok: true,
      text: async () => 'window.webUser = { id:"1594594547" };'
    };
  };
  const courses = [
    { pageUrl: 'https://u1', schoolCourseId: 'C1', termId: '1' },
    { schoolCourseId: 'C2', termId: '2' }
  ];
  const { userId, source } = await resolveUserId({ cookie: 'a=1', courses, fetchImpl });
  assert.equal(userId, '1594594547');
  assert.equal(source, 'page');
  assert.deepEqual(urls, ['https://u1', 'https://www.icourse163.org/learn/C1?tid=1', 'https://www.icourse163.org/learn/C2?tid=2']);

  const none = await resolveUserId({
    cookie: 'a=1',
    courses: [{ schoolCourseId: 'C', termId: '1' }],
    fetchImpl: async () => ({ ok: true, text: async () => '<html></html>' })
  });
  assert.deepEqual(none, { userId: '', source: '' });
});

// ── 待查条目挑选 ──

test('pickPeerReviewItems 只留「启用互评+已提交+未出成绩+有 testId」的作业', () => {
  const items = [
    { type: 'homework', enableEvaluation: true, usedTryCount: 1, scorePubStatus: 0, testId: 'a' },
    { type: 'quiz', enableEvaluation: true, usedTryCount: 1, scorePubStatus: 0, testId: 'b' },
    { type: 'homework', enableEvaluation: false, usedTryCount: 1, scorePubStatus: 0, testId: 'c' },
    { type: 'homework', enableEvaluation: true, usedTryCount: 0, scorePubStatus: 0, testId: 'd' },
    { type: 'homework', enableEvaluation: true, usedTryCount: 1, scorePubStatus: 2, testId: 'e' },
    { type: 'homework', enableEvaluation: true, usedTryCount: 1, scorePubStatus: 0, testId: '' }
  ];
  assert.deepEqual(
    pickPeerReviewItems(items).map((i) => i.testId),
    ['a']
  );
});

// ── DWR 响应解析 ──

const REAL_RESPONSE =
  "//#DWR-INSERT\n//#DWR-REPLY\ndwr.engine._remoteHandleCallback('1','0'," +
  '{evaluateEnd:1791819000000,evaluateStart:1790636400000,evaluatorId:1594594547,' +
  'stepEvaluated:true,stepSelfEvaluated:true,stepSubmitted:true,stepTrained:false,' +
  'testEnd:1790609400000,testId:1258594885,testStart:1789858839384});\n';

test('parseEvaluateStatusResponse 解析真实 DWR 回调文本', () => {
  assert.deepEqual(parseEvaluateStatusResponse(REAL_RESPONSE), {
    stepSubmitted: true,
    stepTrained: false,
    stepEvaluated: true,
    stepSelfEvaluated: true
  });
});

test('parseEvaluateStatusResponse 异常回调/缺字段/乱文本返回 null', () => {
  const exceptionResp =
    "dwr.engine._remoteHandleException('1','0',{ name:'java.lang.Exception' });";
  assert.equal(parseEvaluateStatusResponse(exceptionResp), null);
  assert.equal(
    parseEvaluateStatusResponse("dwr.engine._remoteHandleCallback('1','0',{stepEvaluated:true});"),
    null
  );
  assert.equal(parseEvaluateStatusResponse('not-dwr'), null);
  assert.equal(parseEvaluateStatusResponse(''), null);
});

// ── fetchEvaluateStatus / fetchEvaluateStatuses ──

test('fetchEvaluateStatus 构造标准 DWR 报文并解析结果', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, text: async () => REAL_RESPONSE };
  };
  const status = await fetchEvaluateStatus({
    cookie: 'a=1',
    testId: '1258594885',
    userId: '1594594547',
    fetchImpl
  });
  assert.equal(status.stepEvaluated, true);
  assert.equal(status.stepSelfEvaluated, true);
  assert.match(captured.url, /MocEvaluateBean\.getEvaluateStatus\.dwr$/);
  assert.equal(captured.init.method, 'POST');
  assert.match(captured.init.headers['Content-Type'], /text\/plain/);
  assert.match(captured.init.body, /c0-scriptName=MocEvaluateBean/);
  assert.match(captured.init.body, /c0-param0=NUMBER:1258594885/);
  assert.match(captured.init.body, /c0-param1=NUMBER:1594594547/);
  assert.match(captured.init.body, /batchId=\d+/);
});

test('fetchEvaluateStatus HTTP 错误/网络异常返回 null(不抛出)', async () => {
  const bad = await fetchEvaluateStatus({
    cookie: 'a',
    testId: '1',
    userId: '2',
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' })
  });
  assert.equal(bad, null);

  const thrown = await fetchEvaluateStatus({
    cookie: 'a',
    testId: '1',
    userId: '2',
    fetchImpl: async () => {
      throw new Error('boom');
    }
  });
  assert.equal(thrown, null);
});

test('fetchEvaluateStatuses 批量查询:按 testId 建 map,失败的条目不进 map', async () => {
  const items = [
    { type: 'homework', enableEvaluation: true, usedTryCount: 1, scorePubStatus: 0, testId: 'A', title: '作业A' },
    { type: 'homework', enableEvaluation: true, usedTryCount: 1, scorePubStatus: 0, testId: 'B', title: '作业B' },
    { type: 'quiz', enableEvaluation: true, usedTryCount: 1, scorePubStatus: 0, testId: 'C', title: '测验' }
  ];
  const calledIds = [];
  const fetchImpl = async (url, init) => {
    calledIds.push(/c0-param0=NUMBER:(\w+)/.exec(init.body)[1]);
    const text =
      /c0-param0=NUMBER:A/.test(init.body)
        ? REAL_RESPONSE
        : "dwr.engine._remoteHandleException('1','0',{});";
    return { ok: true, text: async () => text };
  };
  const map = await fetchEvaluateStatuses({
    cookie: 'a=1',
    items,
    userId: '1594594547',
    fetchImpl
  });
  assert.deepEqual(calledIds.sort(), ['A', 'B']);
  assert.deepEqual(Object.keys(map), ['A']);
  assert.equal(map.A.stepEvaluated, true);
});

test('fetchEvaluateStatuses 无 userId 或无候选条目时不发请求', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called++;
    throw new Error('不应发起请求');
  };
  const items = [
    { type: 'homework', enableEvaluation: true, usedTryCount: 1, scorePubStatus: 0, testId: 'A' }
  ];
  assert.deepEqual(await fetchEvaluateStatuses({ cookie: 'a', items, userId: '', fetchImpl }), {});
  assert.deepEqual(
    await fetchEvaluateStatuses({ cookie: 'a', items: [], userId: '123', fetchImpl }),
    {}
  );
  assert.equal(called, 0);
});
