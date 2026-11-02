/**
 * 通过 GitHub REST API 更新仓库 Actions Secret。
 *
 * 需要一枚 Fine-grained PAT，至少具有目标仓库的
 * "Secrets: Read and write" 权限。默认更新 MOOC_COOKIE。
 * PAT 只从环境变量传入，不写入日志。
 */

import sodium from 'libsodium-wrappers';

const API_BASE = 'https://api.github.com';

export class GitHubSecretError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitHubSecretError';
  }
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'moocflow'
  };
}

async function errorDetail(res) {
  try {
    const text = await res.text();
    return text ? `：${text.slice(0, 300)}` : '';
  } catch {
    return '';
  }
}

export async function updateGitHubSecret({
  token,
  repo,
  name,
  value,
  fetchImpl = fetch,
  apiBase = API_BASE
} = {}) {
  if (!token) throw new GitHubSecretError('缺少 PAT（MOOC_REFRESH_PAT）');
  const parts = String(repo || '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GitHubSecretError('GITHUB_REPOSITORY 必须形如 owner/repo');
  }
  if (!name) throw new GitHubSecretError('缺少 Secret 名称');
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitHubSecretError('拒绝写入空的 Cookie 值');
  }

  const [owner, repository] = parts;
  const keyUrl = `${apiBase}/repos/${owner}/${repository}/actions/secrets/public-key`;
  const keyRes = await fetchImpl(keyUrl, { headers: authHeaders(token) });
  if (!keyRes.ok) {
    throw new GitHubSecretError(
      `获取仓库公钥失败：HTTP ${keyRes.status}${await errorDetail(keyRes)}`
    );
  }
  const keyData = await keyRes.json();
  if (!keyData || !keyData.key_id || !keyData.key) {
    throw new GitHubSecretError('仓库公钥响应缺少 key_id/key');
  }

  await sodium.ready;
  const publicKey = sodium.from_base64(keyData.key, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), publicKey);
  const encryptedValue = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

  const secretUrl = `${apiBase}/repos/${owner}/${repository}/actions/secrets/${encodeURIComponent(name)}`;
  const putRes = await fetchImpl(secretUrl, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyData.key_id })
  });
  if (!putRes.ok) {
    throw new GitHubSecretError(
      `更新 Secret ${name} 失败：HTTP ${putRes.status}${await errorDetail(putRes)}`
    );
  }

  return { name, keyId: keyData.key_id };
}
