/**
 * 可选的本地 UI 冒烟测试：用 Chrome DevTools Protocol 驱动页面，
 * 截图输出到 /tmp/ds-ui-check，便于人工检查视觉与交互。
 *
 * 前置：
 *   node test/mock-upstream.mjs
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:8940 DEEPSEEK_API_KEY=test PORT=8899 npm start
 *
 * 运行：
 *   BASE_URL=http://127.0.0.1:8899 node test/ui-check.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8899';
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9333);
const OUT_DIR = process.env.SCREENSHOT_DIR || '/tmp/ds-ui-check';

const results = [];
const consoleErrors = [];

function assert(condition, label) {
  results.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(150);
  }
  throw new Error(`等待 ${url} 超时`);
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'ds-ui-check-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-crash-reporter',
      '--hide-scrollbars',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    let target = null;
    for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`,
          { method: 'PUT' },
        );
        if (response.ok) target = await response.json();
      } catch {
        /* Chrome 还没准备好 */
      }
      if (!target) await sleep(150);
    }
    if (!target) throw new Error('无法创建 Chrome 调试目标');

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    const cdp = new CDP(socket);
    cdp.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails?.text || 'exception');
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push(
          params.args
            .map((arg) => arg.value ?? arg.description ?? '')
            .join(' ')
            .slice(0, 500),
        );
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'Runtime.evaluate 失败');
      }
      return result.result.value;
    };

    const waitFor = async (expression, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(${expression})`)) return true;
        await sleep(100);
      }
      throw new Error(`等待条件超时：${expression}`);
    };

    const navigate = async (url, readyExpression = "document.readyState === 'complete'") => {
      await cdp.send('Page.navigate', { url });
      await waitFor(readyExpression, 12000);
      await sleep(250);
    };

    const screenshot = async (name, fullPage = false) => {
      // 等 CSS 过渡/淡入结束，避免截图落在动画中间帧。
      await sleep(350);
      let params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
      if (fullPage) {
        const metrics = await cdp.send('Page.getLayoutMetrics');
        const size = metrics.cssContentSize;
        params = {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, 6000), scale: 1 },
        };
      }
      const result = await cdp.send('Page.captureScreenshot', params);
      const file = path.join(OUT_DIR, `${name}.png`);
      writeFileSync(file, Buffer.from(result.data, 'base64'));
      console.log(`  screenshot → ${file}`);
    };

    const clickVisible = async (selector) => {
      const ok = await evaluate(`(() => {
        const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
          .find((node) => node.getClientRects().length > 0);
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!ok) throw new Error(`找不到可见元素：${selector}`);
    };

    const focusAndType = async (selector, text) => {
      await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      if (text) await cdp.send('Input.insertText', { text });
      await sleep(250);
    };

    const pressKey = async (key, code, keyCode) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
      await sleep(250);
    };

    const setViewport = async (width, height, mobile = false) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
    };

    await setViewport(1440, 1000);
    await cdp.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });

    /* ---------------- 首页 ---------------- */
    const serverStatus = await (await fetch(`${BASE_URL}/api/status`)).json();
    await navigate(`${BASE_URL}/`);
    await waitFor("document.querySelector('#home-input')");

    /* 如果服务端没有环境变量密钥，顺带验证「未配置 → 尝试搜索 → 设置密钥 → 自动重试」流程 */
    if (!serverStatus.configured) {
      await focusAndType('#home-input', 'DeepSeek API');
      await pressKey('Enter', 'Enter', 13);
      await waitFor("document.querySelector('#settings-dialog').open");
      await waitFor("document.querySelector('.state-card')");
      assert(true, '未配置时尝试搜索会打开设置并显示说明');
      await sleep(350);
      await screenshot('00-need-key');
      assert(
        await evaluate("!document.querySelector('#settings-key-form').hidden"),
        '未配置时显示 API Key 表单',
      );
      await evaluate(`(() => {
        const input = document.querySelector('#api-key-input');
        input.focus();
        input.value = 'sk-ui-test-key';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await clickVisible('#save-key');
      await waitFor("document.querySelectorAll('.result').length > 0", 12000);
      assert(true, '保存会话密钥后自动重试挂起的搜索');
      await navigate(`${BASE_URL}/`);
      await waitFor("document.querySelector('#home-input')");
    }

    assert(
      (await evaluate("document.documentElement.dataset.theme")) === 'light',
      '首页默认使用浅色主题',
    );
    assert(
      await evaluate(`(() => {
        const img = document.querySelector('.logo .brand-cn');
        return (
          document.querySelectorAll('.logo .brand-svg').length === 1 &&
          img?.tagName === 'IMG' &&
          img.getAttribute('src') === 'assets/search-wordmark.png' &&
          img.complete &&
          img.naturalWidth > 0
        );
      })()`),
      '首页 logo 为鲸鱼字标 + 搜索字标图片',
    );
    assert(
      await evaluate(`(() => {
        const form = document.querySelector('#home-form');
        const shell = form.getBoundingClientRect();
        return (
          Math.abs(shell.width - 680) < 1 &&
          Math.round(shell.height) === 60 &&
          parseFloat(getComputedStyle(form).borderRadius) >= 29
        );
      })()`),
      '首页搜索框约 680×60 且为胶囊形',
    );
    assert(
      await evaluate(`(() => {
        const footer = document.querySelector('.site-footer')?.textContent || '';
        return footer.includes('Powered by DeepSeek Search') && footer.includes('Independent Project');
      })()`),
      '页脚仅保留低调的品牌说明',
    );
    assert(
      await evaluate(`!document.querySelector('#lucky-button') &&
        !document.querySelector('#home-status') &&
        !document.querySelector('.home-nav')`),
      '首页已移除手气不错、状态 pill 与重复导航',
    );
    await screenshot('01-home-light');

    /* ---------------- 建议与键盘搜索 ---------------- */
    await focusAndType('#home-input', 'DeepSeek 搜索 API');
    await waitFor("document.querySelectorAll('#home-suggestions .suggestion').length > 0");
    assert(true, '输入时出现搜索建议');
    await screenshot('02-home-suggestions');

    await pressKey('ArrowDown', 'ArrowDown', 40);
    await pressKey('Enter', 'Enter', 13);
    await waitFor("document.querySelectorAll('.results-list .result').length === 10");
    assert(
      (await evaluate("document.querySelectorAll('.results-list .result').length")) === 10,
      'Enter 提交后渲染 10 条结果',
    );
    assert(
      (await evaluate("document.querySelector('#results-input').value")) === 'DeepSeek 搜索 API',
      '结果页搜索框同步关键词',
    );
    assert(
      (await evaluate("document.querySelector('#results-meta').textContent")).includes('10 条结果'),
      '结果统计文案',
    );
    await screenshot('03-results-light');

    /* ---------------- 历史前进 / 后退 ---------------- */
    await evaluate('history.back()');
    await waitFor("!document.querySelector('#home-view').hidden");
    assert(
      !(await evaluate('location.search')),
      '浏览器后退回到首页',
    );
    await evaluate('history.forward()');
    await waitFor("document.querySelectorAll('.result').length > 0");
    assert(
      (await evaluate('location.search')).includes('q='),
      '浏览器前进恢复结果页',
    );

    /* ---------------- 筛选 ---------------- */
    await clickVisible('.tab[data-filter="quality"]');
    await sleep(300);
    assert(
      (await evaluate("document.querySelectorAll('.results-list .result').length")) === 7,
      '“高质量”筛选显示 7 条结果',
    );
    assert(
      (await evaluate("document.querySelector('#results-meta').textContent")).includes('筛选出'),
      '筛选统计文案',
    );
    await screenshot('04-results-filtered');

    /* ---------------- 展开摘要 ---------------- */
    await clickVisible('.tab[data-filter="all"]');
    await sleep(250);
    await clickVisible('[data-expand="0"]');
    await waitFor("document.querySelector('#result-extra-0') && !document.querySelector('#result-extra-0').hidden");
    assert(
      await evaluate("document.querySelector('[data-expand=\"0\"]').getAttribute('aria-expanded') === 'true'"),
      '展开长摘要面板',
    );
    await sleep(350);
    await screenshot('05-results-expanded');

    /* ---------------- 结果条数 ---------------- */
    await evaluate(`(() => {
      const select = document.querySelector('#count-select');
      select.value = '20';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor("document.querySelectorAll('.result').length > 10", 12000);
    assert(
      (await evaluate("document.querySelector('#count-select').value")) === '20',
      '切换“每次 20 条”后重新搜索',
    );
    await evaluate(`(() => {
      const select = document.querySelector('#count-select');
      select.value = '10';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor("document.querySelectorAll('.result').length === 10", 12000);

    /* ---------------- 设置弹窗 ---------------- */
    await clickVisible('#results-view .icon-btn[data-open-settings]');
    await waitFor("document.querySelector('#settings-dialog').open");
    assert(true, '设置弹窗打开');
    await sleep(350);
    await screenshot('06-settings');

    /* 开关与打开方式（回归 P1：<html> 曾被误当成主题按钮） */
    assert(
      (await evaluate("document.documentElement.getAttribute('aria-checked')")) === null,
      '根元素没有无效的 aria-checked',
    );
    assert(
      (await evaluate("document.querySelector('#pref-open-mode')?.value")) === 'newtab',
      '默认结果打开方式为新建标签页',
    );
    assert(
      (await evaluate("document.querySelector('.result-title')?.getAttribute('target')")) ===
        '_blank',
      '默认结果链接带 target=_blank',
    );
    await evaluate("document.querySelector('#pref-content').click()");
    await waitFor("document.querySelector('#pref-content').checked");
    assert(true, '「返回网页正文」开关可开启');
    await waitFor("document.querySelector('#results-content').getAttribute('aria-busy') === 'false'", 12000);
    await sleep(300);

    // 切换为「直接切换」后，结果链接应立即变回当前页跳转
    await evaluate(`(() => {
      const select = document.querySelector('#pref-open-mode');
      select.value = 'same';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    assert(
      (await evaluate("document.querySelector('.result-title')?.getAttribute('target')")) ===
        null,
      '选择「直接切换」后结果链接无 target',
    );

    // 再切回新建标签页
    await evaluate(`(() => {
      const select = document.querySelector('#pref-open-mode');
      select.value = 'newtab';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor("document.querySelector('.result-title')?.getAttribute('target') === '_blank'");
    assert(
      await evaluate(`(() => {
        const prefs = JSON.parse(localStorage.getItem('ds-search.prefs') || '{}');
        return prefs.needContent === true && prefs.openInNewTab === true && prefs.version === 2;
      })()`),
      '结果打开方式与正文偏好写入 localStorage',
    );
    await sleep(350);
    await screenshot('06b-settings-toggles');

    assert(
      !(await evaluate("document.querySelector('.settings-details')?.open")),
      '搜索语法默认收纳在设置中',
    );
    await clickVisible('.settings-details summary');
    await waitFor("document.querySelector('.settings-details')?.open");
    assert(
      (await evaluate("document.querySelector('.settings-details').textContent")).includes('site:'),
      '设置内展开搜索语法与快捷键',
    );
    await sleep(250);
    await screenshot('06d-settings-syntax');
    await clickVisible('#settings-dialog [data-close-dialog]');
    await waitFor("document.querySelector('#results-content').getAttribute('aria-busy') === 'false'");
    await sleep(400);
    assert(
      (await evaluate("document.querySelector('.result-title')?.getAttribute('target')")) ===
        '_blank',
      '结果链接带 target=_blank',
    );
    await clickVisible('[data-expand="0"]');
    await waitFor("document.querySelector('#result-extra-0 .content-text')");
    assert(true, 'need_content=true 后展示网页正文摘录');
    await sleep(300);
    await screenshot('06c-content-expanded');

    /* ---------------- 深色主题 ---------------- */
    await clickVisible('#results-view .theme-toggle');
    await sleep(250);
    assert(
      (await evaluate("document.documentElement.dataset.theme")) === 'dark',
      '切换深色主题',
    );
    assert(
      (await evaluate("getComputedStyle(document.querySelector('.brand-cn')).filter")).includes(
        'invert(1)',
      ),
      '深色主题下搜索字标反白',
    );
    await screenshot('08-results-dark');

    /* ---------------- 空结果 ---------------- */
    await navigate(`${BASE_URL}/?q=__empty`);
    await waitFor("document.querySelector('.state-card')");
    assert(
      (await evaluate("document.querySelector('.state-card').textContent")).includes('没有找到'),
      '空结果状态',
    );
    await screenshot('09-empty');

    /* ---------------- 错误状态 401 ---------------- */
    await navigate(`${BASE_URL}/?q=__error401`);
    await waitFor("document.querySelector('.state-card')");
    assert(
      (await evaluate("document.querySelector('.state-card').textContent")).includes('API Key'),
      '401 错误状态给出配置提示',
    );
    await screenshot('10-error-401');

    /* ---------------- 恶意字段 XSS ---------------- */
    await navigate(`${BASE_URL}/?q=__xss`);
    await waitFor("document.querySelectorAll('.result').length === 2");
    assert(
      (await evaluate("typeof window.__xss === 'undefined'")),
      '恶意 title/snippet/summary/content 不会执行脚本',
    );
    assert(
      await evaluate("document.querySelector('.result-title').textContent.includes('<img')"),
      '恶意标题按纯文本渲染',
    );
    assert(
      (await evaluate("document.querySelector('.result-title').tagName")) === 'SPAN',
      '非 http(s) URL 不会生成链接',
    );
    assert(
      (await evaluate("document.querySelectorAll('.favicon img').length")) === 0,
      'data: 协议站点图标被拒绝',
    );
    await screenshot('10b-xss');

    /* ---------------- 超长无空格字段（横向溢出回归） ---------------- */
    await navigate(`${BASE_URL}/?q=__weird`);
    await waitFor("document.querySelectorAll('.result').length === 1");
    assert(
      await evaluate(
        'document.documentElement.scrollWidth <= window.innerWidth + 1',
      ),
      '超长无空格 title/site_name 不造成横向溢出',
    );
    await screenshot('10c-long-fields');

    /* ---------------- 移动端 ---------------- */
    await evaluate(`localStorage.setItem('ds-search.prefs', JSON.stringify({
      count: 10,
      needContent: false,
      openInNewTab: true,
      version: 2,
    }))`);
    await setViewport(390, 844, true);
    await navigate(`${BASE_URL}/`);
    await waitFor("document.querySelector('#home-input')");
    // 前面的深色主题测试写入了 localStorage，移动端重新固定为浅色以便检查。
    await evaluate("localStorage.setItem('ds-search.theme', 'light')");
    await cdp.send('Page.reload');
    await waitFor("document.querySelector('#home-input')");
    await sleep(500);
    assert(
      (await evaluate("document.documentElement.dataset.theme")) === 'light',
      '移动端浅色主题',
    );
    assert(
      await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
      '移动端首页无横向溢出',
    );
    await screenshot('11-mobile-home', true);
    await focusAndType('#home-input', 'DeepSeek 搜索 API');
    await waitFor("document.querySelectorAll('#home-suggestions .suggestion').length > 0");
    await pressKey('Enter', 'Enter', 13);
    await waitFor("document.querySelectorAll('.result').length > 0", 12000);
    assert(true, '移动端 Enter 提交并显示结果');
    await sleep(500);
    await screenshot('12-mobile-results', true);

    assert(consoleErrors.length === 0, `页面无 JS 错误（${consoleErrors.length}）`);
    if (consoleErrors.length) console.log(consoleErrors);

    const failed = results.filter((item) => !item.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    if (failed.length) process.exitCode = 1;
  } finally {
    chrome.kill('SIGKILL');
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
