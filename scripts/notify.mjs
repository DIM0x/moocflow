#!/usr/bin/env node
/**
 * 步骤二（发送）：读取检测步骤产出的提醒文档（reminders.json），按所选渠道发送。
 * 只消费约定文档并分发到渠道模块，不接触课程拉取与解析——
 * 渠道实现在 src/channels/<方式名>.mjs，用 NOTIFY_CHANNEL 切换（默认 github）。
 *
 * 环境变量：
 *   REMINDERS_FILE    提醒文档路径（默认 reminders.json，与检测步骤一致）
 *   NOTIFY_CHANNEL    通知方式：github（默认，向 issue 追加评论）/ mail（SMTP 邮件）
 *   github 渠道：GITHUB_TOKEN / GITHUB_REPOSITORY（Actions 自动提供）、
 *               REMINDER_ISSUE_NUMBER（用户手动创建的提醒 issue 编号）
 *   mail 渠道：SMTP_* / NOTIFY_TO，见 src/channels/mail.mjs
 *
 * 退出码：0 = 正常（含无提醒、渠道未配置时的打印降级）；1 = 文档缺失/损坏、
 *         方式名未知或渠道发送失败。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectChannel } from '../src/channels/index.mjs';

const env = process.env;
const remindersFile = resolve(env.REMINDERS_FILE || 'reminders.json');

function main() {
  let doc;
  try {
    doc = JSON.parse(readFileSync(remindersFile, 'utf8'));
  } catch (e) {
    console.error(`[moocflow] 无法读取提醒文档 ${remindersFile}：${e.message}`);
    process.exit(1);
  }
  const events = Array.isArray(doc.events) ? doc.events : [];
  if (events.length === 0) {
    console.log('[moocflow] 提醒文档中无待提醒事件，跳过发送');
    return;
  }

  let channel;
  try {
    channel = selectChannel(env.NOTIFY_CHANNEL);
  } catch (e) {
    console.error(`[moocflow] ${e.message}`);
    process.exit(1);
  }
  console.log(`[moocflow] 通知方式：${channel.name}；即将截止 ${events.filter((ev) => ev.status === 'due').length} 项 / 已过期 ${events.filter((ev) => ev.status === 'overdue').length} 项`);

  channel
    .deliver(doc, env, Date.now())
    .then((res) => {
      if (res.sent) {
        console.log(`[moocflow] ${channel.name} 渠道发送成功：${res.detail}`);
      } else {
        console.log(`[moocflow] ${channel.name} 渠道未配置（${res.detail}），仅打印提醒内容：\n`);
        console.log(channel.renderPreview(doc, Date.now()));
      }
    })
    .catch((e) => {
      // 发送失败要可见：内容降级打印到日志，同时让该 step 失败
      console.error(`[moocflow] ${channel.name} 渠道发送失败：${e.message}`);
      console.log(channel.renderPreview(doc, Date.now()));
      process.exit(1);
    });
}

main();
