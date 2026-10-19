/**
 * 本地代理的 API / 安全回归测试。
 *
 * 前置：mock 与代理服务已在运行，例如
 *   node test/mock-upstream.mjs
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:8940 DEEPSEEK_API_KEY=test PORT=8899 npm start
 *
 * 运行：BASE_URL=http://127.0.0.1:8899 node test/server-check.mjs
 */
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8899').replace(/\/+$/, '');
const results = [];

function assert(condition, label, details = '') {
  results.push(Boolean(condition));
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || !details ? '' : ` — ${details}`}`);
}

async function request(path, { method = 'GET', headers = {}, body, rawUrl } = {}) {
  const url = rawUrl || `${BASE_URL}${path}`;
  const response = await fetch(url, { method, headers, body, redirect: 'manual' });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { response, status: response.status, text, json, headers: response.headers };
}

async function main() {
  /* --- status --- */
  let res = await request('/api/status');
  assert(res.status === 200, 'GET /api/status 200');
  assert(res.json?.ok === true, 'status.ok = true');
  assert(!JSON.stringify(res.json || {}).includes('sk-'), 'status 不泄露 API Key');
  const configured = Boolean(res.json?.configured);
  const keySource = res.json?.keySource;

  /* 如果服务端还没配置 Key，先完成 Key 路由的负向测试，再写入临时会话 Key 以便测试搜索链路。 */
  let temporarySessionKey = false;
  if (!configured && keySource !== 'environment') {
    res = await request('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ apiKey: 'sk-server-check-key-123' }),
    });
    assert(res.status === 415, '/api/key 非 JSON Content-Type 返回 415');

    res = await request('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'short' }),
    });
    assert(res.status === 400, '过短的 Key 返回 400');

    res = await request('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-server-check-key-123' }),
    });
    assert(res.status === 200 && res.json?.configured === true, '会话 Key 保存成功');
    assert(!JSON.stringify(res.json || {}).includes('sk-server-check-key-123'), '保存响应不回显 Key');
    temporarySessionKey = true;
  }

  /* --- search 正常路径 --- */
  res = await request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'DeepSeek', count: 3 }),
  });
  assert(res.status === 200, 'POST /api/search 200');
  assert(Array.isArray(res.json?.results), 'search 返回 results 数组');
  assert((res.json?.results?.length || 0) === 3, 'search 遵守 count=3');
  assert(String(res.headers.get('content-type') || '').includes('application/json'), 'search Content-Type 为 JSON');

  /* --- search 参数校验 --- */
  res = await request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '   ' }),
  });
  assert(res.status === 400, '空 query 返回 400');

  res = await request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'x', count: 51 }),
  });
  assert(res.status === 400, 'count=51 返回 400');

  res = await request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ query: 'x', count: 1 }),
  });
  assert(res.status === 415, 'search 非 JSON Content-Type 返回 415');

  res = await request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'x'.repeat(70000), count: 1 }),
  });
  assert(res.status === 413, '超过 64 KB 的请求体返回 413（响应可读）', `实际 ${res.status}`);
  assert(res.json?.error?.code === 'invalid_request', '413 带 JSON 错误体');

  /* --- 上游错误透传（由 mock 提供） --- */
  res = await request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '__empty' }),
  });
  assert(res.status === 200 && Array.isArray(res.json?.results) && res.json.results.length === 0, '空结果透传');

  res = await request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '__error401' }),
  });
  assert(res.status === 401, '上游 401 透传');
  assert(res.json?.error?.type === 'authentication_error', '401 错误类型正确');

  res = await request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '__error429' }),
  });
  assert(res.status === 429, '上游 429 透传');

  /* --- 405 语义 --- */
  res = await request('/api/search');
  assert(res.status === 405, 'GET /api/search 返回 405');
  assert(res.json?.error?.type === 'invalid_request_error' && res.json?.error?.code === 'method_not_allowed', '405 错误类型为 method_not_allowed');

  /* --- key 流程（根据服务端是否已有环境变量 Key 分支） --- */
  if (keySource === 'environment') {
    res = await request('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-server-check-key-123' }),
    });
    assert(res.status === 409, '环境变量 Key 模式下保存 Key 返回 409');
  } else {
    res = await request('/api/key', { method: 'DELETE' });
    assert(res.status === 200 && res.json?.configured === false, '会话 Key 清除成功');
    temporarySessionKey = false;
  }

  if (temporarySessionKey) {
    await request('/api/key', { method: 'DELETE' });
  }

  /* --- 静态文件安全 --- */
  for (const path of [
    '/assets/..%2fserver.mjs',
    '/assets/%2e%2e%2f.env',
    '/assets/%2e%2e%2fREADME.md',
    '/server.mjs',
    '/.env',
  ]) {
    res = await request(path, { rawUrl: `${BASE_URL}${path}` }).catch(() => null);
    assert(res?.status === 404, `静态路径被拒绝：${path}`, res ? `实际 ${res.status}` : '请求失败');
  }

  res = await request('/assets/app.js');
  assert(res.status === 200, '正常静态资源可访问');
  assert(res.headers.get('cache-control') === 'no-cache', '静态资源使用 no-cache');
  assert(String(res.headers.get('content-type') || '').includes('javascript'), 'JS Content-Type 正确');

  /* --- Host / Origin 防护 --- */
  res = await request('/api/status', {
    headers: { Origin: 'http://evil.example' },
  });
  assert(res.status === 403, '跨站 Origin 被拒绝');

  try {
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const url = new URL(`${BASE_URL}/api/status`);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: '/api/status',
          headers: { Host: 'evil.example' },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert(status === 403, '伪造 Host 被拒绝');
  } catch (error) {
    assert(false, '伪造 Host 测试', error.message);
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 项通过`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
