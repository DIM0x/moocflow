import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReminderDoc, REMINDER_DOC_VERSION } from '../src/report.mjs';

const item = {
  id: 'u1',
  title: '第一周测验',
  type: 'quiz',
  chapter: '第一章',
  lesson: '1.1 单元',
  courseName: '测试课程',
  url: 'https://www.icourse163.org/learn/NEU-1002822009?tid=1488060444'
};

test('buildReminderDoc 产出约定结构，事件扁平化并带状态', () => {
  const doc = buildReminderDoc({
    windowHours: 72,
    overdueDays: 7,
    coursesTotal: 2,
    coursesOk: 1,
    failures: ['另一门课: HTTP 500'],
    due: [{ item, kind: 'submit', dueMs: 1000 }],
    overdue: [{ item, kind: 'peerreview', dueMs: 500 }],
    now: 0
  });

  assert.equal(doc.version, REMINDER_DOC_VERSION);
  assert.equal(doc.generatedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(doc.windowHours, 72);
  assert.deepEqual(doc.summary, {
    coursesTotal: 2,
    coursesOk: 1,
    coursesFailed: 1,
    failures: ['另一门课: HTTP 500'],
    due: 1,
    overdue: 1
  });
  // overdue 在前、due 在后；每个事件带 status/kind/dueMs/item 四个字段
  assert.deepEqual(
    doc.events.map((e) => `${e.status}:${e.kind}`),
    ['overdue:peerreview', 'due:submit']
  );
  assert.deepEqual(Object.keys(doc.events[0]).sort(), ['dueMs', 'item', 'kind', 'status']);
  assert.equal(doc.events[0].item.title, '第一周测验');
});

test('buildReminderDoc 仅在触发自动刷新时写入 cookieRefresh', () => {
  const base = {
    windowHours: 72, overdueDays: 7, coursesTotal: 1, coursesOk: 1, failures: [], due: [], overdue: [], now: 5
  };
  assert.equal('cookieRefresh' in buildReminderDoc(base), false);
  assert.deepEqual(buildReminderDoc({ ...base, cookieRefresh: { mode: 2 } }).cookieRefresh, { mode: 2 });
});

test('buildReminderDoc 空事件也能产出有效文档', () => {
  const doc = buildReminderDoc({
    windowHours: 72, overdueDays: 7, coursesTotal: 1, coursesOk: 1, failures: [], due: [], overdue: [], now: 5
  });
  assert.deepEqual(doc.events, []);
  assert.equal(doc.summary.due, 0);
});
