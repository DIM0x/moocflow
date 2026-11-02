#!/usr/bin/env node
/**
 * 步骤一（检测）：读取课程配置 → 逐课拉取解析 → 把需要提醒的事件写入约定文件。
 * 不负责任何提醒的发送；发送见 scripts/notify.mjs。
 *
 * 课程配置（MOOC_COURSES_FILE，默认 courses.txt）：每行一个课程 URL，运行时
 * 解析为 courses.json 等价结构；.json 结尾的文件仍按旧 JSON 格式读取。
 *
 * 环境变量：
 *   MOOC_COOKIE             完整浏览器 Cookie 串（必须；自动刷新需要其中的 STUDY_PERSIST）
 *   COOKIE_REFRESH_MODE     Cookie 更新方式：0=不刷新（默认）；1=刷新但只在本次运行使用；
 *                           2=刷新并用 PAT 覆盖保存到 GitHub Secret
 *   MOOC_REFRESH_PAT        模式 2 必填：Fine-grained PAT，需目标仓库 Secrets 读写权限
 *   MOOC_COOKIE_SECRET_NAME 模式 2 可覆盖的 Secret 名（默认 MOOC_COOKIE）
 *   MOOC_COURSES_FILE       课程配置路径（默认 courses.txt，可参考 courses.example.txt）
 *   DUE_WINDOW_HOURS        即将截止窗口（小时，默认 72）
 *   OVERDUE_DAYS            已过期但仍在提醒范围的天数（默认 7）
 *   REMINDERS_FILE          提醒文档输出路径（默认 reminders.json）
 *
 * 退出码：0 = 正常（含无提醒、部分课程失败）；1 = 全部课程失败或无 Cookie 等硬错误。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchTermDto, AuthExpiredError } from '../src/icourse163.mjs';
import { refreshCookie } from '../src/cookie.mjs';
import { updateGitHubSecret } from '../src/github-secret.mjs';
import { extractItems, collectDueEvents, kindLabel, formatBeijing, formatRemaining } from '../src/extract.mjs';
import { buildReminderDoc } from '../src/report.mjs';
import { parseCourses } from '../src/courses.mjs';

const env = process.env;
const windowHours = Number(env.DUE_WINDOW_HOURS || 72);
const overdueDays = Number(env.OVERDUE_DAYS || 7);
const remindersFile = resolve(env.REMINDERS_FILE || 'reminders.json');
const refreshModeRaw = env.COOKIE_REFRESH_MODE;
const refreshMode = refreshModeRaw === undefined || refreshModeRaw === '' ? 0 : Number(refreshModeRaw);
const cookieSecretName = env.MOOC_COOKIE_SECRET_NAME || 'MOOC_COOKIE';

function loadCourses() {
  const file = resolve(env.MOOC_COURSES_FILE || 'courses.txt');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    console.error(`[moocflow] 找不到课程配置 ${file}，请参考 courses.example.txt 创建（每行一个课程 URL）`);
    process.exit(1);
  }
  try {
    return parseCourses(file, raw);
  } catch (e) {
    console.error(`[moocflow] 课程配置解析失败：${e.message}`);
    process.exit(1);
  }
}

function logEvent(ev, tag) {
  const it = ev.item;
  const loc = [it.chapter, it.lesson].filter(Boolean).join(' / ');
  console.log(
    `  ${tag} [${it.courseName}] ${loc ? loc + ' · ' : ''}${it.title}（${it.type}）` +
      ` ${kindLabel(ev.kind)} ${formatBeijing(ev.dueMs)}（${formatRemaining(ev.dueMs)}）`
  );
}

async function fetchCourses(cookie, courses) {
  const allItems = [];
  let okCourses = 0;
  let attempted = 0;
  let authExpiredFailures = 0;
  const failures = [];

  for (const course of courses) {
    const label = course.name || course.schoolCourseId || course.termId;
    if (!course.termId) {
      failures.push(`${label}: 缺少 termId`);
      console.error(`[moocflow]   跳过 ${label}：缺少 termId`);
      continue;
    }
    attempted++;
    try {
      console.log(`[moocflow] 拉取课程 ${label}（termId=${course.termId}）…`);
      const dto = await fetchTermDto({ cookie, termId: course.termId });
      const items = extractItems(dto, course);
      console.log(`[moocflow]   解析到 ${items.length} 个条目`);
      allItems.push(...items);
      okCourses++;
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
      if (e instanceof AuthExpiredError) authExpiredFailures++;
      console.error(`[moocflow]   失败：${e.message}`);
    }
  }

  return { allItems, okCourses, failures, attempted, authExpiredFailures };
}

async function main() {
  const courses = loadCourses();
  const cookie = env.MOOC_COOKIE;
  if (!cookie) {
    console.error('[moocflow] 未设置 MOOC_COOKIE 环境变量');
    process.exit(1);
  }
  if (![0, 1, 2].includes(refreshMode)) {
    console.error(`[moocflow] COOKIE_REFRESH_MODE 只能是 0/1/2（当前：${refreshModeRaw}）`);
    process.exit(1);
  }
  if (refreshMode === 2) {
    if (!env.MOOC_REFRESH_PAT) {
      console.error('[moocflow] COOKIE_REFRESH_MODE=2 需要配置 MOOC_REFRESH_PAT（Fine-grained PAT）');
      process.exit(1);
    }
    if (!env.GITHUB_REPOSITORY) {
      console.error('[moocflow] COOKIE_REFRESH_MODE=2 需要 GITHUB_REPOSITORY（owner/repo）');
      process.exit(1);
    }
  }

  console.log(`[moocflow] Cookie 刷新模式：${refreshMode}`);

  let result = await fetchCourses(cookie, courses);
  const allAuthFailed =
    result.okCourses === 0 &&
    result.attempted > 0 &&
    result.authExpiredFailures === result.attempted;

  if (allAuthFailed) {
    if (refreshMode === 0) {
      console.error('[moocflow] 检测到 Cookie 失效；COOKIE_REFRESH_MODE=0，不自动刷新，请手动更新 MOOC_COOKIE');
    } else {
      console.error(`[moocflow] 检测到 Cookie 失效，尝试自动刷新（COOKIE_REFRESH_MODE=${refreshMode}）…`);
      try {
        const refreshed = await refreshCookie({ cookie });
        console.error('[moocflow] Cookie 刷新成功，使用新 Cookie 重试课程…');
        if (refreshMode === 2) {
          const updated = await updateGitHubSecret({
            token: env.MOOC_REFRESH_PAT,
            repo: env.GITHUB_REPOSITORY,
            name: cookieSecretName,
            value: refreshed.cookie
          });
          console.error(`[moocflow] 新 Cookie 已写入 GitHub Secret：${updated.name}`);
        } else {
          console.error('[moocflow] 模式 1：新 Cookie 仅本次运行使用，不写回 Secret');
        }
        result = await fetchCourses(refreshed.cookie, courses);
      } catch (e) {
        console.error(`[moocflow] Cookie 自动刷新失败：${e.message}`);
        process.exit(1);
      }
    }
  }

  const { allItems, okCourses, failures } = result;

  const now = Date.now();
  const { due, overdue } = collectDueEvents(allItems, { now, windowHours, overdueDays });

  console.log(`\n[moocflow] ${courses.length} 门课程，成功 ${okCourses} 门，失败 ${failures.length} 门`);
  for (const f of failures) console.error(`[moocflow] 失败详情：${f}`);
  console.log(`[moocflow] 即将截止 ${due.length} 项 / 已过期未完成 ${overdue.length} 项\n`);
  for (const ev of overdue) logEvent(ev, '⚠已过期');
  for (const ev of due) logEvent(ev, '🔔即将截止');

  if (failures.length > 0 && okCourses === 0) {
    console.error('[moocflow] 所有课程均拉取失败，按错误处理');
    process.exit(1);
  }

  // 产出提醒文档，供后续发送步骤消费
  const doc = buildReminderDoc({
    windowHours,
    overdueDays,
    coursesTotal: courses.length,
    coursesOk: okCourses,
    failures,
    due,
    overdue,
    now
  });
  writeFileSync(remindersFile, JSON.stringify(doc, null, 2));
  console.log(`[moocflow] 提醒文档已写入 ${remindersFile}（due=${due.length} overdue=${overdue.length}）`);
}

main().catch((e) => {
  console.error('[moocflow] 未捕获异常：', e);
  process.exit(1);
});
