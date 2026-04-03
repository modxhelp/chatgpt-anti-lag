// ==UserScript==
// @name         ChatGPT Anti-Lag Archive
// @name:ru      ChatGPT Anti-Lag — архиватор длинных чатов
// @namespace    https://chatgpt.com/
// @version      2.0.0
// @description  Archives old ChatGPT messages to IndexedDB and keeps only the latest few messages in the live DOM.
// @description:ru  Архивирует старые сообщения ChatGPT в IndexedDB и оставляет в живом DOM только последние несколько сообщений.
// @author       Nikita + ChatGPT
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LS_KEY = 'cg_anti_lag_archive_cfg_v200';
  const UI_ID = 'cg-anti-lag-archive-root';
  const ARCHIVE_BLOCK_ID = 'cg-archive-block';
  const PRIMARY_ARTICLE_SELECTOR = 'article[data-testid^="conversation-turn-"]';
  const FALLBACK_ARTICLE_SELECTOR = '[data-message-author-role]';
  const ARCHIVE_DB_NAME = 'cgAntiLagArchiveDB';
  const ARCHIVE_DB_VERSION = 1;
  const ARCHIVE_STORE = 'chatArchives';
  const BOOT_RETRY_DELAYS_MS = [600, 1200, 2500, 4000];

  const defaults = {
    enabled: true,
    KEEP_OPEN: 3,
    DEBOUNCE_MS: 120,
    MUTATION_DEBOUNCE_MS: 80,
    SCROLL_THROTTLE_MS: 50,
    URL_CHECK_INTERVAL_MS: 1000,
    panelCollapsed: false,
  };

  const state = {
    cfg: loadCfg(),
    ui: null,
    started: false,
    historyPatched: false,
    observer: null,
    observerRoot: null,
    scrollElement: null,
    cleanupScrollListener: null,
    maintenanceTimer: 0,
    bootRetryTimers: [],
    routeWatchTimer: 0,
    lastUrl: location.href,
    currentChatKey: getChatKey(),
    statusText: 'Ожидание.',
    suppressScrollUntil: 0,
    suppressObserverUntil: 0,
    lastScrollTop: 0,
    lastUserScrollAt: 0,
    lastScrollDirection: 'none',
    lastUiSignature: '',
    runInProgress: false,
    pendingRun: false,
    archive: {
      chatKey: getChatKey(),
      sessionInitialized: false,
      items: [],
      expanded: false,
      blockEl: null,
      inMemoryCount: 0,
    },
    stats: {
      totalMessages: 0,
      liveMessages: 0,
      archivedMessages: 0,
      restoredMessages: 0,
    },
  };

  const css = `
    html, body {
      scroll-behavior: auto !important;
      overflow-anchor: none !important;
    }

    ${PRIMARY_ARTICLE_SELECTOR},
    ${FALLBACK_ARTICLE_SELECTOR} {
      content-visibility: auto;
      contain: content;
      contain-intrinsic-size: 700px 400px;
    }

    .cg-archive-restored {
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.18s ease-out, transform 0.18s ease-out;
    }

    .cg-archive-restored.cg-archive-restored-show {
      opacity: 1;
      transform: translateY(0);
    }

    #${ARCHIVE_BLOCK_ID} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      margin: 14px 0;
      border-radius: 16px;
      background: rgba(17, 24, 39, 0.92);
      color: #f9fafb;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      backdrop-filter: blur(8px);
    }

    #${ARCHIVE_BLOCK_ID} .cg-archive-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    #${ARCHIVE_BLOCK_ID} .cg-archive-title {
      font-weight: 700;
      font-size: 13px;
    }

    #${ARCHIVE_BLOCK_ID} .cg-archive-sub {
      font-size: 12px;
      opacity: 0.8;
      word-break: break-word;
    }

    #${ARCHIVE_BLOCK_ID} .cg-archive-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }

    #${ARCHIVE_BLOCK_ID} .cg-archive-btn {
      border: 0;
      border-radius: 999px;
      padding: 7px 12px;
      background: #374151;
      color: #f9fafb;
      cursor: pointer;
      font: inherit;
      transition: filter 0.14s ease-out, transform 0.14s ease-out;
      white-space: nowrap;
    }

    #${ARCHIVE_BLOCK_ID} .cg-archive-btn:hover {
      filter: brightness(1.08);
    }

    #${ARCHIVE_BLOCK_ID} .cg-archive-btn:active {
      transform: translateY(1px);
    }

    #${UI_ID} {
      position: fixed;
      right: 12px;
      bottom: 16px;
      z-index: 2147483647;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 11px;
      line-height: 1.25;
      color: #f9fafb;
      box-sizing: border-box;
    }

    #${UI_ID} *, #${UI_ID} *::before, #${UI_ID} *::after {
      box-sizing: border-box;
    }

    #${UI_ID} .cg-pill {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px;
      border-radius: 16px;
      background: rgba(17, 24, 39, 0.96);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
      min-width: 238px;
      max-width: 280px;
      user-select: none;
      backdrop-filter: blur(8px);
    }

    #${UI_ID}.cg-collapsed .cg-pill {
      min-width: auto;
      max-width: none;
      padding-right: 10px;
      cursor: pointer;
    }

    #${UI_ID} .cg-lightning {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at 30% 30%, #fde68a, #f97316);
      box-shadow: 0 0 10px rgba(250, 204, 21, 0.55);
      font-size: 14px;
      flex: 0 0 auto;
      margin-top: 2px;
    }

    #${UI_ID} .cg-panel {
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: 176px;
      width: 100%;
    }

    #${UI_ID}.cg-collapsed .cg-panel {
      display: none;
    }

    #${UI_ID} .cg-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 22px;
    }

    #${UI_ID} .cg-title {
      font-weight: 700;
      letter-spacing: 0.01em;
    }

    #${UI_ID} .cg-subtle {
      opacity: 0.82;
    }

    #${UI_ID} .cg-btn {
      border: 0;
      color: #f9fafb;
      background: #374151;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      transition: filter 0.14s ease-out, transform 0.14s ease-out;
      padding: 4px 8px;
      min-height: 24px;
    }

    #${UI_ID} .cg-btn:hover {
      filter: brightness(1.08);
    }

    #${UI_ID} .cg-btn:active {
      transform: translateY(1px);
    }

    #${UI_ID} .cg-status {
      font-size: 10px;
      line-height: 1.3;
      opacity: 0.86;
      padding-top: 2px;
      word-break: break-word;
    }

    #${UI_ID} .cg-actions {
      display: flex;
      gap: 6px;
      justify-content: space-between;
    }

    #${UI_ID} .cg-actions .cg-btn {
      flex: 1 1 auto;
    }

    #${UI_ID} .cg-value {
      min-width: 22px;
      text-align: center;
      font-weight: 700;
    }

    #${UI_ID} .cg-switch {
      position: relative;
      width: 34px;
      height: 18px;
      border-radius: 999px;
      border: 0;
      padding: 2px;
      background: #4b5563;
      display: inline-flex;
      align-items: center;
      cursor: pointer;
      transition: background 0.18s ease-out, box-shadow 0.18s ease-out;
    }

    #${UI_ID} .cg-switch-knob {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: #f9fafb;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
      transform: translateX(0);
      transition: transform 0.18s ease-out;
    }

    #${UI_ID}[data-enabled="true"] .cg-switch {
      background: #22c55e;
      box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.35);
    }

    #${UI_ID}[data-enabled="true"] .cg-switch-knob {
      transform: translateX(14px);
    }

    #${UI_ID}[data-enabled="false"] .cg-title {
      opacity: 0.65;
    }
  `;

  addStyle(css);

  function addStyle(text) {
    try {
      GM_addStyle(text);
      return;
    } catch (error) {}

    const style = document.createElement('style');
    style.textContent = text;
    document.head.appendChild(style);
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function suppressScrollReactions(ms) {
    state.suppressScrollUntil = Math.max(state.suppressScrollUntil, nowMs() + Math.max(0, ms || 0));
  }

  function suppressObserverReactions(ms) {
    state.suppressObserverUntil = Math.max(state.suppressObserverUntil, nowMs() + Math.max(0, ms || 0));
  }

  function shouldIgnoreScrollEvent() {
    return nowMs() < state.suppressScrollUntil;
  }

  function shouldIgnoreObserverEvent() {
    return nowMs() < state.suppressObserverUntil;
  }

  function toInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : fallback;
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function loadCfg() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return mergeDefaults(null);
      return mergeDefaults(JSON.parse(raw));
    } catch (error) {
      return mergeDefaults(null);
    }
  }

  function mergeDefaults(obj) {
    const out = { ...defaults, ...(obj || {}) };
    out.enabled = Boolean(out.enabled);
    out.KEEP_OPEN = clamp(toInt(out.KEEP_OPEN, defaults.KEEP_OPEN), 1, 10);
    out.DEBOUNCE_MS = Math.max(40, toInt(out.DEBOUNCE_MS, defaults.DEBOUNCE_MS));
    out.MUTATION_DEBOUNCE_MS = Math.max(20, toInt(out.MUTATION_DEBOUNCE_MS, defaults.MUTATION_DEBOUNCE_MS));
    out.SCROLL_THROTTLE_MS = Math.max(16, toInt(out.SCROLL_THROTTLE_MS, defaults.SCROLL_THROTTLE_MS));
    out.URL_CHECK_INTERVAL_MS = Math.max(300, toInt(out.URL_CHECK_INTERVAL_MS, defaults.URL_CHECK_INTERVAL_MS));
    out.panelCollapsed = Boolean(out.panelCollapsed);
    return out;
  }

  function saveCfg() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state.cfg));
    } catch (error) {}
  }

  function getChatKey() {
    return `${location.pathname}${location.search}`;
  }

  function setStatus(text) {
    const next = text || 'Ожидание.';
    if (state.statusText === next) return;
    state.statusText = next;
    if (state.ui?.statusEl) {
      state.ui.statusEl.textContent = state.statusText;
    }
  }

  function getPrimaryArticles() {
    const primary = Array.from(document.querySelectorAll(PRIMARY_ARTICLE_SELECTOR)).filter(isUsableMessageNode);
    if (primary.length) return primary;

    const fallback = Array.from(document.querySelectorAll(FALLBACK_ARTICLE_SELECTOR))
      .map((node) => node.closest('article') || node)
      .filter(isUsableMessageNode);

    return uniqueNodes(fallback);
  }

  function uniqueNodes(nodes) {
    const seen = new Set();
    const result = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (seen.has(node)) continue;
      seen.add(node);
      result.push(node);
    }
    return result;
  }

  function isUsableMessageNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (!node.isConnected) return false;
    if (node.closest(`#${UI_ID}`)) return false;
    if (node.id === ARCHIVE_BLOCK_ID) return false;
    if (node.dataset.cgArchiveRestored === '1') return false;
    if (node.dataset.cgArchiveSource === '1') return false;
    return true;
  }

  function getConversationRoot() {
    const firstMessage =
      document.querySelector(PRIMARY_ARTICLE_SELECTOR) ||
      document.querySelector(FALLBACK_ARTICLE_SELECTOR);

    if (firstMessage instanceof HTMLElement) {
      return firstMessage.parentElement || firstMessage.closest('main') || document.querySelector('main') || document.body;
    }

    return document.querySelector('main') || document.body;
  }

  function getConversationNodes() {
    const articles = getPrimaryArticles();
    const restored = getRestoredNodes();
    const block = getArchiveBlock();
    const nodes = [...articles];
    if (block) nodes.push(block);
    if (restored.length) nodes.push(...restored);
    return nodes;
  }

  function getRestoredNodes() {
    return Array.from(document.querySelectorAll('[data-cg-archive-restored="1"]')).filter((node) => node instanceof HTMLElement);
  }

  function getArchiveBlock() {
    const el = document.getElementById(ARCHIVE_BLOCK_ID);
    return el instanceof HTMLElement ? el : null;
  }

  function getVisibleLiveArticles() {
    return getPrimaryArticles().filter((node) => node.dataset.cgArchiveRestored !== '1');
  }

  function getConversationStats() {
    const liveArticles = getVisibleLiveArticles();
    return {
      totalMessages: liveArticles.length + state.archive.items.length,
      liveMessages: liveArticles.length,
      archivedMessages: state.archive.items.length,
      restoredMessages: state.archive.expanded ? getRestoredNodes().length : 0,
    };
  }

  function refreshStats() {
    state.stats = getConversationStats();
  }

  function ensureArchiveIds(articles) {
    let changed = false;
    for (const article of articles) {
      if (!(article instanceof HTMLElement)) continue;
      if (!article.dataset.cgArchiveId) {
        article.dataset.cgArchiveId = String(state.archive.inMemoryCount + 1 + state.archive.items.length);
        state.archive.inMemoryCount += 1;
        changed = true;
      }
    }
    return changed;
  }

  function findScrollContainer() {
    if (state.scrollElement && state.scrollElement instanceof HTMLElement && state.scrollElement.isConnected) {
      return state.scrollElement;
    }

    const firstMessage = document.querySelector(PRIMARY_ARTICLE_SELECTOR) || document.querySelector(FALLBACK_ARTICLE_SELECTOR);
    if (firstMessage instanceof HTMLElement) {
      let ancestor = firstMessage.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        const styles = window.getComputedStyle(ancestor);
        const overflowY = styles.overflowY;
        const isScrollable = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && ancestor.scrollHeight > ancestor.clientHeight + 8;
        if (isScrollable) {
          state.scrollElement = ancestor;
          return ancestor;
        }
        ancestor = ancestor.parentElement;
      }
    }

    state.scrollElement = document.scrollingElement || document.documentElement || document.body;
    return state.scrollElement;
  }

  function isMeaningfulMutationNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (state.ui?.root && state.ui.root.contains(node)) return false;
    if (node.id === ARCHIVE_BLOCK_ID) return false;

    return Boolean(
      node.matches?.(PRIMARY_ARTICLE_SELECTOR) ||
      node.matches?.(FALLBACK_ARTICLE_SELECTOR) ||
      node.querySelector?.(PRIMARY_ARTICLE_SELECTOR) ||
      node.querySelector?.(FALLBACK_ARTICLE_SELECTOR)
    );
  }

  function getScrollTop(scrollContainer) {
    if (
      scrollContainer instanceof HTMLElement &&
      scrollContainer !== document.body &&
      scrollContainer !== document.documentElement
    ) {
      return scrollContainer.scrollTop;
    }
    const root = document.scrollingElement || document.documentElement;
    return root.scrollTop;
  }

  function debounce(fn, wait) {
    let timer = 0;
    return function debounced() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn.apply(this, arguments), wait);
    };
  }

  function openArchiveDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(ARCHIVE_DB_NAME, ARCHIVE_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ARCHIVE_STORE)) {
          db.createObjectStore(ARCHIVE_STORE, { keyPath: 'chatKey' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
    });
  }

  async function withArchiveStore(mode, handler) {
    const db = await openArchiveDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ARCHIVE_STORE, mode);
      const store = tx.objectStore(ARCHIVE_STORE);
      let settled = false;

      function finishOk(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }

      function finishErr(error) {
        if (settled) return;
        settled = true;
        reject(error);
      }

      tx.onabort = () => finishErr(tx.error || new Error('Archive transaction aborted'));
      tx.onerror = () => finishErr(tx.error || new Error('Archive transaction failed'));

      Promise.resolve(handler(store, finishOk, finishErr)).catch(finishErr);
    }).finally(() => {
      db.close();
    });
  }

  async function readArchiveRecord(chatKey) {
    return withArchiveStore('readonly', (store, finishOk, finishErr) => {
      const req = store.get(chatKey);
      req.onsuccess = () => finishOk(req.result || null);
      req.onerror = () => finishErr(req.error || new Error('Failed to read archive record'));
    });
  }

  async function writeArchiveRecord(record) {
    return withArchiveStore('readwrite', (store, finishOk, finishErr) => {
      const req = store.put(record);
      req.onsuccess = () => finishOk(record);
      req.onerror = () => finishErr(req.error || new Error('Failed to write archive record'));
    });
  }

  async function clearArchiveRecord(chatKey) {
    return withArchiveStore('readwrite', (store, finishOk, finishErr) => {
      const req = store.delete(chatKey);
      req.onsuccess = () => finishOk();
      req.onerror = () => finishErr(req.error || new Error('Failed to clear archive record'));
    });
  }

  async function ensureArchiveSessionReady() {
    if (state.archive.sessionInitialized && state.archive.chatKey === state.currentChatKey) {
      return;
    }

    state.archive = {
      chatKey: state.currentChatKey,
      sessionInitialized: true,
      items: [],
      expanded: false,
      blockEl: null,
      inMemoryCount: 0,
    };

    try {
      await clearArchiveRecord(state.currentChatKey);
    } catch (error) {
      console.warn('[ChatGPT Anti-Lag Archive] Failed to reset archive record:', error);
    }
  }

  function createArchiveBlock() {
    const block = document.createElement('div');
    block.id = ARCHIVE_BLOCK_ID;
    block.innerHTML = `
      <div class="cg-archive-meta">
        <div class="cg-archive-title">Архив старых сообщений</div>
        <div class="cg-archive-sub">Старые сообщения выгружены из DOM и сохранены локально.</div>
      </div>
      <div class="cg-archive-actions">
        <button class="cg-archive-btn cg-archive-toggle" type="button">Показать</button>
      </div>
    `;

    block.querySelector('.cg-archive-toggle').addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (state.archive.expanded) {
        hideArchivedMessages();
        scheduleMaintenance(0);
      } else {
        await showArchivedMessages();
      }
    });

    return block;
  }

  function updateArchiveBlock() {
    const block = state.archive.blockEl || getArchiveBlock();
    if (!(block instanceof HTMLElement)) return;

    const titleEl = block.querySelector('.cg-archive-title');
    const subEl = block.querySelector('.cg-archive-sub');
    const btn = block.querySelector('.cg-archive-toggle');

    const count = state.archive.items.length;
    if (titleEl) {
      titleEl.textContent = state.archive.expanded
        ? `Архив показан: ${count} ${pluralRu(count, ['сообщение', 'сообщения', 'сообщений'])}`
        : `Скрыто ${count} ${pluralRu(count, ['сообщение', 'сообщения', 'сообщений'])}`;
    }

    if (subEl) {
      subEl.textContent = state.archive.expanded
        ? 'Показаны HTML-снимки старых сообщений из локального архива.'
        : 'Старые сообщения выгружены из DOM и сохранены локально в IndexedDB.';
    }

    if (btn) {
      btn.textContent = state.archive.expanded ? 'Скрыть' : 'Показать';
    }
  }

  function ensureArchiveBlock() {
    if (state.archive.items.length === 0) {
      removeArchiveBlock();
      return;
    }

    let block = getArchiveBlock();
    if (!(block instanceof HTMLElement)) {
      block = createArchiveBlock();
      state.archive.blockEl = block;
    } else {
      state.archive.blockEl = block;
    }

    const liveArticles = getVisibleLiveArticles();
    const anchor = liveArticles[0] || null;

    if (anchor && block !== anchor.previousSibling) {
      anchor.parentNode.insertBefore(block, anchor);
    } else if (!anchor && !block.isConnected) {
      const root = getConversationRoot();
      root?.prepend(block);
    }

    updateArchiveBlock();
  }

  function removeArchiveBlock() {
    const block = getArchiveBlock();
    if (block && block.isConnected) {
      block.remove();
    }
    state.archive.blockEl = null;
  }

  async function persistArchiveState() {
    const record = {
      chatKey: state.currentChatKey,
      items: state.archive.items,
      updatedAt: Date.now(),
    };

    try {
      await writeArchiveRecord(record);
    } catch (error) {
      console.warn('[ChatGPT Anti-Lag Archive] Failed to persist archive state:', error);
    }
  }

  function serializeArticle(article) {
    const id = article.dataset.cgArchiveId || String(Date.now()) + Math.random().toString(36).slice(2);
    article.dataset.cgArchiveId = id;

    return {
      id,
      html: article.outerHTML,
      savedAt: Date.now(),
    };
  }

  async function archiveOldMessages() {
    if (state.archive.expanded) {
      setStatus('Архив показан. Скрытие старых сообщений временно приостановлено.');
      ensureArchiveBlock();
      return;
    }

    const articles = getVisibleLiveArticles();
    ensureArchiveIds(articles);

    const keepLive = Math.max(1, state.cfg.KEEP_OPEN);
    const archiveCount = Math.max(0, articles.length - keepLive);
    if (archiveCount === 0) {
      refreshStats();
      setStatus('Архивировать пока нечего.');
      ensureArchiveBlock();
      return;
    }

    const toArchive = articles.slice(0, archiveCount);
    const newItems = [];

    suppressScrollReactions(140);
    suppressObserverReactions(140);

    for (const article of toArchive) {
      if (!(article instanceof HTMLElement) || !article.isConnected) continue;
      newItems.push(serializeArticle(article));
      article.remove();
    }

    if (newItems.length > 0) {
      state.archive.items.push(...newItems);
      await persistArchiveState();
    }

    refreshStats();
    ensureArchiveBlock();
    setStatus(`В архив выгружено ${state.archive.items.length} ${pluralRu(state.archive.items.length, ['сообщение', 'сообщения', 'сообщений'])}.`);
  }

  function parseHtmlSnapshots(items) {
    const fragment = document.createDocumentFragment();
    const restoredNodes = [];

    for (const item of items) {
      if (!item || typeof item.html !== 'string') continue;

      const tpl = document.createElement('template');
      tpl.innerHTML = item.html.trim();
      const node = tpl.content.firstElementChild;
      if (!(node instanceof HTMLElement)) continue;

      node.dataset.cgArchiveRestored = '1';
      node.classList.add('cg-archive-restored');
      fragment.appendChild(node);
      restoredNodes.push(node);
    }

    return { fragment, restoredNodes };
  }

  async function showArchivedMessages() {
    if (state.archive.expanded) return;
    if (state.archive.items.length === 0) return;

    ensureArchiveBlock();

    const block = state.archive.blockEl || getArchiveBlock();
    if (!(block instanceof HTMLElement)) return;

    const { fragment, restoredNodes } = parseHtmlSnapshots(state.archive.items);
    if (!restoredNodes.length) return;

    suppressScrollReactions(140);
    suppressObserverReactions(140);

    block.after(fragment);
    state.archive.expanded = true;
    updateArchiveBlock();
    refreshStats();
    setStatus(`Архив показан: ${restoredNodes.length} ${pluralRu(restoredNodes.length, ['сообщение', 'сообщения', 'сообщений'])}.`);

    requestAnimationFrame(() => {
      for (const node of restoredNodes) {
        node.classList.add('cg-archive-restored-show');
      }
    });

    updateUI();
  }

  function hideArchivedMessages() {
    const restoredNodes = getRestoredNodes();
    if (!restoredNodes.length) {
      state.archive.expanded = false;
      updateArchiveBlock();
      refreshStats();
      updateUI();
      return;
    }

    suppressScrollReactions(120);
    suppressObserverReactions(120);

    for (const node of restoredNodes) {
      node.remove();
    }

    state.archive.expanded = false;
    updateArchiveBlock();
    refreshStats();
    setStatus(`Архив снова скрыт: ${state.archive.items.length} ${pluralRu(state.archive.items.length, ['сообщение', 'сообщения', 'сообщений'])}.`);
    updateUI();
  }

  async function disableAndRestoreAll() {
    suppressScrollReactions(160);
    suppressObserverReactions(160);

    if (!state.archive.expanded && state.archive.items.length) {
      await showArchivedMessages();
    }

    removeArchiveBlock();

    try {
      await clearArchiveRecord(state.currentChatKey);
    } catch (error) {
      console.warn('[ChatGPT Anti-Lag Archive] Failed to clear current archive on disable:', error);
    }

    state.archive.items = [];
    state.archive.expanded = false;
    state.archive.blockEl = null;
    refreshStats();
    setStatus('Архиватор выключен. Все доступные сообщения показаны.');
    updateUI();
  }

  async function runMaintenance() {
    if (state.runInProgress) {
      state.pendingRun = true;
      return;
    }

    state.runInProgress = true;

    try {
      ensureUI();
      handleRouteChange();
      attachOrUpdateScrollListener();
      startObserver();
      await ensureArchiveSessionReady();

      if (!state.cfg.enabled) {
        await disableAndRestoreAll();
        return;
      }

      ensureArchiveBlock();
      await archiveOldMessages();
      refreshStats();
      updateUI();
    } catch (error) {
      console.error('[ChatGPT Anti-Lag Archive] Maintenance failed:', error);
      setStatus('Произошла ошибка архиватора. Открой консоль для деталей.');
      updateUI();
    } finally {
      state.runInProgress = false;

      if (state.pendingRun) {
        state.pendingRun = false;
        scheduleMaintenance(0);
      }
    }
  }

  function scheduleMaintenance(delay) {
    window.clearTimeout(state.maintenanceTimer);
    state.maintenanceTimer = window.setTimeout(() => {
      void runMaintenance();
    }, typeof delay === 'number' ? delay : state.cfg.DEBOUNCE_MS);
  }

  function handleRouteChange() {
    const currentUrl = location.href;
    const currentChatKey = getChatKey();
    if (currentUrl === state.lastUrl && currentChatKey === state.currentChatKey) return;

    removeArchiveBlock();
    hideArchivedMessages();

    state.lastUrl = currentUrl;
    state.currentChatKey = currentChatKey;
    state.scrollElement = null;
    state.archive = {
      chatKey: currentChatKey,
      sessionInitialized: false,
      items: [],
      expanded: false,
      blockEl: null,
      inMemoryCount: 0,
    };
    setStatus('Открыт другой чат. Архив будет собран заново.');
    updateUI();
  }

  function patchHistory() {
    if (state.historyPatched) return;
    state.historyPatched = true;

    const fire = () => window.setTimeout(() => scheduleMaintenance(0), 0);

    const origPushState = history.pushState;
    history.pushState = function pushStatePatched() {
      const result = origPushState.apply(this, arguments);
      fire();
      return result;
    };

    const origReplaceState = history.replaceState;
    history.replaceState = function replaceStatePatched() {
      const result = origReplaceState.apply(this, arguments);
      fire();
      return result;
    };

    window.addEventListener('popstate', fire, true);

    state.routeWatchTimer = window.setInterval(() => {
      if (location.href !== state.lastUrl) {
        fire();
      }
    }, state.cfg.URL_CHECK_INTERVAL_MS);
  }

  function attachOrUpdateScrollListener() {
    const container = findScrollContainer();
    if (!container) return;

    if (container === state.scrollElement && state.cleanupScrollListener) {
      return;
    }

    if (state.cleanupScrollListener) {
      state.cleanupScrollListener();
      state.cleanupScrollListener = null;
    }

    state.scrollElement = container;
    state.cleanupScrollListener = setupScrollTracking(container, () => {
      if (!state.cfg.enabled) return;
      if (state.archive.expanded) return;
      scheduleMaintenance(0);
    });
  }

  function setupScrollTracking(scrollContainer, onScrollChange) {
    let lastCheckTime = 0;
    let frameId = null;

    state.lastScrollTop = getScrollTop(scrollContainer);

    const runCheck = () => {
      const currentTime = nowMs();
      if (currentTime - lastCheckTime < state.cfg.SCROLL_THROTTLE_MS) return;
      lastCheckTime = currentTime;

      const currentScrollTop = getScrollTop(scrollContainer);
      const delta = currentScrollTop - state.lastScrollTop;

      if (!shouldIgnoreScrollEvent()) {
        if (Math.abs(delta) > 1) {
          state.lastScrollDirection = delta < 0 ? 'up' : 'down';
          state.lastUserScrollAt = currentTime;
        } else {
          state.lastScrollDirection = 'none';
        }
      }

      state.lastScrollTop = currentScrollTop;
      onScrollChange();
    };

    const handleScroll = () => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        runCheck();
      });
    };

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }

  function startObserver() {
    const root = getConversationRoot();
    if (!root) return;

    if (state.observer && state.observerRoot === root && root.isConnected) {
      return;
    }

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
      state.observerRoot = null;
    }

    const onMutation = debounce((mutations) => {
      if (shouldIgnoreObserverEvent()) return;

      let meaningful = false;

      for (const mutation of mutations) {
        if (state.ui?.root && state.ui.root.contains(mutation.target)) continue;

        for (const node of mutation.addedNodes) {
          if (isMeaningfulMutationNode(node)) {
            meaningful = true;
            break;
          }
        }

        if (meaningful) break;

        for (const node of mutation.removedNodes) {
          if (isMeaningfulMutationNode(node)) {
            meaningful = true;
            break;
          }
        }

        if (meaningful) break;
      }

      if (!meaningful) return;

      attachOrUpdateScrollListener();
      scheduleMaintenance(0);
    }, state.cfg.MUTATION_DEBOUNCE_MS);

    state.observer = new MutationObserver((mutations) => {
      onMutation(mutations);
    });

    state.observer.observe(root, {
      childList: true,
      subtree: true,
    });

    state.observerRoot = root;
  }

  function startBootRetries() {
    for (const delay of BOOT_RETRY_DELAYS_MS) {
      const timer = window.setTimeout(() => {
        scheduleMaintenance(0);
      }, delay);
      state.bootRetryTimers.push(timer);
    }
  }

  function pluralRu(n, forms) {
    const value = Math.abs(Number(n)) % 100;
    const num = value % 10;
    if (value > 10 && value < 20) return forms[2];
    if (num > 1 && num < 5) return forms[1];
    if (num === 1) return forms[0];
    return forms[2];
  }

  function ensureUI() {
    if (state.ui?.root?.isConnected) return;

    const root = document.createElement('div');
    root.id = UI_ID;
    if (state.cfg.panelCollapsed) root.classList.add('cg-collapsed');

    root.innerHTML = `
      <div class="cg-pill">
        <div class="cg-lightning" title="ChatGPT Anti-Lag Archive">🧊</div>
        <div class="cg-panel">
          <div class="cg-row">
            <span class="cg-title">Архиватор</span>
            <button class="cg-switch" type="button" aria-label="Включить или выключить архиватор">
              <span class="cg-switch-knob"></span>
            </button>
          </div>

          <div class="cg-row">
            <span class="cg-subtle">Живых</span>
            <span class="cg-value">${state.cfg.KEEP_OPEN}</span>
          </div>

          <div class="cg-row">
            <span class="cg-subtle">В архиве</span>
            <span class="cg-value cg-archived-value">0</span>
          </div>

          <div class="cg-row">
            <span class="cg-subtle">Показано</span>
            <span class="cg-value cg-live-value">0</span>
          </div>

          <div class="cg-status">Ожидание.</div>

          <div class="cg-actions">
            <button class="cg-btn cg-toggle-archive" type="button">Показать архив</button>
            <button class="cg-btn cg-collapse" type="button">Свернуть</button>
          </div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);

    root.querySelector('.cg-switch').addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.cfg.enabled = !state.cfg.enabled;
      saveCfg();
      state.lastUiSignature = '';
      scheduleMaintenance(0);
    });

    root.querySelector('.cg-toggle-archive').addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (state.archive.expanded) {
        hideArchivedMessages();
        scheduleMaintenance(0);
      } else {
        await showArchivedMessages();
      }
    });

    root.querySelector('.cg-collapse').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.cfg.panelCollapsed = !state.cfg.panelCollapsed;
      saveCfg();
      state.lastUiSignature = '';
      root.classList.toggle('cg-collapsed', state.cfg.panelCollapsed);
      updateUI();
    });

    root.querySelector('.cg-pill').addEventListener('click', (event) => {
      if (!state.cfg.panelCollapsed) return;
      if (event.target.closest('button')) return;
      state.cfg.panelCollapsed = false;
      saveCfg();
      state.lastUiSignature = '';
      root.classList.remove('cg-collapsed');
      updateUI();
    });

    state.ui = {
      root,
      archivedValue: root.querySelector('.cg-archived-value'),
      liveValue: root.querySelector('.cg-live-value'),
      statusEl: root.querySelector('.cg-status'),
      toggleArchiveBtn: root.querySelector('.cg-toggle-archive'),
      collapseBtn: root.querySelector('.cg-collapse'),
    };

    updateUI();
  }

  function updateUI() {
    if (!state.ui) return;

    refreshStats();

    const signature = [
      state.cfg.enabled ? 1 : 0,
      state.stats.archivedMessages,
      state.stats.liveMessages,
      state.archive.expanded ? 1 : 0,
      state.statusText,
      state.cfg.panelCollapsed ? 1 : 0,
    ].join('|');

    if (signature === state.lastUiSignature) return;
    state.lastUiSignature = signature;

    state.ui.root.setAttribute('data-enabled', state.cfg.enabled ? 'true' : 'false');
    state.ui.archivedValue.textContent = String(state.stats.archivedMessages);
    state.ui.liveValue.textContent = String(state.stats.liveMessages);
    state.ui.statusEl.textContent = state.statusText;
    state.ui.toggleArchiveBtn.textContent = state.archive.expanded ? 'Скрыть архив' : 'Показать архив';
    state.ui.collapseBtn.textContent = state.cfg.panelCollapsed ? 'Развернуть' : 'Свернуть';
  }

  function start() {
    if (state.started) return;
    state.started = true;

    ensureUI();
    patchHistory();
    startObserver();
    attachOrUpdateScrollListener();
    setStatus(`Архиватор включён. В DOM будут оставаться последние ${state.cfg.KEEP_OPEN} сообщения.`);
    updateUI();

    scheduleMaintenance(200);
    window.setTimeout(() => scheduleMaintenance(0), 1200);
    startBootRetries();
  }

  if (document.body) {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
