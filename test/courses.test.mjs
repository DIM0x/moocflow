import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLearnHref,
  isContentDetailHref,
  toCourseEntry,
  parseCoursesFile,
  parseCourses
} from '../src/courses.mjs';

// ── parseLearnHref（用例移植自参考项目 MOOC_reminder tests/unit/icourse163-api.test.mjs）──

test('parseLearnHref 从旧路由学习链接提取规范身份', () => {
  assert.deepEqual(parseLearnHref('/learn/BIT-268001?tid=1460270441#/learn/content'), {
    schoolCourseId: 'BIT-268001',
    termId: '1460270441',
    isSpoc: false
  });
});

test('parseLearnHref 处理绝对 SPOC 链接', () => {
  const meta = parseLearnHref('https://www.icourse163.org/spoc/learn/ZJU-2?tid=42#/learn/quiz');
  assert.equal(meta.schoolCourseId, 'ZJU-2');
  assert.equal(meta.termId, '42');
  assert.equal(meta.isSpoc, true);
});

test('parseLearnHref 处理 2026-10 /mooc/learn/ 新路由（可带 section）', () => {
  assert.deepEqual(
    parseLearnHref('https://www.icourse163.org/mooc/learn/BIT-268001?tid=1460270441#/learn/testlist'),
    { schoolCourseId: 'BIT-268001', termId: '1460270441', isSpoc: false }
  );
  assert.deepEqual(
    parseLearnHref('/mooc/learn/BIT-268001/assessments?tid=1460270441'),
    { schoolCourseId: 'BIT-268001', termId: '1460270441', isSpoc: false }
  );
});

test('parseLearnHref 拒绝非课程链接和缺 tid 的链接', () => {
  assert.equal(parseLearnHref('/about.htm'), null);
  assert.equal(parseLearnHref('/learn/explore'), null); // 无横线无 tid
  assert.equal(parseLearnHref('/learn/BIT-268001'), null); // 无 tid
  assert.equal(parseLearnHref(''), null);
  assert.equal(parseLearnHref(null), null);
});

test('parseLearnHref 拒绝课程内容详情链接（论坛帖等）', () => {
  // 2026-09-23 真实踩坑：首页「最近发表」的帖子链接带 tid，采进来会变成
  // 名字=帖子标题的幽灵课程
  assert.equal(
    parseLearnHref('https://www.icourse163.org/learn/NEU-1474956162?tid=1476735472#/learn/forumdetail?pid=1353455440'),
    null
  );
  assert.equal(parseLearnHref('/learn/BIT-268001?tid=1460270441#/learn/forum?cid=1'), null);
  // 课程级路由不受影响
  assert.ok(parseLearnHref('/learn/BIT-268001?tid=1460270441#/learn/content'));
  assert.ok(parseLearnHref('/learn/BIT-268001?tid=1460270441'));
});

test('isContentDetailHref 按 hash 片段判定', () => {
  assert.equal(isContentDetailHref('https://x.org/learn/A-1?tid=2#/learn/forumdetail?pid=3'), true);
  assert.equal(isContentDetailHref('https://x.org/learn/A-1?tid=2#/learn/content'), false);
});

// ── toCourseEntry ──

test('toCourseEntry 构造规范条目并归一 pageUrl', () => {
  const entry = toCourseEntry('https://www.icourse163.org/mooc/learn/NEU-1002822009/assessments?tid=1488060444#/learn/testlist', '概率论');
  assert.deepEqual(entry, {
    name: '概率论',
    schoolCourseId: 'NEU-1002822009',
    termId: '1488060444',
    isSpoc: false,
    pageUrl: 'https://www.icourse163.org/learn/NEU-1002822009?tid=1488060444'
  });
  const spoc = toCourseEntry('https://www.icourse163.org/spoc/learn/ZJU-2?tid=42');
  assert.equal(spoc.pageUrl, 'https://www.icourse163.org/spoc/learn/ZJU-2?tid=42');
  assert.equal(spoc.name, undefined); // 未命名时不应出现 name 字段
  assert.equal(toCourseEntry('/learn/explore'), null);
});

// ── parseCoursesFile 行式配置 ──

test('parseCoursesFile：注释、空行、命名后缀、hash 内的 # 不误判', () => {
  const text = [
    '# 全行注释',
    '',
    'https://www.icourse163.org/learn/NEU-1002822009?tid=1488060444 # 概率论与数理统计',
    'https://www.icourse163.org/learn/BIT-268001?tid=1460270441#/learn/content',
    '  https://www.icourse163.org/spoc/learn/ZJU-2?tid=42   #  SPOC 物理课 '
  ].join('\n');
  const { courses, warnings } = parseCoursesFile(text);
  assert.equal(courses.length, 3);
  assert.equal(courses[0].name, '概率论与数理统计');
  assert.equal(courses[1].name, undefined);
  assert.equal(courses[1].schoolCourseId, 'BIT-268001'); // URL hash 未被当注释截断
  assert.equal(courses[2].isSpoc, true);
  assert.equal(courses[2].name, 'SPOC 物理课');
  assert.deepEqual(warnings, []);
});

test('parseCoursesFile：坏行给 warning、重复课程去重、全坏时报不出课程', () => {
  const text = [
    'https://www.icourse163.org/learn/NEU-1002822009?tid=1488060444',
    '/learn/explore',
    'https://www.icourse163.org/learn/NEU-1002822009/assessments?tid=1488060444#/learn/testlist'
  ].join('\n');
  const { courses, warnings } = parseCoursesFile(text);
  assert.equal(courses.length, 1); // 新旧路由同课去重
  assert.equal(warnings.length, 2); // 坏行 warning + 重复课程 warning
  assert.match(warnings[0], /无法识别/);
  assert.match(warnings[1], /重复/);
  assert.deepEqual(parseCoursesFile('garbage-line').courses, []);
});

// ── parseCourses 分发 ──

test('parseCourses：.json 走旧格式，.txt 走行式，空课程报错', () => {
  const courses = parseCourses('courses.json', '{"courses":[{"schoolCourseId":"A-1","termId":"2"}]}');
  assert.equal(courses.length, 1);
  assert.equal(parseCourses('courses.txt', 'https://www.icourse163.org/learn/A-1?tid=2').length, 1);
  assert.throws(() => parseCourses('courses.txt', '# 只有注释'), /没有可识别的课程链接/);
  assert.throws(() => parseCourses('courses.json', '{"foo":1}'), /JSON 结构/);
  assert.throws(() => parseCourses('courses.json', '{bad json'), SyntaxError);
});
