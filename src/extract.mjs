/**
 * 从 getLastLearnedMocTermDto 返回的 mocTermDto 中提取作业/测验/考试条目，
 * 并按「提交截止」「互评截止」生成需要提醒的事件。
 *
 * 解析规则参考了扩展项目 MOOC_reminder 的 extractHomeworkFromTermDto：
 * DTO 结构为 chapters[] → lessons[] → units[]，章节层还可能直接挂 homeworks[]/quizs[]/exam；
 * 每个条目自身带 contentType（2=测验 3=作业 6=考试；2026-10 新版学习页的考试为 4），
 * 详细信息在 node.test 子对象里，新版考试的截止/提交次数还可能只在 parts[] 子卷上。
 * 字段名可能漂移，因此处处取宽容解析，绝不因单个节点异常中断。
 */

// 4=考试：2026-11-04 实测 NEU-1001638003 新版学习页期末考试 contentType=4（参考项目 1.2.2 漏抓的正是它）
const TYPE_BY_CODE = { 2: 'quiz', 3: 'homework', 4: 'exam', 6: 'exam' };
const TYPE_LABEL = { quiz: '测验', homework: '作业', exam: '考试' };

const DEADLINE_FIELDS = ['deadline', 'endTime', 'submitEndTime', 'examEndTime', 'closeTime'];
// 与参考项目 MOOC_reminder 的 SCORE_FIELDS / TOTAL_FIELDS 对齐：字段名可能漂移，多候选宽容读取
const SCORE_FIELDS = ['mark', 'score', 'studentScore', 'finalMark', 'userScore'];
const TOTAL_FIELDS = ['totalMark', 'totalScore', 'fullMark', 'allMark'];

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 宽容取数字：字符串数字也算，<=0 / 非数字返回 0。 */
function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v > 0 ? v : 0;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  return 0;
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export function classifyType(node, test) {
  const raw = String(node.contentType ?? test?.type ?? node.type ?? '');
  if (TYPE_BY_CODE[raw]) return TYPE_BY_CODE[raw];
  const n = String(node.name || '');
  if (/期末|考试|exam/i.test(n)) return 'exam';
  if (/测验|测试|quiz/i.test(n)) return 'quiz';
  return 'homework';
}

function pickDeadline(node, test) {
  for (const obj of [test, node]) {
    if (!isObj(obj)) continue;
    for (const f of DEADLINE_FIELDS) {
      const v = num(obj[f]);
      if (v > 0) return v;
    }
  }
  return pickFromParts(node, DEADLINE_FIELDS);
}

/** 按候选字段列表取第一个正数（node 优先于 test，参考项目同序）。 */
function pickNumber(node, test, fields) {
  for (const obj of [node, test]) {
    if (!isObj(obj)) continue;
    for (const f of fields) {
      const v = num(obj[f]);
      if (v > 0) return v;
    }
  }
  return pickFromParts(node, fields);
}

/**
 * parts[] 子卷兜底（对齐 MOOC_reminder 1.2.2）：2026-10 新版学习页的考试把
 * 截止/成绩/提交次数放在 parts 子卷上，本体与 test 都没有。parts 是同一场
 * 考试的子卷元数据而非独立条目，因此只在前面字段全部缺失时兜底读取。
 */
function pickFromParts(node, fields) {
  if (!Array.isArray(node.parts)) return 0;
  for (const part of node.parts) {
    if (!isObj(part)) continue;
    for (const f of fields) {
      const v = num(part[f]);
      if (v > 0) return v;
    }
  }
  return 0;
}

/**
 * 判断条目是否已完成。
 * - 有成绩（userScore>0）→ 完成
 * - 作业/考试（type 3/6）：usedTryCount>0 即已提交 → 完成
 * - 测验（type 2）：尝试次数用尽，或得分>0 → 完成（还剩次数且未得分则继续提醒，避免漏刷题）
 */
export function isDone(item) {
  if (item.score > 0) return true;
  if (item.type === 'quiz') {
    if (item.trytime > 0 && item.usedTryCount >= item.trytime) return true;
    return false;
  }
  return item.usedTryCount > 0;
}

/**
 * 遍历 DTO，提取全部可考核条目。
 * @param {object} dto    mocTermDto
 * @param {object} course { schoolCourseId, termId, name?, pageUrl? }
 * @returns {Array<object>} 条目列表
 */
export function extractItems(dto, course) {
  const items = [];
  const seen = new Set();
  let visited = 0;

  function pushItem(node, test, path) {
    const name = str(node.name);
    const deadlineMs = pickDeadline(node, test);
    if (!name || deadlineMs <= 0) return;

    const id = String(node.id || test?.id || name);
    if (seen.has(id)) return;
    seen.add(id);

    const type = classifyType(node, test);
    const item = {
      id,
      title: name,
      type,
      // 章名 = 路径上第一个容器；单元名 = 最后一个容器（真实 DTO 有 章→节→小节
      // 三层嵌套，中间层不显示以免文案过长）
      chapter: path[0] || '',
      lesson: path.length > 1 ? path[path.length - 1] : '',
      deadlineMs,
      score: pickNumber(node, test, SCORE_FIELDS),
      totalScore: pickNumber(node, test, TOTAL_FIELDS),
      usedTryCount: num(node.usedTryCount ?? test?.usedTryCount) || pickFromParts(node, ['usedTryCount']),
      trytime: num(node.trytime ?? test?.trytime),
      enableEvaluation: !!(node.enableEvaluation ?? test?.enableEvaluation),
      evaluateEndMs: num(node.evaluateEnd ?? test?.evaluateEnd),
      scorePubStatus: num(node.scorePubStatus ?? test?.scorePubStatus),
      courseName: str(course.name) || str(dto.courseName) || str(dto.name || dto.termName),
      url:
        course.pageUrl ||
        `https://www.icourse163.org/learn/${course.schoolCourseId}?tid=${course.termId}`
    };
    item.done = isDone(item);
    items.push(item);
  }

  // path：从根到当前节点的容器名链（不可变传参，各分支互不污染）
  function visit(node, path) {
    if (!node || visited > 20000) return;
    visited++;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, path);
      return;
    }
    if (!isObj(node)) return;

    // 容器节点（章/节/小节）把自己的名字追加到路径上
    if (Array.isArray(node.lessons) || Array.isArray(node.units)) {
      const name = str(node.name);
      if (name) path = [...path, name];
    }

    const test = isObj(node.test) ? node.test : null;
    const assessedCode = ['2', '3', '4', '6'].includes(String(node.contentType ?? ''));
    const nameLooksAssessed = /测验|作业|考试|测试|quiz|exam|homework/i.test(str(node.name));
    if (assessedCode || nameLooksAssessed || test) {
      pushItem(node, test, path);
    }

    // 继续递归；test 是本节点自己的元数据（带 name/deadline，会被当成重复条目），跳过
    for (const [key, v] of Object.entries(node)) {
      if (key === 'test') continue;
      if (isObj(v) || Array.isArray(v)) {
        visit(v, path);
      } else if (typeof v === 'string' && v.length > 50 && (v[0] === '{' || v[0] === '[')) {
        // 内嵌 JSON 字符串字段（jsonContent 等）
        try {
          visit(JSON.parse(v), path);
        } catch {
          /* 容忍解析失败 */
        }
      }
    }
  }

  visit(dto, []);
  return items;
}

const KIND_LABEL = { submit: '提交截止', peerreview: '互评截止' };

export function kindLabel(kind) {
  return KIND_LABEL[kind] || kind;
}

/**
 * 按时间窗筛出需要提醒的事件。
 * 每个条目最多产生两类事件：提交截止（deadline）与互评截止（evaluateEnd，仅启用互评的作业）。
 * @param {Array<object>} items
 * @param {object} opts { now?, windowHours, overdueDays } —— windowHours/overdueDays 必填
 * @returns {{ due: Array, overdue: Array }}
 */
export function collectDueEvents(items, { now = Date.now(), windowHours, overdueDays } = {}) {
  if (!Number.isFinite(windowHours) || !Number.isFinite(overdueDays)) {
    throw new Error('collectDueEvents 需要有效的 windowHours / overdueDays');
  }
  const windowMs = windowHours * 3600 * 1000;
  const overdueMs = overdueDays * 24 * 3600 * 1000;
  const due = [];
  const overdue = [];

  for (const item of items) {
    // 互评窗口已出成绩的，整个条目都不用再提醒
    const peerReviewSettled = item.enableEvaluation && item.scorePubStatus === 2;

    if (!item.done && !peerReviewSettled) {
      if (item.deadlineMs > now && item.deadlineMs - now <= windowMs) {
        due.push({ item, kind: 'submit', dueMs: item.deadlineMs });
      } else if (item.deadlineMs <= now && now - item.deadlineMs <= overdueMs) {
        overdue.push({ item, kind: 'submit', dueMs: item.deadlineMs });
      }
    }

    // 互评截止：只看启用互评的作业，且提交过才算有互评义务
    if (item.type === 'homework' && item.enableEvaluation && item.usedTryCount > 0) {
      if (item.scorePubStatus === 2) continue; // 已公布成绩，互评流程已结束
      if (item.evaluateEndMs > now && item.evaluateEndMs - now <= windowMs) {
        due.push({ item, kind: 'peerreview', dueMs: item.evaluateEndMs });
      } else if (item.evaluateEndMs <= now && now - item.evaluateEndMs <= overdueMs) {
        overdue.push({ item, kind: 'peerreview', dueMs: item.evaluateEndMs });
      }
    }
  }

  due.sort((a, b) => a.dueMs - b.dueMs);
  overdue.sort((a, b) => a.dueMs - b.dueMs);
  return { due, overdue };
}

const BEIJING_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

/** epoch ms → 北京时间 "YYYY-MM-DD HH:mm" */
export function formatBeijing(ms) {
  if (!ms || ms <= 0) return '';
  // zh-CN 输出形如 "2026/11/03 23:59"，规范化为连字符格式
  const parts = BEIJING_FMT.formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 剩余时间的可读描述 */
export function formatRemaining(dueMs, now = Date.now()) {
  const diff = dueMs - now;
  if (diff <= 0) return '已截止';
  const totalMin = Math.floor(diff / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `剩余 ${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  if (h >= 1) return `剩余 ${h} 小时 ${m} 分`;
  return `剩余 ${m} 分钟`;
}
