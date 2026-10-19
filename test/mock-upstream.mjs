/**
 * 仅供本地 UI 联调的 DeepSeek Search API 模拟上游。
 *
 *   node test/mock-upstream.mjs
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:8940 DEEPSEEK_API_KEY=test npm start
 *
 * 支持的特殊查询：
 *   __empty      返回空数组
 *   __error401   返回 401
 *   __error429   返回 429
 *   __slow       延迟 2.5 秒，用于观察骨架屏
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8940);

const RESULTS = [
  {
    rerank_score: 2.91,
    title: '网页搜索与抓取 - DeepSeek API 文档',
    url: 'https://api-docs.deepseek.com/zh-cn/guides/search',
    snippet:
      'Search 接口按 query 搜索网页，返回结构化结果；Fetch 接口抓取单个网页并以 Markdown 返回正文。两者均使用 Bearer 鉴权，按成功请求计费。',
    summary:
      'Search 接口由 DeepSeek 自研搜索引擎提供支持，返回 title、url、snippet、summary、content、site_name、date、authority 等字段。单次最多返回 50 条结果，账号级 QPS 限制为 5。Fetch 接口用于抓取单个网页，返回 Markdown 正文。',
    content:
      '# 网页搜索与抓取\n\nSearch 接口和 Fetch 接口为 Agent 与 RAG 应用提供实时网页内容。\n\n## Search 接口\n\nPOST https://api.deepseek.com/v1/tools/search\n\n- query：搜索词，1～128 个 Unicode 字符\n- count：返回条数，1～50\n- need_content：是否返回网页正文\n\n## Fetch 接口\n\nPOST https://api.deepseek.com/v1/tools/fetch\n\n抓取单个网页并以 Markdown 文本返回页面内容。',
    site_name: 'DeepSeek API Docs',
    site_icon: null,
    date: '2026-10-17T02:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 2.74,
    title: 'DeepSeek 上线搜索抓取 API：自研搜索引擎、5 元 / 千次',
    url: 'https://www.deepseek.com/news/search-fetch-api',
    snippet:
      'DeepSeek 正式开放 Search 与 Fetch 两个工具接口，面向 Agent 和 RAG 场景。Search 使用自研搜索引擎，支持 site:、lang:、after: 等检索语法。',
    summary:
      'DeepSeek 宣布开放搜索与抓取 API。其中 Search 接口提供网页搜索能力，返回结构化结果和网页摘要；Fetch 接口以 Markdown 形式返回单个网页正文。两项接口均按成功请求次数计费，价格均为每 1,000 次 5 元。',
    content:
      'DeepSeek 搜索抓取 API 正式上线。Search 接口使用自研搜索引擎，支持网页搜索并返回结构化结果；Fetch 接口抓取单个网页，以 Markdown 文本返回页面内容。',
    site_name: 'DeepSeek',
    site_icon: 'https://www.deepseek.com/favicon.ico',
    date: '2026-10-16T09:30:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 2.32,
    title: 'deepseek-ai / deepseek-search-api · GitHub',
    url: 'https://github.com/deepseek-ai/deepseek-search-api',
    snippet:
      'DeepSeek Search API 的官方工具与示例代码，包含 Python、Node.js 调用方式，以及针对 Agent 工作流的最佳实践和错误处理说明。',
    summary:
      '仓库提供 DeepSeek Search API 的调用示例，覆盖请求鉴权、count 参数、need_content 选项以及 429 限速重试策略。示例包含 Python requests 与 Node.js fetch 两种实现。',
    content: '',
    site_name: 'GitHub',
    site_icon: 'https://github.com/favicon.ico',
    date: '2026-10-15T11:12:00+00:00',
    authority: 3,
  },
  {
    rerank_score: 2.18,
    title: '如何用 DeepSeek 搜索 API 搭建一个 RAG 问答机器人',
    url: 'https://sspai.com/post/101234',
    snippet:
      '从申请 API Key、封装 Search 请求，到把摘要交给模型生成答案，一步步搭建轻量 RAG 应用，并讨论结果排序与引用来源的展示方式。',
    summary:
      '文章介绍如何用 DeepSeek Search API 搭建 RAG 问答机器人：先通过 Search 接口获取结构化结果与长摘要，再将摘要作为上下文交给模型生成带引用的回答，并给出前端展示来源、时间与权威性的建议。',
    content: '',
    site_name: '少数派',
    site_icon: null,
    date: '2026-10-12T03:45:00+00:00',
    authority: 2,
  },
  {
    rerank_score: 2.05,
    title: '大模型搜索工具对比：DeepSeek Search、Tavily 与 Brave Search',
    url: 'https://www.infoq.cn/article/deepseek-search-compare',
    snippet:
      '横向对比三款搜索 API 的价格、返回字段、延迟与限速。DeepSeek 返回 rerank_score、authority 等字段，适合需要中文结果和权威性判断的场景。',
    summary:
      '对比测试覆盖搜索质量、结构化字段、中文内容覆盖、延迟和计费方式。DeepSeek Search 按成功请求计费，返回 rerank_score 与 authority 评分；文章给出了选型建议与成本估算。',
    content: '',
    site_name: 'InfoQ 中文',
    site_icon: null,
    date: '2026-10-11T08:20:00+00:00',
    authority: 3,
  },
  {
    rerank_score: 1.86,
    title: 'DeepSeek Search API 请求与响应字段速查',
    url: 'https://zhuanlan.zhihu.com/p/688123456',
    snippet:
      '整理 query、count、need_content 等请求字段，以及 title、url、snippet、summary、site_icon、authority 的响应含义，附一个可直接运行的 curl 示例。',
    summary:
      '这篇笔记整理了 DeepSeek Search API 的完整字段表：请求体支持 query、count、ori_question、localization、need_content；响应包含 rerank_score、title、url、snippet、summary、content、site_name、site_icon、date、authority。',
    content: '',
    site_name: '知乎专栏',
    site_icon: null,
    date: '2026-10-08T13:02:00+00:00',
    authority: 1,
  },
  {
    rerank_score: 1.62,
    title: 'Search & Fetch API: real-time web for agents | DeepSeek',
    url: 'https://api-docs.deepseek.com/guides/search',
    snippet:
      'Search returns structured web results powered by DeepSeek’s own search engine. Fetch retrieves a single page as Markdown. Both use Bearer auth and are billed per successful request.',
    summary:
      'The Search endpoint accepts a query, optional count, original question and need_content flag. Responses include rerank score, title, URL, snippets, summaries, page content, site metadata, dates and authority scores.',
    content: '',
    site_name: 'DeepSeek API Docs',
    site_icon: null,
    date: '2026-10-17T02:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 1.48,
    title: 'DeepSeek 开放平台 - API Keys 与用量管理',
    url: 'https://platform.deepseek.com/api_keys',
    snippet:
      '创建、管理 DeepSeek API Key，查看搜索与模型调用用量。Search 和 Fetch 共用账号级 QPS 限制，超过后返回 HTTP 429。',
    summary:
      '开放平台提供 API Key 管理、余额查询和用量统计。Search 与 Fetch 按成功请求次数计费，失败、无结果或超时不收费；账号级 QPS 限制与模型并发限制相互独立。',
    content: '',
    site_name: 'DeepSeek 开放平台',
    site_icon: null,
    date: '2026-10-10T01:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 1.31,
    title: 'A practical guide to adding web search to your agent',
    url: 'https://medium.com/@example/adding-web-search-to-agents',
    snippet:
      'A step-by-step guide on tool calling with search APIs, including result deduplication, citation formatting and handling rate limits in production agents.',
    summary:
      'This guide walks through integrating a structured search API into an agent loop: choosing result counts, using summaries as context, surfacing citations to users, and adding retries with exponential backoff for rate limits.',
    content: '',
    site_name: 'Medium',
    site_icon: null,
    date: '2026-09-28T06:40:00+00:00',
    authority: 1,
  },
  {
    rerank_score: 1.12,
    title: 'DeepSeek V4 模型发布，长上下文与工具调用能力升级',
    url: 'https://36kr.com/p/2984421234567',
    snippet:
      'DeepSeek V4 在长上下文、工具调用和代码能力上均有提升。配合新开放的搜索 API，模型可以更方便地获得实时网页信息。',
    summary:
      '报道介绍 DeepSeek V4 的能力更新，并提到全新的 Search / Fetch API 可以让智能体在推理过程中检索实时网页、获取结构化摘要，从而减少幻觉并提升答案时效性。',
    content: '',
    site_name: '36氪',
    site_icon: null,
    date: '2026-09-20T10:15:00+00:00',
    authority: 2,
  },
  {
    rerank_score: 0.88,
    title: 'deepseek-ai / DeepSeek-V4 · Hugging Face',
    url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4',
    snippet:
      'DeepSeek V4 模型卡片与权重说明，包含上下文长度、推荐推理配置以及与搜索工具配合使用的示例。',
    summary:
      '模型卡片提供 DeepSeek V4 的架构、上下文长度、评测结果和推理建议，并给出工具调用格式示例，可用于搭配 Search API 构建检索增强应用。',
    content: '',
    site_name: 'Hugging Face',
    site_icon: null,
    date: '2026-09-18T00:00:00+00:00',
    authority: 3,
  },
  {
    rerank_score: 0.54,
    title: '一个极简的 DeepSeek 搜索页面（开源）',
    url: 'https://github.com/example/deepseek-search-page',
    snippet:
      '用原生 HTML/CSS/JS 写成的 Google 风格搜索页，后端代理 DeepSeek Search API，API Key 只保存在本地服务内存中。',
    summary:
      '开源项目展示如何使用零依赖 Node.js 服务代理 DeepSeek Search API，前端提供即时搜索、建议、结果筛选和深色模式，并演示错误代码 401、402、429 的友好提示。',
    content: '',
    site_name: 'GitHub',
    site_icon: null,
    date: '2026-10-16T12:00:00+00:00',
    authority: 1,
  },
];

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== 'POST' || req.url !== '/v1/tools/search') {
    return sendJson(res, 404, { error: { message: 'not found' } });
  }

  const body = await readBody(req);
  const query = typeof body.query === 'string' ? body.query : '';
  const count = Math.min(Math.max(Number(body.count) || 10, 1), 50);
  const delay = query.includes('__slow') ? 2500 : 320;

  await new Promise((resolve) => setTimeout(resolve, delay));

  if (query.includes('__error401')) {
    return sendJson(res, 401, {
      error: { message: 'Authentication Fails (mock)', type: 'authentication_error', param: null, code: 'invalid_api_key' },
    });
  }
  if (query.includes('__error429')) {
    return sendJson(res, 429, {
      error: { message: 'Rate limit exceeded (mock)', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' },
    });
  }
  if (query.includes('__empty')) {
    return sendJson(res, 200, { results: [] });
  }
  if (query.includes('__weird')) {
    return sendJson(res, 200, {
      results: [
        {
          rerank_score: 2.4,
          title: 'X'.repeat(2004),
          url: 'https://example.com/weird-fields',
          snippet: '用于验证超长无空格字段不会撑出横向滚动条。',
          summary: 'Y'.repeat(1200),
          content: '',
          site_name: 'Z'.repeat(500),
          site_icon: null,
          date: '2026-10-17T00:00:00+00:00',
          authority: 2,
        },
      ],
    });
  }
  if (query.includes('__xss')) {
    return sendJson(res, 200, {
      results: [
        {
          rerank_score: 2.0,
          title: '<img src=x onerror="window.__xss=1">恶意标题',
          url: 'javascript:window.__xss=2',
          snippet: '<script>window.__xss=3</script>普通摘要 & < > "quotes"',
          summary: '<svg onload="window.__xss=4">恶意长摘要</svg>',
          content: '<iframe srcdoc="<script>window.__xss=5</script>"></iframe>',
          site_name: '<b>站点</b>',
          site_icon: 'data:text/html,<script>alert(1)</script>',
          date: 'not-a-date',
          authority: 4,
        },
        {
          rerank_score: 1.2,
          title: '正常结果',
          url: 'https://example.com/?q=<script>',
          snippet: '测试 & < > "quotes"',
          summary: '',
          content: '',
          site_name: null,
          site_icon: null,
          date: null,
          authority: -1,
        },
      ],
    });
  }

  const results = RESULTS.slice(0, count).map((item) => ({
    ...item,
    content: body.need_content === true ? item.content || '' : '',
    // 让高权威/高质量筛选在演示时有一些可观察的差异
  }));

  console.log(
    `[mock] query=${JSON.stringify(query)} count=${count} need_content=${Boolean(
      body.need_content,
    )} -> ${results.length} results`,
  );
  sendJson(res, 200, { results });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] DeepSeek Search API mock listening on http://127.0.0.1:${PORT}`);
});
