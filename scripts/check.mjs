#!/usr/bin/env node
/**
 * 步骤一（检测）：读取课程配置 → 逐课拉取解析 → 把需要提醒的事件写入约定文件。
 * 不负责任何提醒的发送；发送见 scripts/notify.mjs。
 *
 * 课程配置（MOOC_COURSES）：直接写课程 URL，多门用分号或换行分隔。
 *
 * 环境变量（默认值统一定义在 src/config.mjs 的 DEFAULTS 中）：
 *   MOOC_COOKIE             完整浏览器 Cookie 串（必须；自动刷新需要其中的 STUDY_PERSIST）
 *   COOKIE_REFRESH_MODE     Cookie 更新方式：0=不刷新；1=刷新但只在本次运行使用；
 *                           2=刷新并用 PAT 覆盖保存到 GitHub Secret
 *   MOOC_REFRESH_PAT        模式 2 必填：Fine-grained PAT，需目标仓库 Secrets 读写权限
 *   MOOC_COOKIE_SECRET_NAME 模式 2 可覆盖的 Secret 名
 *   MOOC_COURSES            课程列表（必填；仓库 Variable 或本地环境变量），多门用分号或换行分隔
 *   DUE_WINDOW_HOURS        即将截止窗口（小时）
 *   OVERDUE_DAYS            已过期但仍在提醒范围的天数
 *   REMINDERS_FILE          提醒文档输出路径
 *
 * 退出码：0 = 正常（含无提醒、部分课程失败）；1 = 全部课程失败或无 Cookie 等硬错误。
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchTermDto, fetchSpocSourceTermId, AuthExpiredError } from '../src/icourse163.mjs';
import { refreshCookie } from '../src/cookie.mjs';
import { updateGitHubSecret } from '../src/github-secret.mjs';
import { extractItems, collectDueEvents, kindLabel, formatBeijing, formatRemaining } from '../src/extract.mjs';
import { buildReminderDoc } from '../src/report.mjs';
import { parseCoursesInline } from '../src/courses.mjs';
import { resolveDetectionConfig } from '../src/config.mjs';

const env = process.env;

function loadConfig() {
  try {
    return resolveDetectionConfig(env);
  } catch (e) {
    console.error(`[moocflow] ${e.message}`);
    process.exit(1);
  }
}

function loadCourses(coursesText) {
  try {
    return parseCoursesInline(coursesText);
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

/**
 * 一门课要抓的 term 列表。
 *
 * SPOC 横跨两个互不重叠的 term：路由 term 装老师新增内容，源课程 term 装 OOC 内容。
 * 只抓路由 term 的典型症状就是「SPOC 一条任务都没有」——这门课本身没有任务，
 * 全部任务都在关联的源课程里。
 */
async function resolveTermIds(cookie, course) {
  const routeTermId = String(course.termId);
  const terms = [{ termId: routeTermId, label: '路由' }];
  if (!course.isSpoc) return terms;

  try {
    const sourceTermId = await fetchSpocSourceTermId({
      cookie,
      schoolCourseId: course.schoolCourseId,
      pageUrl: course.pageUrl
    });
    if (sourceTermId !== routeTermId) {
      terms.push({ termId: sourceTermId, label: '源课程' });
      console.log(`[moocflow]   SPOC 源课程 termId=${sourceTermId}`);
    }
  } catch (e) {
    console.warn(
      `[moocflow]   SPOC 未发现关联源课程（独立 SPOC 属正常），仅抓取路由 term：${e.message}`
    );
  }
  return terms;
}

async function fetchCourseItems(cookie, course) {
  const terms = await resolveTermIds(cookie, course);
  const items = [];
  const seen = new Set();
  const errors = [];
  let courseName = course.name || '';
  let okTerms = 0;

  for (const term of terms) {
    try {
      const dto = await fetchTermDto({ cookie, termId: term.termId });
      if (!courseName) {
        const name = [dto.courseName, dto.name, dto.termName].find(
          (v) => typeof v === 'string' && v.trim()
        );
        if (name) courseName = name.trim();
      }
      const extracted = extractItems(dto, { ...course, termId: term.termId, name: courseName });
      let added = 0;
      for (const item of extracted) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
        added++;
      }
      okTerms++;
      if (terms.length > 1) {
        console.log(
          `[moocflow]   ${term.label} term（${term.termId}）解析到 ${extracted.length} 个条目，新增 ${added} 个`
        );
      }
    } catch (e) {
      errors.push(e);
      console.error(`[moocflow]   ${term.label} term（${term.termId}）失败：${e.message}`);
    }
  }

  if (okTerms === 0) {
    if (errors.every((e) => e instanceof AuthExpiredError)) {
      throw new AuthExpiredError(errors.map((e) => e.message).join('；'));
    }
    throw new Error(errors.map((e) => e.message).join('；') || '没有可抓取的 term');
  }
  return items;
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
      const items = await fetchCourseItems(cookie, course);
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
  const { windowHours, overdueDays, refreshMode, cookieSecretName, coursesText, remindersFile } = loadConfig();
  const reminderPath = resolve(remindersFile);
  if (!coursesText) {
    console.error('[moocflow] 未设置 MOOC_COURSES 环境变量（仓库 Variable）');
    process.exit(1);
  }
  const courses = loadCourses(coursesText);
  const cookie = env.MOOC_COOKIE;
  if (!cookie) {
    console.error('[moocflow] 未设置 MOOC_COOKIE 环境变量');
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
  let cookieRefresh = null;
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
        cookieRefresh = { mode: refreshMode };
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
    cookieRefresh,
    now
  });
  writeFileSync(reminderPath, JSON.stringify(doc, null, 2));
  console.log(`[moocflow] 提醒文档已写入 ${reminderPath}（due=${due.length} overdue=${overdue.length}）`);
}

main().catch((e) => {
  console.error('[moocflow] 未捕获异常：', e);
  process.exit(1);
});
