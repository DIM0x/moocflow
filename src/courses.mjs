/**
 * 课程配置解析。
 *
 * 用户配置 courses.txt：每行一个课程 URL（三种学习路由都认），运行时解析成
 * courses.json 等价的结构供检测代码使用；.json 结尾的路径仍按旧 JSON 格式读取。
 *
 * parseLearnHref / isContentDetailHref 移植自参考项目 MOOC_reminder
 * （src/shared/icourse163-api.js，同名函数），包括三个实战结论：
 * 1. 课程 key 永远是 `learn/` 之后那一段，一个正则覆盖 /learn/{key}、
 *    /mooc/learn/{key}[/{section}]（2026-10 新路由）、/spoc/learn/{key} 三种路由；
 * 2. isSpoc 只看 /spoc/ 前缀；
 * 3. 内容详情链接（论坛帖等）带 tid 但不是课程链接，必须排除——否则会登记出
 *    「课程名叫帖子标题」的幽灵课程（参考项目 2026-09-23 真实 DOM 踩坑记录）。
 */

const LEARN_ROUTE_RE = /\/(?:spoc\/)?learn\/([^/?#]+)/i;

/** 链接指向课程内部的某条具体内容（帖子/条目详情），而不是课程本身。 */
export function isContentDetailHref(href) {
  const fragment = String(href || '').split('#')[1] || '';
  return /forum|detail/i.test(fragment);
}

/**
 * 解析课程链接为规范身份。
 * @param {string} href 课程页 URL（相对/绝对、带不带 hash 均可）
 * @returns {{schoolCourseId: string, termId: string, isSpoc: boolean} | null}
 */
export function parseLearnHref(href) {
  if (!href || typeof href !== 'string') return null;
  const m = href.match(LEARN_ROUTE_RE);
  if (!m) return null;
  let schoolCourseId;
  try {
    schoolCourseId = decodeURIComponent(m[1]);
  } catch {
    schoolCourseId = m[1];
  }
  // 必须形如 {school}-{id}；裸段（如 /learn/explore）是导航噪音
  if (!/^[^-\s]+-[^-\s]+/.test(schoolCourseId)) return null;
  const tidMatch = href.match(/[?&]tid=(\d+)/);
  if (!tidMatch) return null;
  if (isContentDetailHref(href)) return null;
  return {
    schoolCourseId,
    termId: tidMatch[1],
    isSpoc: /\/spoc\/learn\//i.test(href)
  };
}

/**
 * 由课程链接构造 courses 条目（courses.json 等价结构）。
 * name 可选：DTO 解析时会以课程真实名兜底（extractItems 的 courseName 逻辑）。
 * @param {string} href
 * @param {string} [name]
 * @returns {object | null}
 */
export function toCourseEntry(href, name) {
  const meta = parseLearnHref(href);
  if (!meta) return null;
  const origin = 'https://www.icourse163.org';
  const prefix = meta.isSpoc ? '/spoc/learn/' : '/learn/';
  return {
    ...(name ? { name } : {}),
    schoolCourseId: meta.schoolCourseId,
    termId: meta.termId,
    isSpoc: meta.isSpoc,
    // 规范页 URL：丢掉原链接的 hash/section，保证三条路由归一到同一 URL
    pageUrl: `${origin}${prefix}${meta.schoolCourseId}?tid=${meta.termId}`
  };
}

/**
 * 解析 courses.txt 行式配置。
 * 规则：每行一个课程 URL；空行与 # 开头的整行注释跳过；
 * URL 后可用空格加 "# 名称" 给课程命名（URL 内部的 #/learn/... hash 不受影响，
 * 因为只有「空白后紧跟 #」才被视为注释分隔）。
 * @param {string} text
 * @returns {{courses: object[], warnings: string[]}}
 */
export function parseCoursesFile(text) {
  const courses = [];
  const warnings = [];
  const seen = new Set();

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // 「URL # 名称」：按空白切分，第二个 token 以 # 开头才算命名注释
    const parts = line.split(/\s+/);
    const href = parts[0];
    const name =
      parts.length >= 2 && parts[1].startsWith('#')
        ? parts.slice(1).join(' ').replace(/^#\s*/, '').trim() || undefined
        : undefined;

    const entry = toCourseEntry(href, name);
    if (!entry) {
      warnings.push(`无法识别的课程链接（已跳过）：${line}`);
      continue;
    }
    const key = `${entry.schoolCourseId}|${entry.termId}`;
    if (seen.has(key)) {
      warnings.push(`重复课程已忽略：${key}`);
      continue;
    }
    seen.add(key);
    courses.push(entry);
  }
  return { courses, warnings };
}

/**
 * 加载课程配置。.json 走旧 JSON 格式，其余按行式文本解析。
 * @param {string} file 配置文件路径
 * @param {string} raw  文件内容（调用方已读入）
 * @returns {object[]} courses
 */
export function parseCourses(file, raw) {
  if (String(file).endsWith('.json')) {
    const cfg = JSON.parse(raw);
    const courses = Array.isArray(cfg) ? cfg : cfg.courses;
    if (!Array.isArray(courses)) {
      throw new Error(`${file} 的 JSON 结构应是 {"courses":[...]} 或课程数组`);
    }
    return courses;
  }
  const { courses, warnings } = parseCoursesFile(raw);
  for (const w of warnings) console.warn(`[moocflow] ${w}`);
  if (courses.length === 0) {
    throw new Error(`${file} 中没有可识别的课程链接（每行一个课程 URL，# 开头为注释）`);
  }
  return courses;
}
