/**
 * 通知渠道注册表。渠道切换：NOTIFY_CHANNEL=github（默认，见 src/config.mjs）/ mail。
 * 新增渠道：在 src/channels/ 下新建 <名字>.mjs 实现统一契约（见 mail.mjs 头注释），
 * 再在下面 import + 注册一行即可，scripts/notify.mjs 与检测逻辑零改动。
 */

import * as mail from './mail.mjs';
import * as github from './github.mjs';
import { DEFAULTS } from '../config.mjs';

const CHANNELS = { mail, github };

export const DEFAULT_CHANNEL = DEFAULTS.notifyChannel;

export function availableChannels() {
  return Object.keys(CHANNELS);
}

/**
 * 按方式名取渠道模块；不指定时默认 github。
 * @param {string|undefined} mode
 */
export function selectChannel(mode) {
  // 空串与未指定同样视为默认渠道
  const key = String(mode ?? '').trim().toLowerCase() || DEFAULT_CHANNEL;
  const channel = CHANNELS[key];
  if (!channel) {
    throw new Error(
      `未知通知方式 "${mode}"（NOTIFY_CHANNEL）。可用方式：${availableChannels().join(', ')}，默认 ${DEFAULT_CHANNEL}`
    );
  }
  return channel;
}
