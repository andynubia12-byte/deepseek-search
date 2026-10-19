/* ==========================================================================
   DeepSeek 搜索 · 前端逻辑
   - 首页 / 结果页两个视图，使用 History API 保持可分享的 ?q= 链接
   - 所有外部字符串在进入 DOM 前均做 HTML 转义
   - API Key 只会发送给同源的本地服务
   ========================================================================== */
(() => {
  'use strict';

  const STORAGE_KEYS = {
    theme: 'ds-search.theme',
    prefs: 'ds-search.prefs',
    recents: 'ds-search.recents',
  };

  const VALID_COUNTS = new Set([10, 20, 30, 50]);
  const PREFS_VERSION = 2;
  // 新默认：点击结果标题时新建标签页。旧版本保存的偏好会迁移到该默认值。
  const DEFAULT_PREFS = {
    count: 10,
    needContent: false,
    openInNewTab: true,
    version: PREFS_VERSION,
  };
  const MAX_QUERY_LENGTH = 128;
  const MAX_RECENTS = 8;
  const CONTENT_PREVIEW_LIMIT = 16000;
  const CACHE_TTL_MS = 5 * 60 * 1000;

  const API = {
    status: '/api/status',
    key: '/api/key',
    search: '/api/search',
  };

  const DOCS_URL = 'https://api-docs.deepseek.com/zh-cn/guides/search';

  /* ------------------------------------------------------------------ */
  /* 工具函数                                                            */
  /* ------------------------------------------------------------------ */

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  const escapeAttr = escapeHtml;

  function normalizeQuery(value) {
    return Array.from(String(value ?? '').trim()).slice(0, MAX_QUERY_LENGTH).join('');
  }

  function charLength(value) {
    return Array.from(String(value ?? '')).length;
  }

  function readStorage(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  function safeHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value.trim(), window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.href;
    } catch {
      return '';
    }
  }

  function hashString(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  function firstCharacter(value) {
    const chars = Array.from(String(value ?? '').trim());
    return chars.length ? chars[0].toUpperCase() : '?';
  }

  function formatDate(value) {
    if (!value || typeof value !== 'string') return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  function formatCrumbPath(url) {
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      /* 保留原始 pathname */
    }
    pathname = pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '/') return '';
    const segments = pathname.split('/').filter(Boolean);
    if (!segments.length) return '';
    const visible = segments.slice(0, 3).join(' › ');
    return segments.length > 3 ? `${visible} › …` : visible;
  }

  function formatSeconds(seconds) {
    if (!Number.isFinite(seconds)) return '';
    return Math.max(0.01, seconds).toFixed(2);
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function extractHighlightTerms(query) {
    const terms = [];
    const seen = new Set();
    const pattern = /"[^"]*"|\S+/g;
    let match;
    while ((match = pattern.exec(query)) !== null) {
      let token = match[0].trim();
      if (!token) continue;
      if (/^(?:-?site:|lang:|after:|before:)/i.test(token)) continue;
      if (token.startsWith('-')) token = token.slice(1);
      token = token.replace(/^["']|["']$/g, '').trim();
      if (!token) continue;
      if (charLength(token) > 40) continue;
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(token);
      if (terms.length >= 12) break;
    }
    return terms;
  }

  /** 对纯文本中的搜索词做 <mark>，同时保证所有文本都经过转义。 */
  function highlight(text) {
    const source = String(text ?? '');
    const terms = extractHighlightTerms(state.query);
    if (!terms.length) return escapeHtml(source);

    let pattern;
    try {
      pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'giu');
    } catch {
      return escapeHtml(source);
    }

    let html = '';
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (!match[0]) {
        pattern.lastIndex += 1;
        continue;
      }
      html += escapeHtml(source.slice(lastIndex, match.index));
      html += `<mark>${escapeHtml(match[0])}</mark>`;
      lastIndex = match.index + match[0].length;
    }
    html += escapeHtml(source.slice(lastIndex));
    return html;
  }

  function showToast(message, duration = 2600) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      el.toast.classList.remove('show');
    }, duration);
  }

  async function safeJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 继续尝试 execCommand */
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.className = 'clipboard-helper';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 首选项 / 主题                                                        */
  /* ------------------------------------------------------------------ */

  function loadPrefs() {
    let parsed = null;
    try {
      parsed = JSON.parse(readStorage(STORAGE_KEYS.prefs, '{}'));
    } catch {
      parsed = null;
    }
    const count = Number(parsed?.count);
    const isLegacy = parsed?.version !== PREFS_VERSION;
    const prefs = {
      count: VALID_COUNTS.has(count) ? count : DEFAULT_PREFS.count,
      needContent: parsed?.needContent === true,
      // 旧版本的 openInNewTab=false 只是旧默认值；升级时统一迁移到新的默认值（新建标签页）。
      openInNewTab: isLegacy ? DEFAULT_PREFS.openInNewTab : parsed?.openInNewTab !== false,
      version: PREFS_VERSION,
    };
    if (isLegacy) {
      // 把迁移结果立即写回，避免每次都判定为旧版本。
      writeStorage(STORAGE_KEYS.prefs, JSON.stringify(prefs));
    }
    return prefs;
  }

  function savePrefs() {
    writeStorage(
      STORAGE_KEYS.prefs,
      JSON.stringify({ ...state.prefs, version: PREFS_VERSION }),
    );
  }

  function loadRecents() {
    try {
      const parsed = JSON.parse(readStorage(STORAGE_KEYS.recents, '[]'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => typeof item === 'string' && item.trim()).slice(0, MAX_RECENTS);
    } catch {
      return [];
    }
  }

  function addRecent(query) {
    const needle = query.toLowerCase();
    state.recents = [query, ...state.recents.filter((item) => item.toLowerCase() !== needle)].slice(
      0,
      MAX_RECENTS,
    );
    writeStorage(STORAGE_KEYS.recents, JSON.stringify(state.recents));
  }

  function getStoredThemeChoice() {
    const stored = readStorage(STORAGE_KEYS.theme, 'system');
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  }

  function resolveTheme(choice) {
    if (choice === 'light' || choice === 'dark') return choice;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  function updateThemeUI(resolved) {
    const isDark = resolved === 'dark';
    el.themeToggles.forEach((button) => {
      const label = isDark ? '切换到浅色模式' : '切换到深色模式';
      button.setAttribute('aria-label', label);
      button.title = label;
      const use = button.querySelector('use');
      if (use) use.setAttribute('href', isDark ? '#i-sun' : '#i-moon');
    });
    el.themeChoiceButtons.forEach((button) => {
      button.setAttribute('aria-checked', String(button.dataset.themeChoice === state.themeChoice));
    });
  }

  function applyTheme(choice, { persist = true } = {}) {
    state.themeChoice = choice;
    const resolved = resolveTheme(choice);
    el.html.dataset.theme = resolved;
    if (persist) writeStorage(STORAGE_KEYS.theme, choice);
    updateThemeUI(resolved);
  }

  /* ------------------------------------------------------------------ */
  /* 应用状态                                                            */
  /* ------------------------------------------------------------------ */

  const el = {
    html: document.documentElement,
    homeView: $('#home-view'),
    resultsView: $('#results-view'),
    homeForm: $('#home-form'),
    resultsForm: $('#results-form'),
    homeInput: $('#home-input'),
    resultsInput: $('#results-input'),
    homeClear: $('#home-clear'),
    resultsClear: $('#results-clear'),
    homeSuggestions: $('#home-suggestions'),
    resultsSuggestions: $('#results-suggestions'),
    countSelect: $('#count-select'),
    resultsMeta: $('#results-meta'),
    resultsContent: $('#results-content'),
    resultsHeading: $('#results-heading'),
    resultsHomeLink: $('#results-home-link'),
    connectionBanner: $('#connection-banner'),
    retryConnection: $('#retry-connection'),
    serverUrl: $('#server-url'),
    skipLink: $('#skip-link'),
    toast: $('#toast'),
    settingsDialog: $('#settings-dialog'),
    settingsStatusBadge: $('#settings-status-badge'),
    settingsOffline: $('#settings-offline'),
    settingsEnvNote: $('#settings-env-note'),
    settingsKeyForm: $('#settings-key-form'),
    apiKeyInput: $('#api-key-input'),
    toggleKeyVisibility: $('#toggle-key-visibility'),
    saveKey: $('#save-key'),
    verifyKey: $('#verify-key'),
    clearKey: $('#clear-key'),
    keyFeedback: $('#key-feedback'),
    prefCount: $('#pref-count'),
    prefContent: $('#pref-content'),
    prefOpenMode: $('#pref-open-mode'),
    themeChoiceButtons: $$('#settings-dialog [data-theme-choice]'),
    themeToggles: $$('.theme-toggle'),
    tabs: $$('.tab'),
  };

  const state = {
    serverOk: false,
    configured: false,
    keySource: null,
    view: 'home',
    query: '',
    results: [],
    elapsed: null,
    loading: false,
    error: null,
    filter: 'all',
    abortController: null,
    searchSeq: 0,
    prefs: loadPrefs(),
    recents: loadRecents(),
    themeChoice: getStoredThemeChoice(),
    cache: new Map(),
    pendingQuery: null,
  };

  let suggestState = { kind: null, items: [], index: -1 };

  /* ------------------------------------------------------------------ */
  /* 搜索框 & 建议                                                        */
  /* ------------------------------------------------------------------ */

  function shellParts(kind) {
    if (kind === 'home') {
      return {
        kind: 'home',
        form: el.homeForm,
        input: el.homeInput,
        clear: el.homeClear,
        list: el.homeSuggestions,
      };
    }
    return {
      kind: 'results',
      form: el.resultsForm,
      input: el.resultsInput,
      clear: el.resultsClear,
      list: el.resultsSuggestions,
    };
  }

  function activeKind() {
    return state.view === 'home' ? 'home' : 'results';
  }

  function updateClearState(kind) {
    const parts = shellParts(kind);
    const hasValue = parts.input.value.trim().length > 0;
    parts.clear.hidden = !hasValue;
    parts.form.classList.toggle('has-value', hasValue);
  }

  function updateBothClearStates() {
    updateClearState('home');
    updateClearState('results');
  }

  function buildSuggestionItems(value) {
    const items = [];
    const needle = value.trim().toLowerCase();
    if (value.trim()) items.push({ value: value.trim(), type: 'query' });

    for (const recent of state.recents) {
      if (items.length >= 7) break;
      if (needle && !recent.toLowerCase().includes(needle)) continue;
      if (recent === value.trim()) continue;
      items.push({ value: recent, type: 'recent' });
    }
    return items;
  }

  function hideSuggestionLists() {
    for (const kind of ['home', 'results']) {
      const parts = shellParts(kind);
      parts.list.hidden = true;
      parts.input.setAttribute('aria-expanded', 'false');
      parts.input.removeAttribute('aria-activedescendant');
    }
    suggestState = { kind: null, items: [], index: -1 };
  }

  function renderSuggestionActive() {
    if (!suggestState.kind) return;
    const parts = shellParts(suggestState.kind);
    const options = $$('.suggestion', parts.list);
    options.forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === suggestState.index));
    });
    if (suggestState.index >= 0 && options[suggestState.index]) {
      parts.input.setAttribute('aria-activedescendant', options[suggestState.index].id);
      options[suggestState.index].scrollIntoView({ block: 'nearest' });
    } else {
      parts.input.removeAttribute('aria-activedescendant');
    }
  }

  function openSuggestions(kind) {
    if ($('dialog[open]')) return;
    hideSuggestionLists();

    const parts = shellParts(kind);
    const items = buildSuggestionItems(parts.input.value);
    if (!items.length) return;

    parts.list.innerHTML = items
      .map(
        (item, index) => `
        <li class="suggestion" id="${kind}-suggestion-${index}" role="option"
            aria-selected="${index === suggestState.index}" data-index="${index}">
          <svg class="icon" aria-hidden="true"><use href="${item.type === 'recent' ? '#i-clock' : '#i-search'}"></use></svg>
          <span class="suggestion-text">${escapeHtml(item.value)}</span>
          <span class="suggestion-hint">${item.type === 'recent' ? '最近' : '搜索'}</span>
        </li>`,
      )
      .join('');

    suggestState = { kind, items, index: -1 };
    parts.list.hidden = false;
    parts.input.setAttribute('aria-expanded', 'true');
    renderSuggestionActive();
  }

  function closeSuggestions() {
    hideSuggestionLists();
  }

  function chooseSuggestion(index) {
    if (!suggestState.kind) return;
    const item = suggestState.items[index];
    if (!item) return;
    const kind = suggestState.kind;
    const parts = shellParts(kind);
    parts.input.value = item.value;
    updateClearState(kind);
    closeSuggestions();
    runSearch(item.value, { push: true });
  }

  function handleSuggestionKeydown(kind, event) {
    if (event.isComposing || event.keyCode === 229) return;

    const parts = shellParts(kind);
    const isOpen = suggestState.kind === kind && !parts.list.hidden;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!isOpen) {
        openSuggestions(kind);
        return;
      }
      if (suggestState.items.length) {
        suggestState.index = (suggestState.index + 1) % suggestState.items.length;
        renderSuggestionActive();
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      if (!isOpen || !suggestState.items.length) return;
      event.preventDefault();
      suggestState.index =
        suggestState.index <= 0 ? suggestState.items.length - 1 : suggestState.index - 1;
      renderSuggestionActive();
      return;
    }

    if (event.key === 'Enter') {
      if (isOpen && suggestState.index >= 0) {
        event.preventDefault();
        chooseSuggestion(suggestState.index);
        return;
      }
      // 统一在 keydown 里触发搜索，避免某些浏览器/输入法场景下表单默认提交丢失。
      event.preventDefault();
      closeSuggestions();
      runSearch(parts.input.value, { push: true });
      return;
    }

    if (event.key === 'Escape') {
      if (isOpen) {
        event.preventDefault();
        closeSuggestions();
      }
      return;
    }

    if (event.key === 'Tab') {
      closeSuggestions();
    }
  }

  function focusSearch() {
    const parts = shellParts(activeKind());
    parts.input.focus();
    parts.input.select();
  }

  function syncPrefControls() {
    if (el.countSelect) el.countSelect.value = String(state.prefs.count);
    if (el.prefCount) el.prefCount.value = String(state.prefs.count);
    if (el.prefContent) el.prefContent.checked = state.prefs.needContent;
    if (el.prefOpenMode) el.prefOpenMode.value = state.prefs.openInNewTab ? 'newtab' : 'same';
  }

  /* ------------------------------------------------------------------ */
  /* 本地服务状态                                                        */
  /* ------------------------------------------------------------------ */

  function setConnectionBanner(visible) {
    if (!el.connectionBanner) return;
    el.connectionBanner.hidden = !visible;
    if (visible && el.serverUrl) {
      el.serverUrl.textContent = /^https?:$/.test(window.location.protocol)
        ? window.location.origin
        : 'http://127.0.0.1:8787';
    }
  }

  async function refreshStatus() {
    try {
      const response = await fetch(API.status, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await safeJson(response);
      if (!data || data.ok !== true) throw new Error('invalid status response');
      state.serverOk = true;
      state.configured = Boolean(data.configured);
      state.keySource = data.keySource || null;
      setConnectionBanner(false);
    } catch {
      state.serverOk = false;
      state.configured = false;
      state.keySource = null;
      setConnectionBanner(true);
    }
    syncSettingsState();
    return state.serverOk;
  }

  /* ------------------------------------------------------------------ */
  /* 设置弹窗                                                            */
  /* ------------------------------------------------------------------ */

  function setKeyFeedback(message, kind = '') {
    if (!el.keyFeedback) return;
    el.keyFeedback.textContent = message || '';
    el.keyFeedback.className = kind ? `feedback ${kind}` : 'feedback';
  }

  function syncSettingsState() {
    if (!el.settingsStatusBadge) return;

    let stateName;
    let label;
    if (!state.serverOk) {
      stateName = 'offline';
      label = '服务未启动';
    } else if (state.configured) {
      stateName = 'ok';
      label = state.keySource === 'environment' ? '环境变量' : '已配置';
    } else {
      stateName = 'warn';
      label = '未配置';
    }
    el.settingsStatusBadge.dataset.state = stateName;
    el.settingsStatusBadge.textContent = label;

    el.settingsOffline.hidden = state.serverOk;
    el.settingsEnvNote.hidden = !(state.serverOk && state.keySource === 'environment');

    const showForm = state.serverOk && state.keySource !== 'environment';
    el.settingsKeyForm.hidden = !showForm;
    if (showForm) {
      el.clearKey.disabled = !state.configured;
      el.verifyKey.disabled = !state.configured;
      el.apiKeyInput.placeholder = state.configured
        ? '已配置，输入新 Key 可替换'
        : 'sk-...';
    }

    syncPrefControls();
    updateThemeUI(resolveTheme(state.themeChoice));
  }

  function openSettings() {
    if (!el.settingsDialog) return;
    if (el.settingsDialog.open) return;
    setKeyFeedback('');
    syncSettingsState();
    el.settingsDialog.showModal();
    if (state.serverOk && state.keySource !== 'environment' && !state.configured) {
      window.setTimeout(() => el.apiKeyInput?.focus(), 30);
    }
  }

  async function saveKey() {
    const apiKey = (el.apiKeyInput.value || '').trim();
    if (!apiKey) {
      setKeyFeedback('请先输入 DeepSeek API Key。', 'error');
      el.apiKeyInput.focus();
      return;
    }
    el.saveKey.disabled = true;
    setKeyFeedback('正在保存…');
    try {
      const response = await fetch(API.key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      const data = await safeJson(response);
      if (!response.ok) {
        throw new Error(data?.error?.message || `保存失败（HTTP ${response.status}）`);
      }
      state.serverOk = true;
      state.configured = Boolean(data?.configured);
      state.keySource = data?.keySource || 'session';
      el.apiKeyInput.value = '';
      syncSettingsState();
      setKeyFeedback('API Key 已保存到当前服务会话，不会写入磁盘。', 'ok');

      if (state.pendingQuery) {
        const pending = state.pendingQuery;
        state.pendingQuery = null;
        el.settingsDialog.close();
        runSearch(pending, { push: false });
      }
    } catch (error) {
      setKeyFeedback(error?.message || '保存失败，请重试。', 'error');
    } finally {
      el.saveKey.disabled = false;
    }
  }

  async function verifyConnection() {
    if (!state.configured) {
      setKeyFeedback('请先保存 API Key，再测试连接。', 'error');
      return;
    }
    if ((el.apiKeyInput.value || '').trim()) {
      setKeyFeedback('输入框里还有未保存的 Key，请先点击「保存密钥」。', 'error');
      return;
    }
    el.verifyKey.disabled = true;
    setKeyFeedback('正在测试连接…');
    const startedAt = performance.now();
    try {
      const response = await fetch(API.search, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'DeepSeek', count: 1, need_content: false }),
      });
      const data = await safeJson(response);
      const elapsed = (performance.now() - startedAt) / 1000;
      if (!response.ok) {
        const error = new Error(data?.error?.message || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const count = Array.isArray(data?.results) ? data.results.length : 0;
      setKeyFeedback(`连接成功：返回 ${count} 条结果，用时 ${formatSeconds(elapsed)} 秒。`, 'ok');
    } catch (error) {
      setKeyFeedback(`连接失败：${error?.message || '请稍后重试。'}`, 'error');
      if (error?.status === 401) {
        state.configured = false;
        state.keySource = null;
        syncSettingsState();
      }
    } finally {
      el.verifyKey.disabled = !state.configured;
    }
  }

  async function clearKey() {
    if (state.keySource === 'environment') return;
    el.clearKey.disabled = true;
    setKeyFeedback('正在清除…');
    try {
      const response = await fetch(API.key, { method: 'DELETE' });
      const data = await safeJson(response);
      if (!response.ok) {
        throw new Error(data?.error?.message || `清除失败（HTTP ${response.status}）`);
      }
      state.configured = false;
      state.keySource = null;
      syncSettingsState();
      setKeyFeedback('已清除当前服务会话中的 API Key。', 'ok');
    } catch (error) {
      setKeyFeedback(error?.message || '清除失败，请重试。', 'error');
    } finally {
      el.clearKey.disabled = !state.configured;
    }
  }

  function toggleKeyVisibility() {
    const show = el.apiKeyInput.type === 'password';
    el.apiKeyInput.type = show ? 'text' : 'password';
    el.toggleKeyVisibility.setAttribute('aria-pressed', String(show));
    el.toggleKeyVisibility.setAttribute('aria-label', show ? '隐藏 API Key' : '显示 API Key');
    const use = el.toggleKeyVisibility.querySelector('use');
    if (use) use.setAttribute('href', show ? '#i-eye-off' : '#i-eye');
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：结果列表                                                      */
  /* ------------------------------------------------------------------ */

  function getFilteredResults() {
    if (state.filter === 'quality') {
      return state.results.filter((result) => Number(result.rerank_score) >= 1.5);
    }
    if (state.filter === 'authority') {
      return state.results.filter((result) => Number(result.authority) >= 3);
    }
    return state.results;
  }

  function makeCacheKey(query) {
    return `${query}::${state.prefs.count}::${state.prefs.needContent ? 1 : 0}`;
  }

  function cacheResults(query, results, elapsed) {
    state.cache.set(makeCacheKey(query), { results, elapsed, at: Date.now() });
    if (state.cache.size > 10) {
      const oldestKey = state.cache.keys().next().value;
      state.cache.delete(oldestKey);
    }
  }

  function resultHTML(result, index) {
    const url = safeHttpUrl(result.url);
    const parsedUrl = url ? new URL(url) : null;
    const host = parsedUrl ? parsedUrl.hostname.replace(/^www\./, '') : '';
    const rawSiteName = typeof result.site_name === 'string' ? result.site_name.trim() : '';
    const siteName = rawSiteName || host || '未知来源';
    const rawTitle =
      typeof result.title === 'string' && result.title.trim()
        ? result.title.trim()
        : url || '无标题';
    const rawSnippet =
      typeof result.snippet === 'string'
        ? result.snippet.trim()
        : typeof result.summary === 'string'
          ? result.summary.trim()
          : '';
    const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
    const content = typeof result.content === 'string' ? result.content.trim() : '';
    const dateText = formatDate(result.date);
    const siteIcon = safeHttpUrl(result.site_icon);
    const fallbackInitial = firstCharacter(siteName);
    const crumbPath = parsedUrl ? formatCrumbPath(parsedUrl) : '';
    const target = state.prefs.openInNewTab ? ' target="_blank" rel="noopener noreferrer"' : '';

    const faviconMarkup = siteIcon
      ? `<img src="${escapeAttr(siteIcon)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-favicon>`
      : `<span aria-hidden="true">${escapeHtml(fallbackInitial)}</span>`;

    const titleMarkup = url
      ? `<a class="result-title" href="${escapeAttr(url)}"${target} title="${escapeAttr(url)}">${highlight(rawTitle)}</a>`
      : `<span class="result-title">${highlight(rawTitle)}</span>`;

    const dateMarkup = dateText
      ? `<span class="crumb-sep" aria-hidden="true">·</span><span class="result-date">${escapeHtml(dateText)}</span>`
      : '';

    const extraId = `result-extra-${index}`;
    const hasExtra = Boolean(summary || content);
    const contentPreview = content.slice(0, CONTENT_PREVIEW_LIMIT);
    const contentTruncated = content.length > CONTENT_PREVIEW_LIMIT;

    return `
      <li class="result">
        <div class="result-source">
          <span class="favicon" aria-hidden="true" data-fallback="${escapeAttr(fallbackInitial)}">${faviconMarkup}</span>
          <span class="site-name">${escapeHtml(siteName)}</span>
          ${
            crumbPath
              ? `<span class="crumb-sep" aria-hidden="true">›</span><span class="crumb-path">${escapeHtml(
                  crumbPath,
                )}</span>`
              : ''
          }
          ${dateMarkup}
        </div>
        ${titleMarkup}
        ${rawSnippet ? `<p class="result-snippet">${highlight(rawSnippet)}</p>` : ''}
        <div class="result-actions">
          ${
            hasExtra
              ? `<button class="link-btn" type="button" data-expand="${index}" aria-expanded="false" aria-controls="${extraId}">
                   <svg class="icon" aria-hidden="true"><use href="#i-chevron"></use></svg><span>更多摘要</span>
                 </button>`
              : ''
          }
          ${
            url
              ? `<button class="link-btn" type="button" data-copy="${escapeAttr(url)}">
                   <svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg><span>复制链接</span>
                 </button>`
              : ''
          }
        </div>
        ${
          hasExtra
            ? `<div class="result-extra" id="${extraId}" hidden>
                 <p class="extra-label">摘要</p>
                 <p class="extra-summary">${escapeHtml(summary || rawSnippet)}</p>
                 ${
                   content
                     ? `<div class="extra-content">
                          <p class="extra-label">网页正文</p>
                          <div class="content-text">${escapeHtml(contentPreview)}</div>
                          ${
                            contentTruncated
                              ? `<p class="content-note">正文过长，仅显示前 ${CONTENT_PREVIEW_LIMIT} 个字符。</p>`
                              : ''
                          }
                        </div>`
                     : ''
                 }
               </div>`
            : ''
        }
      </li>`;
  }

  function skeletonHTML() {
    const items = [];
    for (let index = 0; index < 6; index += 1) {
      items.push(`
        <div class="skeleton">
          <div class="sk-line sk-url"></div>
          <div class="sk-line sk-title"></div>
          <div class="sk-line sk-text"></div>
          <div class="sk-line sk-text short"></div>
        </div>`);
    }
    return `<div class="skeleton-list" aria-hidden="true">${items.join('')}</div>`;
  }

  function describeError(error) {
    const status = Number(error?.status);
    const detail = error?.message && typeof error.message === 'string' ? error.message : '';

    if (status === 401) {
      return {
        title: '需要有效的 API Key',
        description: '在设置中填写 DeepSeek API Key 后即可开始搜索。密钥只保存在本地服务内存中。',
        detail,
        retryable: false,
        needsSetup: true,
      };
    }
    if (status === 402) {
      return {
        title: 'DeepSeek 账户余额不足',
        description: 'Search API 按成功请求计费（¥5 / 1,000 次）。充值后即可继续搜索。',
        detail,
        retryable: true,
        billing: true,
      };
    }
    if (status === 403) {
      return {
        title: '请求被拒绝',
        description: '服务安全策略拒绝了这次请求，请调整搜索词后再试。',
        detail,
        retryable: false,
      };
    }
    if (status === 408 || status === 504) {
      return {
        title: '搜索超时',
        description: '上游搜索服务没有及时返回结果，请稍后重试。',
        detail,
        retryable: true,
      };
    }
    if (status === 413) {
      return {
        title: '请求内容过大',
        description: '搜索词过长或请求内容过大，请精简搜索词后重试。',
        detail,
        retryable: false,
      };
    }
    if (status === 429) {
      return {
        title: '请求过于频繁',
        description: 'Search API 的账号级限速为 5 QPS，请等待几秒后重试。',
        detail,
        retryable: true,
      };
    }
    if (status >= 500) {
      return {
        title: '搜索服务暂时不可用',
        description: '上游服务没有正常返回结果，请稍后重试。',
        detail,
        retryable: true,
      };
    }
    if (status === 0) {
      return {
        title: '无法连接到本地搜索服务',
        description: '请确认本地服务已启动：在项目目录运行 ./run.sh 后，再通过终端显示的地址打开页面。',
        detail,
        retryable: true,
      };
    }
    return {
      title: '搜索没有完成',
      description: '请求未能完成，请稍后重试。如果持续失败，请查看本地服务日志。',
      detail: [detail, status ? `HTTP ${status}` : ''].filter(Boolean).join(' · '),
      retryable: true,
    };
  }

  function errorHTML(error) {
    const info = describeError(error);
    const actions = [];
    if (info.retryable && state.query) {
      actions.push(
        '<button class="btn btn-primary" type="button" data-retry>重试</button>',
      );
    }
    if (info.needsSetup) {
      actions.push(
        '<button class="btn btn-primary" type="button" data-open-settings>配置 API Key</button>',
      );
    }
    if (info.billing) {
      actions.push(
        `<a class="btn" href="https://platform.deepseek.com/top_up" target="_blank" rel="noopener noreferrer">前往充值</a>`,
      );
    }
    actions.push(
      '<button class="btn btn-ghost" type="button" data-go-home>返回首页</button>',
    );

    return `
      <div class="state-card" role="alert">
        <svg class="icon state-icon" aria-hidden="true"><use href="#i-warning"></use></svg>
        <h2 class="state-title">${escapeHtml(info.title)}</h2>
        <p class="state-desc">${escapeHtml(info.description)}</p>
        ${info.detail ? `<p class="state-detail">${escapeHtml(info.detail)}</p>` : ''}
        <div class="state-actions">${actions.join('')}</div>
      </div>`;
  }

  function emptyHTML() {
    const query = escapeHtml(state.query);
    return `
      <div class="state-card" role="status">
        <svg class="icon state-icon" aria-hidden="true"><use href="#i-search"></use></svg>
        <h2 class="state-title">没有找到与 “${query}” 相关的结果</h2>
        <p class="state-desc">试试更短、更常见的关键词，或减少搜索限定条件。</p>
        <div class="state-actions">
          <button class="btn btn-ghost" type="button" data-go-home>返回首页</button>
        </div>
      </div>`;
  }

  function filterEmptyHTML() {
    const label =
      state.filter === 'quality'
        ? '排序分 ≥ 1.5 的高质量结果'
        : '权威性 ≥ 3 的高权威结果';
    return `
      <div class="state-card">
        <svg class="icon state-icon" aria-hidden="true"><use href="#i-star"></use></svg>
        <h2 class="state-title">没有符合筛选条件的结果</h2>
        <p class="state-desc">当前返回的 ${state.results.length} 条结果里没有${escapeHtml(
          label,
        )}。这只是对本次返回结果的本地筛选，不是新的搜索。</p>
        <div class="state-actions">
          <button class="btn btn-primary" type="button" data-filter-reset>查看全部结果</button>
          <button class="btn btn-ghost" type="button" data-go-home>返回首页</button>
        </div>
      </div>`;
  }

  function renderTabs() {
    el.tabs.forEach((tab) => {
      const active = tab.dataset.filter === state.filter;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', String(active));
    });
  }

  function updateResultsHeading() {
    if (el.resultsHeading) {
      el.resultsHeading.textContent = state.query ? `${state.query} 的搜索结果` : '搜索结果';
    }
  }

  function renderResultsState() {
    updateResultsHeading();
    renderTabs();
    if (!el.resultsMeta || !el.resultsContent) return;

    el.resultsContent.setAttribute('aria-busy', String(state.loading));
    if (el.countSelect) el.countSelect.disabled = state.loading;

    if (state.loading) {
      el.resultsMeta.innerHTML = '<span class="meta-text">正在搜索…</span>';
      el.resultsContent.innerHTML = skeletonHTML();
      return;
    }

    if (state.error) {
      el.resultsMeta.innerHTML = '<span class="meta-text">搜索未完成</span>';
      el.resultsContent.innerHTML = errorHTML(state.error);
      return;
    }

    const total = state.results.length;
    if (total === 0) {
      el.resultsMeta.innerHTML = '<span class="meta-text">没有结果</span>';
      el.resultsContent.innerHTML = emptyHTML();
      return;
    }

    const filtered = getFilteredResults();
    const parts = [`<span class="meta-text"><b>${total}</b> 条结果</span>`];
    if (state.elapsed !== null) {
      parts.push(`<span class="meta-time">${formatSeconds(state.elapsed)} 秒</span>`);
    }
    if (state.filter !== 'all') {
      parts.push(`<span class="filter-note">筛选出 <b>${filtered.length}</b> 条</span>`);
    }
    el.resultsMeta.innerHTML = parts.join('');

    if (filtered.length === 0) {
      el.resultsContent.innerHTML = filterEmptyHTML();
      return;
    }

    el.resultsContent.innerHTML = `<ol class="results-list">${filtered
      .map((result, index) => resultHTML(result, index))
      .join('')}</ol>`;
  }

  /* ------------------------------------------------------------------ */
  /* 视图切换 / 路由                                                     */
  /* ------------------------------------------------------------------ */

  function setView(view) {
    state.view = view;
    el.homeView.hidden = view !== 'home';
    el.resultsView.hidden = view !== 'results';
    if (el.skipLink) el.skipLink.href = view === 'home' ? '#home-main' : '#results-main';
    closeSuggestions();
  }

  function buildSearchUrl(query) {
    return `${window.location.pathname}?q=${encodeURIComponent(query)}`;
  }

  function readQueryFromUrl() {
    try {
      return normalizeQuery(new URLSearchParams(window.location.search).get('q') || '');
    } catch {
      return '';
    }
  }

  function showHome({ push = false, clearInput = true, restoreQuery = false, focus = false } = {}) {
    if (state.loading) {
      state.abortController?.abort();
      state.abortController = null;
      state.searchSeq += 1;
      state.loading = false;
    }
    state.error = null;
    state.pendingQuery = null;
    setView('home');
    if (restoreQuery && state.query) {
      el.homeInput.value = state.query;
    } else if (clearInput) {
      el.homeInput.value = '';
    }
    updateBothClearStates();
    state.query = '';
    document.title = 'DeepSeek 搜索';
    if (push) {
      try {
        window.history.pushState({ view: 'home' }, '', window.location.pathname);
      } catch {
        /* file:// 等环境下忽略 */
      }
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (focus) el.homeInput.focus();
  }

  function createApiError(status, data) {
    const message =
      data?.error?.message ||
      (status === 401
        ? 'DeepSeek API Key 无效或未配置。'
        : status === 429
          ? '请求过于频繁，请稍后重试。'
          : `搜索请求失败（HTTP ${status}）。`);
    const error = new Error(message);
    error.status = status;
    error.code = data?.error?.code;
    error.type = data?.error?.type;
    return error;
  }

  function normalizeSearchError(error) {
    if (error && typeof error.status === 'number') {
      return {
        status: error.status,
        message: error.message,
        code: error.code,
        type: error.type,
        needsSetup: error.status === 401,
      };
    }
    return {
      status: 0,
      message: error?.message || '网络请求失败。',
      code: 'network_error',
      needsSetup: false,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 执行搜索                                                            */
  /* ------------------------------------------------------------------ */

  async function runSearch(rawQuery, { push = true, initial = false } = {}) {
    const query = normalizeQuery(rawQuery);
    if (!query) {
      if (state.view === 'results') showHome({ push: true });
      else el.homeInput.focus();
      return;
    }

    closeSuggestions();
    state.abortController?.abort();
    state.abortController = null;
    state.searchSeq += 1;
    const sequence = state.searchSeq;

    state.view = 'results';
    state.query = query;
    state.results = [];
    state.elapsed = null;
    state.error = null;
    state.loading = true;
    state.filter = 'all';
    state.pendingQuery = null;

    setView('results');
    el.resultsInput.value = query;
    updateBothClearStates();
    document.title = `${query} - DeepSeek 搜索`;
    if (push) {
      try {
        window.history.pushState({ view: 'results', query }, '', buildSearchUrl(query));
      } catch {
        /* 忽略 */
      }
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    renderResultsState();

    if (!state.serverOk) {
      state.loading = false;
      state.error = {
        status: 0,
        message: '无法连接到本地搜索服务。请运行 npm start 后重试。',
      };
      state.pendingQuery = query;
      renderResultsState();
      return;
    }

    if (!state.configured) {
      state.loading = false;
      state.error = {
        status: 401,
        message: '尚未配置 DeepSeek API Key。请在设置中填写后重试。',
        needsSetup: true,
      };
      state.pendingQuery = query;
      renderResultsState();
      if (!initial) openSettings();
      return;
    }

    const controller = new AbortController();
    state.abortController = controller;
    const startedAt = performance.now();

    try {
      const response = await fetch(API.search, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          count: state.prefs.count,
          need_content: state.prefs.needContent,
        }),
        signal: controller.signal,
      });
      if (sequence !== state.searchSeq) return;

      const data = await safeJson(response);
      const elapsed = (performance.now() - startedAt) / 1000;

      if (!response.ok) throw createApiError(response.status, data);

      state.results = Array.isArray(data?.results) ? data.results : [];
      state.elapsed = elapsed;
      state.loading = false;
      cacheResults(query, state.results, elapsed);
      addRecent(query);

      renderResultsState();
    } catch (error) {
      if (sequence !== state.searchSeq) return;
      if (error?.name === 'AbortError') return;

      state.loading = false;
      state.error = normalizeSearchError(error);
      state.cache.delete(makeCacheKey(query));
      renderResultsState();

      if (state.error.needsSetup && !initial) {
        state.pendingQuery = query;
        openSettings();
        setKeyFeedback('当前 API Key 无效或已过期，请检查后保存新的密钥。', 'error');
      }
    } finally {
      if (sequence === state.searchSeq) state.abortController = null;
    }
  }

  function retrySearch() {
    if (!state.query) return;
    refreshStatus().then(() => {
      runSearch(state.query, { push: false });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */

  function bindSearchInputEvents(kind) {
    const parts = shellParts(kind);

    parts.form.addEventListener('submit', (event) => {
      event.preventDefault();
      closeSuggestions();
      runSearch(parts.input.value, { push: true });
    });

    parts.input.addEventListener('input', () => {
      updateClearState(kind);
      if (document.activeElement === parts.input) openSuggestions(kind);
    });

    parts.input.addEventListener('focus', () => {
      openSuggestions(kind);
    });

    parts.input.addEventListener('keydown', (event) => {
      handleSuggestionKeydown(kind, event);
    });

    parts.input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (document.activeElement !== parts.input) closeSuggestions();
      }, 120);
    });

    parts.clear.addEventListener('click', () => {
      parts.input.value = '';
      updateClearState(kind);
      parts.input.focus();
      openSuggestions(kind);
    });

    // 让点击建议时输入框不失去焦点，从而让 click 正常触发。
    parts.list.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });

    parts.list.addEventListener('click', (event) => {
      const item = event.target.closest('.suggestion');
      if (!item) return;
      chooseSuggestion(Number(item.dataset.index));
    });
  }

  function bindPreferenceControls(select) {
    if (!select) return;
    select.addEventListener('change', () => {
      const count = Number(select.value);
      if (!VALID_COUNTS.has(count)) return;
      state.prefs.count = count;
      savePrefs();
      syncPrefControls();
      if (state.view === 'results' && state.query && !state.loading) {
        runSearch(state.query, { push: false });
      }
    });
  }

  function bindEvents() {
    bindSearchInputEvents('home');
    bindSearchInputEvents('results');

    bindPreferenceControls(el.countSelect);
    bindPreferenceControls(el.prefCount);

    el.prefContent?.addEventListener('change', () => {
      state.prefs.needContent = el.prefContent.checked;
      savePrefs();
      syncPrefControls();
      if (state.view === 'results' && state.query && !state.loading) {
        showToast(state.prefs.needContent ? '已开启网页正文，正在重新搜索…' : '已关闭网页正文，正在重新搜索…', 1800);
        runSearch(state.query, { push: false });
      }
    });

    el.prefOpenMode?.addEventListener('change', () => {
      state.prefs.openInNewTab = el.prefOpenMode.value !== 'same';
      savePrefs();
      syncPrefControls();
      if (state.view === 'results' && !state.loading) renderResultsState();
    });

    el.tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        if (state.loading) return;
        state.filter = tab.dataset.filter || 'all';
        renderResultsState();
      });
    });

    el.themeToggles.forEach((button) => {
      button.addEventListener('click', () => {
        const current = resolveTheme(state.themeChoice);
        applyTheme(current === 'dark' ? 'light' : 'dark');
      });
    });

    el.themeChoiceButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const choice = button.dataset.themeChoice;
        if (choice === 'system' || choice === 'light' || choice === 'dark') {
          applyTheme(choice);
          syncSettingsState();
        }
      });
    });

    el.resultsHomeLink?.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      showHome({ push: true, clearInput: true });
    });

    el.retryConnection?.addEventListener('click', async () => {
      const ok = await refreshStatus();
      if (ok) {
        showToast(state.configured ? '已连接本地搜索服务。' : '已连接本地服务，请先配置 API Key。');
        if (!state.configured) {
          openSettings();
        } else if (state.pendingQuery && state.view === 'results') {
          const pending = state.pendingQuery;
          state.pendingQuery = null;
          runSearch(pending, { push: false });
        }
      } else {
        showToast('仍未连接到本地服务，请确认 npm start 正在运行。');
      }
    });

    el.settingsKeyForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      saveKey();
    });
    el.saveKey?.addEventListener('click', saveKey);
    el.verifyKey?.addEventListener('click', verifyConnection);
    el.clearKey?.addEventListener('click', clearKey);
    el.toggleKeyVisibility?.addEventListener('click', toggleKeyVisibility);
    el.apiKeyInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        saveKey();
      }
    });

    el.settingsDialog?.addEventListener('click', (event) => {
      if (event.target === el.settingsDialog) el.settingsDialog.close();
    });

    $$('[data-example]').forEach((button) => {
      button.addEventListener('click', () => {
        const query = button.dataset.example || '';
        if (!query) return;
        el.settingsDialog?.close();
        const parts = shellParts(activeKind());
        parts.input.value = query;
        updateClearState(activeKind());
        runSearch(query, { push: true });
      });
    });

    // 结果列表内的操作
    el.resultsContent?.addEventListener('click', async (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const expandButton = target.closest('[data-expand]');
      if (expandButton) {
        const panel = document.getElementById(expandButton.getAttribute('aria-controls') || '');
        if (!panel) return;
        const isOpen = expandButton.getAttribute('aria-expanded') === 'true';
        expandButton.setAttribute('aria-expanded', String(!isOpen));
        panel.hidden = isOpen;
        const label = expandButton.querySelector('span');
        if (label) label.textContent = isOpen ? '更多摘要' : '收起摘要';
        return;
      }

      const copyButton = target.closest('[data-copy]');
      if (copyButton) {
        const url = copyButton.getAttribute('data-copy') || '';
        const ok = await copyToClipboard(url);
        showToast(ok ? '链接已复制。' : '复制失败，请手动复制链接。');
      }
    });

    // 全局按钮 / 弹窗动作
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      if (target.closest('[data-open-settings]')) {
        event.preventDefault();
        openSettings();
        return;
      }
      const closeButton = target.closest('[data-close-dialog]');
      if (closeButton) {
        const dialog = closeButton.closest('dialog');
        if (dialog) dialog.close();
        return;
      }
      if (target.closest('[data-retry]')) {
        event.preventDefault();
        retrySearch();
        return;
      }
      if (target.closest('[data-go-home]')) {
        event.preventDefault();
        showHome({ push: true, clearInput: true });
        return;
      }
      if (target.closest('[data-filter-reset]')) {
        state.filter = 'all';
        renderResultsState();
      }
    });

    // 点击搜索框外部时收起建议
    document.addEventListener(
      'pointerdown',
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !target.closest('.search-wrap')) closeSuggestions();
      },
      true,
    );

    // 图片图标加载失败时退化为首字母
    document.addEventListener(
      'error',
      (event) => {
        const image = event.target;
        if (!(image instanceof HTMLImageElement) || !image.hasAttribute('data-favicon')) return;
        const wrapper = image.closest('.favicon');
        if (!wrapper) return;
        image.remove();
        wrapper.textContent = wrapper.dataset.fallback || '?';
      },
      true,
    );

    // 键盘快捷键
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const isTyping =
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select') || target.isContentEditable);
      const dialogOpen = Boolean(document.querySelector('dialog[open]'));

      if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
        if (dialogOpen) return;
        event.preventDefault();
        focusSearch();
        return;
      }

      if (event.key === '/' && !isTyping && !dialogOpen) {
        event.preventDefault();
        focusSearch();
        return;
      }

      if (event.key === 'Escape' && !dialogOpen) {
        closeSuggestions();
      }
    });

    // 浏览器前进 / 后退
    window.addEventListener('popstate', () => {
      const query = readQueryFromUrl();
      if (!query) {
        showHome({ push: false, clearInput: false, restoreQuery: true });
        return;
      }
      if (query === state.query && state.view === 'results' && !state.error && !state.loading) {
        return;
      }

      const cached = state.cache.get(makeCacheKey(query));
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        state.abortController?.abort();
        state.abortController = null;
        state.searchSeq += 1;
        state.query = query;
        state.results = cached.results;
        state.elapsed = cached.elapsed;
        state.loading = false;
        state.error = null;
        state.filter = 'all';
        setView('results');
        el.resultsInput.value = query;
        updateBothClearStates();
        document.title = `${query} - DeepSeek 搜索`;
        window.scrollTo({ top: 0, behavior: 'auto' });
        renderResultsState();
        return;
      }

      runSearch(query, { push: false, initial: true });
    });

    // 跟随系统主题
    try {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        if (state.themeChoice === 'system') {
          const resolved = resolveTheme('system');
          el.html.dataset.theme = resolved;
          updateThemeUI(resolved);
        }
      };
      if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
      else if (typeof media.addListener === 'function') media.addListener(onChange);
    } catch {
      /* 忽略 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function init() {
    applyTheme(state.themeChoice, { persist: false });
    syncPrefControls();
    updateBothClearStates();
    bindEvents();
    await refreshStatus();

    const initialQuery = readQueryFromUrl();
    if (initialQuery) {
      runSearch(initialQuery, { push: false, initial: true });
    } else {
      showHome({ push: false, focus: false });
    }
  }

  init().catch((error) => {
    console.error('[deepseek-search] 初始化失败', error);
    showToast('页面初始化失败，请刷新重试。');
  });
})();
