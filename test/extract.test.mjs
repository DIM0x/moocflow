import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCsrf } from '../src/icourse163.mjs';
import { extractItems, isDone, collectDueEvents, kindLabel, formatBeijing, formatRemaining } from '../src/extract.mjs';

const NOW = Date.now();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** 构造一个迷你 mocTermDto：1 章 1 课 3 个单元 + 章节层挂 1 个考试 */
function makeDto() {
  return {
    name: '测试课程',
    chapters: [
      {
        id: 'ch1',
        name: '第一章',
        lessons: [
          {
            id: 'le1',
            name: '1.1 单元',
            units: [
              // 未做且 24h 后截止的测验（3 次机会用了 0 次）
              {
                id: 'u1',
                name: '第一周测验',
                contentType: 2,
                test: { id: 't1', type: 2, deadline: NOW + 24 * HOUR, trytime: 3, usedTryCount: 0 }
              },
              // 已提交、互评中、互评 48h 后结束的作业
              {
                id: 'u2',
                name: '第一周作业',
                contentType: 3,
                test: {
                  id: 't2', type: 3, deadline: NOW - 1 * HOUR, usedTryCount: 1,
                  enableEvaluation: 1, evaluateEnd: NOW + 48 * HOUR, scorePubStatus: 0
                }
              },
              // 已完成（有成绩）的作业
              {
                id: 'u3',
                name: '第二周作业',
                contentType: 3,
                test: { id: 't3', type: 3, deadline: NOW + 2 * DAY, usedTryCount: 1, userScore: 90, totalScore: 100 }
              }
            ]
          }
        ],
        quizs: [
          // 章节层挂的、已过截止 3 天但未完成的测验（应进 overdue）
          { id: 'q1', name: '章节小测', contentType: 2, test: { id: 'tq1', type: 2, deadline: NOW - 3 * DAY, trytime: 1, usedTryCount: 0 } }
        ]
      }
    ]
  };
}

const course = { schoolCourseId: 'NEU-1002822009', termId: '1488060444', name: '概率论与数理统计' };

test('extractCsrf 从完整 Cookie 串取 NTESSTUDYSI', () => {
  const cookie = 'a=1; NTESSTUDYSI=abc123def; b=2';
  assert.equal(extractCsrf(cookie), 'abc123def');
  assert.equal(extractCsrf('no-cookie'), '');
});

test('extractItems 提取全部条目并跳过 test 子对象', () => {
  const items = extractItems(makeDto(), course);
  // u1, u2, u3, q1 —— test 子对象不重复成条目
  assert.equal(items.length, 4);
  const u1 = items.find((i) => i.id === 'u1');
  assert.equal(u1.type, 'quiz');
  assert.equal(u1.chapter, '第一章');
  assert.equal(u1.lesson, '1.1 单元');
  assert.equal(u1.courseName, '概率论与数理统计');
  assert.ok(u1.url.includes('NEU-1002822009') && u1.url.includes('tid=1488060444'));
});

test('isDone / done 标记：有成绩或作业已提交算完成；测验剩余次数不算', () => {
  const items = extractItems(makeDto(), course);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId.u1.done, false); // 测验 0/3 次
  assert.equal(byId.u2.done, true); // 作业已提交
  assert.equal(byId.u3.done, true); // 有成绩
  assert.equal(byId.q1.done, false); // 测验 0/1 次
  assert.ok(isDone({ type: 'quiz', score: 0, trytime: 2, usedTryCount: 2 }));
});

test('collectDueEvents 窗口分类：即将截止 + 互评 + 已过期', () => {
  const items = extractItems(makeDto(), course);
  const { due, overdue } = collectDueEvents(items, { now: NOW, windowHours: 72, overdueDays: 7 });
  const keys = due.map((e) => `${e.item.id}:${e.kind}`).sort();
  // u1 提交截止 + u2 互评截止；u3 已完成不提醒；u2 已提交，其提交截止过期无需提醒
  assert.deepEqual(keys, ['u1:submit', 'u2:peerreview']);
  assert.deepEqual(overdue.map((e) => `${e.item.id}:${e.kind}`).sort(), ['q1:submit']);
});

test('collectDueEvents 过期超出 overdueDays 的不再提醒', () => {
  const items = extractItems(makeDto(), course);
  const { overdue } = collectDueEvents(items, { now: NOW, windowHours: 72, overdueDays: 1 });
  // q1 已过 3 天 > 1 天，不再进 overdue；u2 已提交不产生提交截止提醒
  assert.deepEqual(overdue.map((e) => `${e.item.id}:${e.kind}`).sort(), []);
});

test('collectDueEvents 缺少时间窗参数时报错', () => {
  assert.throws(() => collectDueEvents([]), /windowHours/);
});

test('kindLabel 文案', () => {
  assert.equal(kindLabel('submit'), '提交截止');
  assert.equal(kindLabel('peerreview'), '互评截止');
});

test('成绩字段宽容扫描：mark/fullMark 等别名与 userScore 等价', () => {
  const dto = {
    chapters: [
      {
        lessons: [
          {
            units: [
              // 成绩存在 mark 而非 userScore（字段漂移场景）
              { id: 'm1', name: '别名成绩作业', contentType: 3, test: { id: 'tm1', type: 3, deadline: NOW + DAY, mark: 88 } },
              // 总分存在 fullMark
              { id: 'm2', name: '别名总分作业', contentType: 3, test: { id: 'tm2', type: 3, deadline: NOW + DAY, userScore: 0, fullMark: 100 } }
            ]
          }
        ]
      }
    ]
  };
  const items = extractItems(dto, course);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId.m1.score, 88);
  assert.equal(byId.m1.done, true); // mark 里的成绩同样视为已完成
  assert.equal(byId.m2.totalScore, 100);
  assert.equal(byId.m2.done, false); // 0 分不算完成
});

test('formatBeijing 输出北京时间 YYYY-MM-DD HH:mm', () => {
  // 2026-11-03T23:59:00+08:00 = epoch ms
  const ms = Date.UTC(2026, 10, 3, 15, 59, 0); // UTC 15:59 = 北京 23:59
  assert.equal(formatBeijing(ms), '2026-11-03 23:59');
});

test('formatRemaining 不出现 60 分进位瑕疵', () => {
  const now = Date.now();
  // 距截止 23 小时 59 分 30 秒：向下取整应为 23 小时 59 分
  assert.equal(formatRemaining(now + (23 * 60 + 59.5) * 60000, now), '剩余 23 小时 59 分');
  assert.equal(formatRemaining(now + 90 * 60000, now), '剩余 1 小时 30 分');
  assert.equal(formatRemaining(now + 30 * 60000, now), '剩余 30 分钟');
  assert.equal(formatRemaining(now - 60000, now), '已截止');
});
