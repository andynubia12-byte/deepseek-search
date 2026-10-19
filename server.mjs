#!/usr/bin/env node
/**
 * DeepSeek 搜索 · 本地演示服务
 *
 * - 托管 index.html / assets 静态文件
 * - 将 /api/search 转发到 DeepSeek Search API（POST /v1/tools/search）
 * - API Key 只保存在服务端：优先读取 DEEPSEEK_API_KEY / .env，也可以在网页设置中
 *   写入进程内存（重启即失效，不落盘）。
 *
 * 零依赖，Node.js >= 20.12。
 */
import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 可选 .env（不覆盖已存在的环境变量）
try {
  process.loadEnvFile?.(path.join(ROOT, '.env'));
} catch {
  /* 没有 .env 也没关系 */
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const ENV_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const STARTED_AT = Date.now();

const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 25_000;
// DeepSeek Search API 限速 5 QPS，这里在客户端侧留出余量，避免连续操作触发 429。
const MIN_UPSTREAM_GAP_MS = 220;

/** @type {string} 通过网页设置写入的密钥，仅存在内存中 */
let sessionKey = '';
let nextUpstreamAt = 0;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' https: http: data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

class HttpError extends Error {
  constructor(status, message, type = 'invalid_request_error', code = 'invalid_request') {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function apiError(message, type = 'server_error', code = 'internal_error') {
  return { error: { message, type, param: null, code } };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled && size > MAX_BODY_BYTES) {
        // 超限后继续消费剩余数据，让外层可以正常写回 413，避免连接被重置。
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        fail(new HttpError(413, '请求体超过大小限制（最大 64 KB）。'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, '请求体必须是一个 JSON 对象。'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, '请求体不是有效的 JSON。'));
      }
    });
    req.on('error', (err) => fail(err));
  });
}

function assertJsonContentType(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, '请求必须使用 application/json。', 'invalid_request_error', 'unsupported_media_type');
  }
}

/** 只允许本机页面访问 API，降低 DNS rebinding / 跨站滥用的风险。 */
function assertLocalRequest(req) {
  const host = req.headers.host;
  if (!host) throw new HttpError(403, '缺少 Host 请求头。', 'forbidden', 'forbidden_host');
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    throw new HttpError(403, '非法的 Host 请求头。', 'forbidden', 'forbidden_host');
  }
  const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', HOST.toLowerCase()]);
  if (!allowed.has(hostname)) {
    throw new HttpError(403, '该接口仅允许从本机访问。', 'forbidden', 'forbidden_host');
  }

  // 额外校验 Origin，阻止其它本地端口/跨站页面直接调用 API（CORS 预检之外的双保险）。
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      throw new HttpError(403, '非法的 Origin 请求头。', 'forbidden', 'forbidden_origin');
    }
    if (originHost !== String(host).toLowerCase()) {
      throw new HttpError(403, '跨站请求被拒绝。', 'forbidden', 'forbidden_origin');
    }
  }
}

function countCodePoints(text) {
  return Array.from(text).length;
}

async function waitForUpstreamSlot() {
  const now = Date.now();
  const target = Math.max(now, nextUpstreamAt);
  nextUpstreamAt = target + MIN_UPSTREAM_GAP_MS;
  if (target > now) {
    await new Promise((resolve) => setTimeout(resolve, target - now));
  }
}

function upstreamHost() {
  try {
    return new URL(BASE_URL).host;
  } catch {
    return BASE_URL;
  }
}

function statusPayload() {
  const configured = Boolean(ENV_KEY || sessionKey);
  return {
    ok: true,
    configured,
    keySource: ENV_KEY ? 'environment' : sessionKey ? 'session' : null,
    upstreamHost: upstreamHost(),
    limits: { maxCount: 50, defaultCount: 10, qps: 5 },
    version: '1.0.0',
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
  };
}

async function handleStatus(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, apiError('该接口仅支持 GET。', 'invalid_request_error', 'method_not_allowed'), { Allow: 'GET' });
  }
  assertLocalRequest(req);
  sendJson(res, 200, statusPayload());
}

async function handleKey(req, res) {
  assertLocalRequest(req);
  if (req.method === 'POST') {
    if (ENV_KEY) {
      throw new HttpError(
        409,
        '当前 API Key 由环境变量 DEEPSEEK_API_KEY 提供。如需更换，请修改环境变量或 .env 后重启服务。',
        'conflict',
        'key_from_environment',
      );
    }
    assertJsonContentType(req);
    const body = await readJsonBody(req);
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey) throw new HttpError(400, '请填写 API Key。');
    if (apiKey.length < 8 || apiKey.length > 256 || /\s/.test(apiKey)) {
      throw new HttpError(400, 'API Key 格式不正确（长度需为 8–256 个字符，且不能包含空白）。');
    }
    sessionKey = apiKey;
    nextUpstreamAt = 0;
    console.log('[deepseek-search] 已从网页设置保存 API Key（仅内存，重启失效）');
    return sendJson(res, 200, { ok: true, ...statusPayload() });
  }

  if (req.method === 'DELETE') {
    if (ENV_KEY) {
      throw new HttpError(409, '当前 API Key 由环境变量提供，无法在网页中清除。', 'conflict', 'key_from_environment');
    }
    sessionKey = '';
    console.log('[deepseek-search] 已清除内存中的 API Key');
    return sendJson(res, 200, { ok: true, ...statusPayload() });
  }

  return sendJson(res, 405, apiError('该接口仅支持 POST 或 DELETE。', 'invalid_request_error', 'method_not_allowed'), { Allow: 'POST, DELETE' });
}

function validateSearchBody(body) {
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) throw new HttpError(400, "'query' 不能为空。");
  if (countCodePoints(query) > 128) throw new HttpError(400, "'query' 不能超过 128 个 Unicode 字符。");

  let count = 10;
  if (body.count !== undefined && body.count !== null) {
    if (!Number.isInteger(body.count) || body.count < 1 || body.count > 50) {
      throw new HttpError(400, "'count' 必须是 1～50 之间的整数。");
    }
    count = body.count;
  }

  const payload = {
    query,
    count,
    need_content: body.need_content === true,
  };

  if (typeof body.ori_question === 'string' && body.ori_question.trim()) {
    const ori = body.ori_question.trim();
    if (countCodePoints(ori) > 128) throw new HttpError(400, "'ori_question' 不能超过 128 个字符。");
    payload.ori_question = ori;
  }

  if (typeof body.localization === 'string' && body.localization.trim()) {
    payload.localization = body.localization.trim().slice(0, 64);
  }

  return payload;
}

async function handleSearch(req, res) {
  assertLocalRequest(req);
  if (req.method !== 'POST') {
    return sendJson(res, 405, apiError('该接口仅支持 POST。', 'invalid_request_error', 'method_not_allowed'), { Allow: 'POST' });
  }

  assertJsonContentType(req);

  const body = await readJsonBody(req);
  const payload = validateSearchBody(body);

  const apiKey = ENV_KEY || sessionKey;
  if (!apiKey) {
    throw new HttpError(
      401,
      '尚未配置 DeepSeek API Key。请在页面右上角「设置」中填写，或使用 DEEPSEEK_API_KEY 环境变量启动服务。',
      'authentication_error',
      'missing_api_key',
    );
  }

  await waitForUpstreamSlot();

  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(`${BASE_URL}/v1/tools/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'deepseek-search-demo/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new HttpError(504, '上游搜索服务响应超时，请稍后重试。', 'timeout_error', 'upstream_timeout');
    }
    const cause = err?.cause?.code || err?.cause?.message || err?.message || '网络错误';
    throw new HttpError(
      502,
      `无法连接 DeepSeek 搜索服务（${cause}）。请检查网络后重试。`,
      'api_error',
      'upstream_unreachable',
    );
  } finally {
    clearTimeout(timer);
  }

  const rawText = await upstreamResponse.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = null;
  }

  if (!upstreamResponse.ok) {
    const upstreamMessage = data?.error?.message;
    const status = upstreamResponse.status;
    const fallback =
      status === 401
        ? 'DeepSeek API Key 无效或已过期，请检查后重试。'
        : status === 402
          ? 'DeepSeek 账户余额不足，请充值后重试。'
          : status === 429
            ? '请求过于频繁（Search API 限制 5 QPS），请稍后重试。'
            : `上游搜索服务返回 HTTP ${status}。`;
    throw new HttpError(
      status,
      upstreamMessage || fallback,
      data?.error?.type || (status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'api_error'),
      data?.error?.code || 'upstream_error',
    );
  }

  if (!data || !Array.isArray(data.results)) {
    throw new HttpError(502, '上游返回了无法识别的数据格式。', 'api_error', 'invalid_upstream_response');
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  sendJson(res, 200, data, {
    'X-Search-Elapsed-Ms': String(elapsedMs),
    'Server-Timing': `search;dur=${elapsedMs}`,
  });
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }

  if (decoded === '/' || decoded === '') decoded = '/index.html';
  if (decoded.includes('\0')) return sendText(res, 404, 'Not Found');

  // 先规范化再检查白名单，避免 /assets/..%2fserver.mjs 这类编码穿越。
  const normalized = path.posix.normalize(decoded);

  // 只暴露页面入口与 assets，避免把 server.mjs、.env 等源文件当作静态资源送出。
  const allowed = normalized === '/index.html' || normalized.startsWith('/assets/');
  if (!allowed) return sendText(res, 404, 'Not Found');

  const filePath = path.resolve(ROOT, `.${normalized}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) return sendText(res, 404, 'Not Found');

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return sendText(res, 404, 'Not Found');
  }
  if (!info.isFile()) return sendText(res, 404, 'Not Found');

  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  };
  if (ext === '.html') headers['Content-Security-Policy'] = CSP;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  let pathname = '/';
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    pathname = url.pathname;

    if (pathname === '/api/status') {
      await handleStatus(req, res);
    } else if (pathname === '/api/key') {
      await handleKey(req, res);
    } else if (pathname === '/api/search') {
      await handleSearch(req, res);
    } else if (pathname.startsWith('/api/')) {
      sendJson(res, 404, apiError('接口不存在。', 'invalid_request_error', 'not_found'));
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message =
      err instanceof HttpError ? err.message : '本地服务遇到了意外错误，请查看服务端日志。';
    const type = err instanceof HttpError ? err.type : 'server_error';
    const code = err instanceof HttpError ? err.code : 'internal_error';

    if (pathname.startsWith('/api/')) {
      if (!res.headersSent) sendJson(res, status, apiError(message, type, code));
    } else if (!res.headersSent) {
      sendText(res, status, message);
    } else {
      res.destroy();
    }

    if (status >= 500) {
      console.error(`[deepseek-search] ${req.method} ${pathname} -> ${status}:`, err?.cause || err?.message || err);
    }
  } finally {
    if (pathname.startsWith('/api/')) {
      console.log(
        `[deepseek-search] ${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - startedAt}ms)`,
      );
    }
  }
});

server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。可以用 PORT=8788 npm start 换一个端口。\n`);
  } else {
    console.error('服务启动失败：', err);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
  console.log('');
  console.log('  DeepSeek 搜索 · 本地演示服务');
  console.log(`  ➜  ${url}`);
  if (ENV_KEY) {
    console.log('  ✓ 已从环境变量读取 DEEPSEEK_API_KEY');
  } else {
    console.log('  ⚠ 尚未配置 API Key：可在网页「设置」中填写，或在 .env 中设置 DEEPSEEK_API_KEY');
  }
  console.log(`  · 上游：${BASE_URL}`);
  console.log('');
});

function shutdown(signal) {
  console.log(`\n[deepseek-search] 收到 ${signal}，正在关闭服务…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
