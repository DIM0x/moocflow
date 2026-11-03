/**
 * Cookie Secret 写回的能力接口（COOKIE_REFRESH_MODE=2）。
 *
 * 「刷新 Cookie 后写回仓库 Secret」是平台相关能力：目前只有 GitHub 提供
 * Actions Secret 的写回 API。scripts/check.mjs 面向本接口编程，不直接依赖
 * 具体实现；未来为其他平台接入时在此注册对应实现，或明确声明不支持。
 *
 * 选择方式：COOKIE_SECRET_STORE（默认 github，与 NOTIFY_CHANNEL 同为
 * 显式配置、不做平台探测）。
 */

import { updateGitHubSecret } from './github-secret.mjs';
import { resolveRepoSlug } from './repo-env.mjs';

const DEFAULT_STORE = 'github';

const STORES = {
  github: {
    name: 'github',
    label: 'GitHub Secret',
    /** 模式 2 的启动校验；不满足时返回 { ok:false, reason }，reason 文案含模式说明。 */
    validate(env) {
      if (!env.MOOC_REFRESH_PAT) {
        return {
          ok: false,
          reason: 'COOKIE_REFRESH_MODE=2 需要配置 MOOC_REFRESH_PAT（Fine-grained PAT）'
        };
      }
      if (!resolveRepoSlug(env)) {
        return { ok: false, reason: 'COOKIE_REFRESH_MODE=2 需要 GITHUB_REPOSITORY（owner/repo）' };
      }
      return { ok: true };
    },
    /** 把新 Cookie 加密写回仓库 Secret。 */
    write(env, { name, value }) {
      return updateGitHubSecret({
        token: env.MOOC_REFRESH_PAT,
        repo: resolveRepoSlug(env),
        name,
        value
      });
    }
  }
};

/** 按 COOKIE_SECRET_STORE 选择写回实现；未设置或留空回退默认，未知取值抛错。 */
export function selectSecretStore(env = process.env) {
  const raw = env.COOKIE_SECRET_STORE;
  const key =
    raw == null || String(raw).trim() === '' ? DEFAULT_STORE : String(raw).trim().toLowerCase();
  const store = STORES[key];
  if (!store) {
    throw new Error(
      `未知 Cookie Secret 存储方式 "${raw}"（COOKIE_SECRET_STORE）。可用方式：${Object.keys(STORES).join(', ')}`
    );
  }
  return store;
}
