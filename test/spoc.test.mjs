import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWindowObject,
  parseSpocSourceTermId,
  fetchSpocSourceTermId
} from '../src/icourse163.mjs';

// 取自真实 SPOC（NEU-1486300165）页面：公开介绍页把源课程卡片单独暴露出来。
const COURSE_PAGE_HTML = `
<script>
window.courseDefaultImg = "//edu-image.nosdn.127.net/x.jpg";
//window.test = { "id": 1 };
window.moocCourseCardDto ={
id: "1001774015",
currentTermId: "1488061441",
schoolShortName: "NEU",
name : "大学物理（热学、振动波、光学、近代物理）",
mode : "0",
imgUrl : "https://edu-image.nosdn.127.net/x.png?imageView&amp;thumbnail=510y288"
};
window.isSpoc = !0;
window.courseDto = {
name:"大学物理（二）",
id:"1486300165",
outLineDto: { outLine: "<p>第一周</p>" }
};
</script>`;

// 学习页（登录后）暴露的是 window.moocTermDto.id，与介绍页 currentTermId 一致。
const LEARN_PAGE_HTML = `
<script>
window.isSpoc = 1;
window.termDto = {
id:1488212467,
bigPhoto:"https://edu-image.nosdn.127.net/x.png"
};
window.moocCourseDto = {
id:1001774015,
name:"大学物理（热学、振动波、光学、近代物理）",
schoolPanel: { name: "东北大学" }
};
window.moocTermDto = {
id:1488061441
};
</script>`;

const ok = (body) => new Response(body, { status: 200 });

test('extractWindowObject 截取花括号配平的 JS 对象字面量', () => {
  const object = extractWindowObject(COURSE_PAGE_HTML, 'moocCourseCardDto');
  assert.match(object, /currentTermId: "1488061441"/);
  assert.match(object, /schoolPanel|name : "大学物理/);
  assert.ok(object.startsWith('{') && object.endsWith('}'));
  assert.equal(extractWindowObject('<html></html>', 'moocTermDto'), '');
});

test('parseSpocSourceTermId 优先读公开介绍页的源课程 currentTermId', () => {
  assert.equal(parseSpocSourceTermId(COURSE_PAGE_HTML), '1488061441');
});

test('parseSpocSourceTermId 回退到学习页的 moocTermDto.id', () => {
  assert.equal(parseSpocSourceTermId(LEARN_PAGE_HTML), '1488061441');
});

test('parseSpocSourceTermId 不把路由 term（window.termDto）当成源课程', () => {
  assert.equal(
    parseSpocSourceTermId('<script>window.termDto = { id: 1488212467 };</script>'),
    ''
  );
});

test('fetchSpocSourceTermId 先请求公开介绍页，不依赖登录会话', async () => {
  const calls = [];
  const termId = await fetchSpocSourceTermId({
    cookie: 'NTESSTUDYSI=csrf123',
    schoolCourseId: 'NEU-1486300165',
    pageUrl: 'https://www.icourse163.org/spoc/learn/NEU-1486300165?tid=1488212467',
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return ok(COURSE_PAGE_HTML);
    }
  });

  assert.equal(termId, '1488061441');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.icourse163.org/spoc/course/NEU-1486300165');
  // 公开页不能带 Cookie：会话过期时带旧 Cookie 会被 302 到登出页
  assert.equal(calls[0].opts.headers.Cookie, undefined);
});

test('fetchSpocSourceTermId 在介绍页没有映射时回退到学习页', async () => {
  const calls = [];
  const termId = await fetchSpocSourceTermId({
    cookie: 'NTESSTUDYSI=csrf123',
    schoolCourseId: 'NEU-1486300165',
    pageUrl: 'https://www.icourse163.org/spoc/learn/NEU-1486300165?tid=1488212467',
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return ok(url.includes('/spoc/course/') ? '<html>no mapping</html>' : LEARN_PAGE_HTML);
    }
  });

  assert.equal(termId, '1488061441');
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      'https://www.icourse163.org/spoc/course/NEU-1486300165',
      'https://www.icourse163.org/spoc/learn/NEU-1486300165?tid=1488212467'
    ]
  );
  // 学习页需要登录会话，必须带 Cookie
  assert.match(calls[1].opts.headers.Cookie, /NTESSTUDYSI=csrf123/);
});

test('fetchSpocSourceTermId 两处都拿不到时按 4 轮尝试后报出失败原因', async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(
    () =>
      fetchSpocSourceTermId({
        cookie: 'NTESSTUDYSI=csrf123',
        schoolCourseId: 'NEU-1',
        pageUrl: 'https://www.icourse163.org/spoc/learn/NEU-1?tid=1',
        fetchImpl: async () => {
          calls++;
          return ok('<html></html>');
        },
        sleepImpl: async (ms) => {
          delays.push(ms);
        }
      }),
    /未找到源课程 termId/
  );
  assert.equal(calls, 8);
  assert.deepEqual(delays, [3000, 3000, 3000]);
});

test('fetchSpocSourceTermId 失败后重试并成功', async () => {
  let calls = 0;
  const termId = await fetchSpocSourceTermId({
    cookie: 'NTESSTUDYSI=csrf123',
    schoolCourseId: 'NEU-1486300165',
    pageUrl: 'https://www.icourse163.org/spoc/learn/NEU-1486300165?tid=1488212467',
    fetchImpl: async (url) => {
      calls++;
      if (calls <= 2) return new Response('err', { status: 500 });
      return ok(url.includes('/spoc/course/') ? COURSE_PAGE_HTML : LEARN_PAGE_HTML);
    },
    sleepImpl: async () => {}
  });
  assert.equal(termId, '1488061441');
  assert.equal(calls, 3);
});

test('fetchSpocSourceTermId 为请求设置超时信号', async () => {
  let signal;
  await fetchSpocSourceTermId({
    cookie: 'NTESSTUDYSI=csrf123',
    schoolCourseId: 'NEU-1486300165',
    fetchImpl: async (url, opts) => {
      signal = opts.signal;
      return ok(COURSE_PAGE_HTML);
    }
  });
  assert.ok(signal instanceof AbortSignal);
});
