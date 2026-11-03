/**
 * 仓库坐标与凭证的环境变量解析（平台无关）。
 *
 * 优先级：平台原生变量（GITHUB_TOKEN 等）> 通用别名（REPO_TOKEN 等）。
 * 各平台的 CI 文件既可以用自家变量，也可以统一配置通用别名，渠道与
 * Secret 写回逻辑无需感知平台差异。
 *
 * 口径与 src/config.mjs 一致：值为空串或纯空白按"未设置"处理
 * （Actions 的 Variable 未设置时环境变量通常是空串）。
 */

function firstDefined(env, names) {
  for (const name of names) {
    const raw = env[name];
    if (raw != null && String(raw).trim() !== '') return String(raw).trim();
  }
  return undefined;
}

/** 访问仓库 API 的令牌：GITHUB_TOKEN（平台原生）或 REPO_TOKEN（通用别名）。 */
export function resolveRepoToken(env = process.env) {
  return firstDefined(env, ['GITHUB_TOKEN', 'REPO_TOKEN']);
}

/** 仓库全名（"owner/repo"）：GITHUB_REPOSITORY（平台原生）或 REPO_SLUG（通用别名）。 */
export function resolveRepoSlug(env = process.env) {
  return firstDefined(env, ['GITHUB_REPOSITORY', 'REPO_SLUG']);
}
