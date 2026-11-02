import { test } from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import { updateGitHubSecret, GitHubSecretError } from '../src/github-secret.mjs';

test('updateGitHubSecret 用公钥加密并 PUT 到仓库 Secret', async () => {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const publicKeyB64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  let putBody = null;

  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/actions/secrets/public-key')) {
      assert.equal(init.headers.Authorization, 'Bearer test-pat');
      return new Response(JSON.stringify({ key_id: 'key-id-1', key: publicKeyB64 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url.endsWith('/actions/secrets/MOOC_COOKIE')) {
      assert.equal(init.method, 'PUT');
      assert.equal(init.headers.Authorization, 'Bearer test-pat');
      putBody = JSON.parse(init.body);
      return new Response(null, { status: 201 });
    }
    throw new Error('unexpected url ' + url);
  };

  const value = 'WM_TID=abc; STUDY_SESS=new; STUDY_PERSIST=new';
  const result = await updateGitHubSecret({
    token: 'test-pat',
    repo: 'owner/repo',
    name: 'MOOC_COOKIE',
    value,
    fetchImpl
  });

  assert.equal(result.name, 'MOOC_COOKIE');
  assert.equal(putBody.key_id, 'key-id-1');
  const cipher = sodium.from_base64(putBody.encrypted_value, sodium.base64_variants.ORIGINAL);
  const plain = sodium.crypto_box_seal_open(cipher, kp.publicKey, kp.privateKey);
  assert.equal(sodium.to_string(plain), value);
});

test('updateGitHubSecret 缺少 PAT / repo / name 时拒绝', async () => {
  await assert.rejects(() => updateGitHubSecret({ repo: 'o/r', name: 'S', value: 'v' }), GitHubSecretError);
  await assert.rejects(() => updateGitHubSecret({ token: 't', name: 'S', value: 'v' }), GitHubSecretError);
  await assert.rejects(() => updateGitHubSecret({ token: 't', repo: 'bad', name: 'S', value: 'v' }), GitHubSecretError);
  await assert.rejects(() => updateGitHubSecret({ token: 't', repo: 'o/r', value: 'v' }), GitHubSecretError);
});
