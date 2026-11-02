/**
 * 提醒文档（reminders.json）的构造。
 *
 * 检测与发送解耦的约定格式：scripts/check.mjs 检测完成后把需要提醒的事件
 * 序列化成这个文档；scripts/notify.mjs（或其他未来的提醒渠道脚本）只消费
 * 该文档，不接触课程拉取与解析逻辑。新增提醒渠道时只需再写一个消费方。
 */

export const REMINDER_DOC_VERSION = 1;

/**
 * @param {object} opts
 * @param {number} opts.windowHours
 * @param {number} opts.overdueDays
 * @param {number} opts.coursesTotal
 * @param {number} opts.coursesOk
 * @param {string[]} opts.failures   每门失败课程的错误描述
 * @param {Array<{item:object, kind:string, dueMs:number}>} opts.due     即将截止
 * @param {Array<{item:object, kind:string, dueMs:number}>} opts.overdue 已过期未完成
 * @param {number} [opts.now]
 */
export function buildReminderDoc({ windowHours, overdueDays, coursesTotal, coursesOk, failures, due, overdue, now = Date.now() }) {
  return {
    version: REMINDER_DOC_VERSION,
    generatedAt: new Date(now).toISOString(),
    windowHours,
    overdueDays,
    summary: {
      coursesTotal,
      coursesOk,
      coursesFailed: failures.length,
      failures,
      due: due.length,
      overdue: overdue.length
    },
    events: [
      ...overdue.map((ev) => flatEvent(ev, 'overdue')),
      ...due.map((ev) => flatEvent(ev, 'due'))
    ]
  };
}

function flatEvent(ev, status) {
  return {
    status, // "due" | "overdue"
    kind: ev.kind, // "submit" | "peerreview"
    dueMs: ev.dueMs,
    item: ev.item
  };
}
