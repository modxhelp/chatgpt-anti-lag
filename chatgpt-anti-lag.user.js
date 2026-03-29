// ==UserScript==
// @name         ChatGPT Anti-Lag
// @name:ru      ChatGPT Anti-Lag — облегчение длинных чатов
// @namespace    https://chatgpt.com/
// @version      1.2.0
// @description  Makes long ChatGPT chats lighter by hiding or virtualizing old messages, with a compact control panel.
// @description:ru  Уменьшает лаги в длинных чатах ChatGPT: скрывает или виртуализирует старые сообщения и даёт быстрое управление.
// @author       Nikita + ChatGPT
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LS_KEY = 'cg_anti_lag_cfg_v120';
  const UI_ID = 'cg-anti-lag-root';
  const PRIMARY_ARTICLE_SELECTOR = 'article[data-testid^="conversation-turn-"]';
  const FALLBACK_ARTICLE_SELECTOR = '[data-message-author-role]';
  const HARD_SPACER_SELECTOR = '[data-cg-hard-spacer="1"]';

  const defaults = {
    enabled: true,
    mode: 'soft',
    KEEP_OPEN: 4,
    MIN_KEEP: 1,
    MAX_KEEP: 25,
    SOFT_NEAR_BOTTOM_PX: 280,
    HARD_MARGIN_PX: 1800,
    DEBOUNCE_MS: 120,
    MUTATION_DEBOUNCE_MS: 80,
    SCROLL_THROTTLE_MS: 50,
    URL_CHECK_INTERVAL_MS: 1000,
    FALLBACK_TICK_MS: 2500,
    panelCollapsed: false,
  };

  const MODE_LABELS = {
    soft: 'Мягкий',
    hard: 'Жёсткий',
  };

  const state = {
    cfg: loadCfg(),
    ui: null,
    started: false,
    historyPatched: false,
    observer: null,
    scrollElement: null,
    cleanupScrollListener: null,
    articleMap: new Map(),
    nextVirtualId: 1,
    maintenanceTimer: 0,
    fallbackTimer: 0,
    lastUrl: location.href,
    currentChatKey: getChatKey(),
    statusText: 'Ожидание.',
    appliedMode: null,
    softCollapsed: false,
    suppressScrollUntil: 0,
    lastScrollTop: 0,
    lastUserScrollAt: 0,
    lastScrollDirection: 'none',
    stats: {
      totalMessages: 0,
      renderedMessages: 0,
      softHiddenMessages: 0,
      hardSpacerMessages: 0,
      savedPercent: 0,
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

    .cg-soft-hidden {
      display: none !important;
    }

    .cg-hard-spacer {
      display: block !important;
      width: 100% !important;
      min-height: 24px;
      pointer-events: none !important;
      opacity: 0 !important;
      user-select: none !important;
      contain: strict;
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
      max-width: 270px;
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

    #${UI_ID} .cg-btn,
    #${UI_ID} .cg-chip,
    #${UI_ID} .cg-step {
      border: 0;
      color: #f9fafb;
      background: #374151;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      transition: filter 0.14s ease-out, transform 0.14s ease-out;
    }

    #${UI_ID} .cg-btn:hover,
    #${UI_ID} .cg-chip:hover,
    #${UI_ID} .cg-step:hover {
      filter: brightness(1.08);
    }

    #${UI_ID} .cg-btn:active,
    #${UI_ID} .cg-chip:active,
    #${UI_ID} .cg-step:active {
      transform: translateY(1px);
    }

    #${UI_ID} .cg-btn {
      padding: 4px 8px;
      min-height: 24px;
    }

    #${UI_ID} .cg-chip {
      padding: 4px 8px;
      min-height: 24px;
      min-width: 68px;
      text-align: center;
    }

    #${UI_ID} .cg-keep-wrap {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    #${UI_ID} .cg-step {
      width: 22px;
      height: 22px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
    }

    #${UI_ID} .cg-keep-value,
    #${UI_ID} .cg-hidden-value,
    #${UI_ID} .cg-rendered-value {
      min-width: 22px;
      text-align: center;
      font-weight: 700;
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

    #${UI_ID}[data-mode="soft"] .cg-chip {
      background: #2563eb;
    }

    #${UI_ID}[data-mode="hard"] .cg-chip {
      background: #b45309;
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

  function shouldIgnoreScrollEvent() {
    return nowMs() < state.suppressScrollUntil;
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function toInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : fallback;
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
    out.mode = ['soft', 'hard'].includes(out.mode) ? out.mode : defaults.mode;
    out.MIN_KEEP = Math.max(1, toInt(out.MIN_KEEP, defaults.MIN_KEEP));
    out.MAX_KEEP = Math.max(out.MIN_KEEP, toInt(out.MAX_KEEP, defaults.MAX_KEEP));
    out.KEEP_OPEN = clamp(toInt(out.KEEP_OPEN, defaults.KEEP_OPEN), out.MIN_KEEP, out.MAX_KEEP);
    out.SOFT_NEAR_BOTTOM_PX = Math.max(0, toInt(out.SOFT_NEAR_BOTTOM_PX, defaults.SOFT_NEAR_BOTTOM_PX));
    out.HARD_MARGIN_PX = Math.max(400, toInt(out.HARD_MARGIN_PX, defaults.HARD_MARGIN_PX));
    out.DEBOUNCE_MS = Math.max(40, toInt(out.DEBOUNCE_MS, defaults.DEBOUNCE_MS));
    out.MUTATION_DEBOUNCE_MS = Math.max(20, toInt(out.MUTATION_DEBOUNCE_MS, defaults.MUTATION_DEBOUNCE_MS));
    out.SCROLL_THROTTLE_MS = Math.max(16, toInt(out.SCROLL_THROTTLE_MS, defaults.SCROLL_THROTTLE_MS));
    out.URL_CHECK_INTERVAL_MS = Math.max(300, toInt(out.URL_CHECK_INTERVAL_MS, defaults.URL_CHECK_INTERVAL_MS));
    out.FALLBACK_TICK_MS = Math.max(800, toInt(out.FALLBACK_TICK_MS, defaults.FALLBACK_TICK_MS));
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

  function getModeLabel(mode) {
    return MODE_LABELS[mode] || mode;
  }

  function setStatus(text) {
    state.statusText = text || 'Ожидание.';
    if (state.ui?.statusEl) {
      state.ui.statusEl.textContent = state.statusText;
    }
  }

  function isStreaming() {
    return Boolean(document.querySelector('[data-testid="stop-button"]'));
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
    if (node.dataset.cgHardSpacer === '1') return false;
    return true;
  }

  function ensureVirtualIdsForArticles(articles) {
    for (const article of articles) {
      if (!(article instanceof HTMLElement)) continue;

      let id = article.dataset.cgVirtualId;
      if (!id) {
        id = String(state.nextVirtualId++);
        article.dataset.cgVirtualId = id;
      }

      state.articleMap.set(id, article);
    }
  }

  function getConversationNodes() {
    const selector = `${PRIMARY_ARTICLE_SELECTOR}, ${HARD_SPACER_SELECTOR}`;
    const nodes = Array.from(document.querySelectorAll(selector)).filter((node) => node instanceof HTMLElement);

    if (nodes.length) return nodes;

    return Array.from(document.querySelectorAll(`${FALLBACK_ARTICLE_SELECTOR}, ${HARD_SPACER_SELECTOR}`)).filter((node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (node.matches(HARD_SPACER_SELECTOR)) return true;
      return !node.closest('article') || node.closest('article') === node;
    });
  }

  function getRenderedArticles() {
    return getPrimaryArticles();
  }

  function getSoftHiddenNodes() {
    return Array.from(document.querySelectorAll('[data-cg-soft-hidden="1"]'));
  }

  function getHardSpacerNodes() {
    return Array.from(document.querySelectorAll(HARD_SPACER_SELECTOR));
  }

  function refreshStats() {
    const totalMessages = getConversationNodes().length;
    const softHiddenMessages = getSoftHiddenNodes().length;
    const hardSpacerMessages = getHardSpacerNodes().length;
    const renderedMessages = Math.max(0, totalMessages - softHiddenMessages - hardSpacerMessages);
    const savedPercent = totalMessages > 0 ? Math.round(((softHiddenMessages + hardSpacerMessages) / totalMessages) * 100) : 0;

    state.stats.totalMessages = totalMessages;
    state.stats.renderedMessages = renderedMessages;
    state.stats.softHiddenMessages = softHiddenMessages;
    state.stats.hardSpacerMessages = hardSpacerMessages;
    state.stats.savedPercent = savedPercent;
  }

  function findScrollContainer() {
    if (state.scrollElement && state.scrollElement instanceof HTMLElement && state.scrollElement.isConnected) {
      return state.scrollElement;
    }

    const firstMessage = document.querySelector(PRIMARY_ARTICLE_SELECTOR) || document.querySelector(FALLBACK_ARTICLE_SELECTOR);

    if (firstMessage instanceof HTMLElement) {
      let bestCandidate = null;
      let ancestor = firstMessage.parentElement;

      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        const styles = window.getComputedStyle(ancestor);
        const overflowY = styles.overflowY;
        const isScrollableStyle = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
        if (isScrollableStyle) {
          bestCandidate = ancestor;
          if (ancestor.scrollHeight > ancestor.clientHeight + 8) {
            state.scrollElement = ancestor;
            return ancestor;
          }
        }
        ancestor = ancestor.parentElement;
      }

      if (bestCandidate) {
        state.scrollElement = bestCandidate;
        return bestCandidate;
      }
    }

    state.scrollElement = document.scrollingElement || document.documentElement || document.body;
    return state.scrollElement;
  }

  function getViewportMetrics() {
    const scrollElement = findScrollContainer();

    if (
      scrollElement instanceof HTMLElement &&
      scrollElement !== document.body &&
      scrollElement !== document.documentElement
    ) {
      const rect = scrollElement.getBoundingClientRect();
      return {
        top: rect.top,
        height: scrollElement.clientHeight,
      };
    }

    return {
      top: 0,
      height: window.innerHeight,
    };
  }

  function isNearBottom() {
    const scrollElement = findScrollContainer();

    if (
      scrollElement instanceof HTMLElement &&
      scrollElement !== document.body &&
      scrollElement !== document.documentElement
    ) {
      const dist = (scrollElement.scrollHeight - scrollElement.clientHeight) - scrollElement.scrollTop;
      return dist <= state.cfg.SOFT_NEAR_BOTTOM_PX;
    }

    const root = document.scrollingElement || document.documentElement;
    const dist = (root.scrollHeight - root.clientHeight) - root.scrollTop;
    return dist <= state.cfg.SOFT_NEAR_BOTTOM_PX;
  }

  function markSoftHidden(node) {
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.cgSoftHidden === '1') return;
    node.dataset.cgSoftHidden = '1';
    node.classList.add('cg-soft-hidden');
    node.setAttribute('aria-hidden', 'true');
  }

  function unmarkSoftHidden(node) {
    if (!(node instanceof HTMLElement)) return;
    delete node.dataset.cgSoftHidden;
    node.classList.remove('cg-soft-hidden');
    node.removeAttribute('aria-hidden');
  }

  function restoreSoft() {
    for (const node of getSoftHiddenNodes()) {
      unmarkSoftHidden(node);
    }
  }

  function convertArticleToSpacer(article) {
    if (!(article instanceof HTMLElement) || !article.isConnected) return false;

    const id = article.dataset.cgVirtualId;
    if (!id) return false;

    const rect = article.getBoundingClientRect();
    const height = Math.max(24, Math.round(rect.height || article.offsetHeight || 24));

    const spacer = document.createElement('div');
    spacer.className = 'cg-hard-spacer';
    spacer.dataset.cgHardSpacer = '1';
    spacer.dataset.cgVirtualId = id;
    spacer.dataset.cgChatKey = state.currentChatKey;
    spacer.style.height = `${height}px`;

    state.articleMap.set(id, article);
    article.replaceWith(spacer);
    return true;
  }

  function convertSpacerToArticle(spacer) {
    if (!(spacer instanceof HTMLElement) || !spacer.isConnected) return false;

    const id = spacer.dataset.cgVirtualId;
    if (!id) return false;

    const original = state.articleMap.get(id);
    if (!(original instanceof HTMLElement)) return false;
    if (original.isConnected) return false;

    spacer.replaceWith(original);
    return true;
  }

  function restoreHard() {
    const spacers = getHardSpacerNodes();
    for (const spacer of spacers) {
      convertSpacerToArticle(spacer);
    }
  }

  function restoreAllForCurrentChat() {
    suppressScrollReactions(200);
    restoreHard();
    restoreSoft();
    state.softCollapsed = false;
    refreshStats();
    updateUI();
  }

  function getTailProtectedIds(nodes) {
    const ids = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const id = node.dataset.cgVirtualId;
      if (!id) continue;
      ids.push(id);
    }

    return new Set(ids.slice(-state.cfg.KEEP_OPEN));
  }

  function applySoftMode() {
    const articles = getRenderedArticles();
    ensureVirtualIdsForArticles(articles);

    const nearBottom = isNearBottom();
    const userMovedRecently = (nowMs() - state.lastUserScrollAt) < 900;
    const userMovedUp = userMovedRecently && state.lastScrollDirection === 'up';

    if (!nearBottom && state.softCollapsed && userMovedUp) {
      suppressScrollReactions(120);
      restoreSoft();
      state.softCollapsed = false;
      refreshStats();
      setStatus('Мягкий режим: показаны старые сообщения, потому что ты ушёл вверх по чату.');
      return;
    }

    if (!nearBottom && !state.softCollapsed) {
      refreshStats();
      setStatus('Мягкий режим: чат не у нижней границы, старые сообщения оставлены видимыми.');
      return;
    }

    if (!nearBottom && state.softCollapsed) {
      refreshStats();
      setStatus('Мягкий режим: сохранено текущее скрытие, пока не будет явной прокрутки вверх.');
      return;
    }

    const keepFromIndex = Math.max(0, articles.length - state.cfg.KEEP_OPEN);
    suppressScrollReactions(120);

    for (let i = 0; i < articles.length; i += 1) {
      const article = articles[i];
      if (i < keepFromIndex) {
        markSoftHidden(article);
      } else {
        unmarkSoftHidden(article);
      }
    }

    state.softCollapsed = keepFromIndex > 0;
    refreshStats();

    if (state.stats.softHiddenMessages > 0) {
      setStatus(`Мягкий режим: скрыто ${state.stats.softHiddenMessages} старых сообщений.`);
    } else {
      setStatus('Мягкий режим: скрывать пока нечего.');
    }
  }

  function applyHardMode() {
    if (isStreaming()) {
      refreshStats();
      setStatus('Жёсткий режим: ответ ещё генерируется, виртуализация ждёт.');
      return;
    }

    state.softCollapsed = false;

    const articles = getRenderedArticles();
    ensureVirtualIdsForArticles(articles);

    const nodes = getConversationNodes();
    const keepTailIds = getTailProtectedIds(nodes);
    const viewport = getViewportMetrics();

    suppressScrollReactions(120);

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;

      const id = node.dataset.cgVirtualId;
      const isTailProtected = id ? keepTailIds.has(id) : false;
      const rect = node.getBoundingClientRect();
      const relativeTop = rect.top - viewport.top;
      const relativeBottom = rect.bottom - viewport.top;
      const isOutside = relativeBottom < -state.cfg.HARD_MARGIN_PX || relativeTop > viewport.height + state.cfg.HARD_MARGIN_PX;

      if (node.matches(HARD_SPACER_SELECTOR)) {
        if (!isOutside || isTailProtected) {
          convertSpacerToArticle(node);
        }
        continue;
      }

      if (isTailProtected) continue;
      if (isOutside) {
        convertArticleToSpacer(node);
      }
    }

    refreshStats();

    if (state.stats.hardSpacerMessages > 0) {
      setStatus(`Жёсткий режим: виртуализировано ${state.stats.hardSpacerMessages} сообщений.`);
    } else {
      setStatus('Жёсткий режим: пока всё рядом с экраном.');
    }
  }

  function runMaintenance() {
    ensureUI();
    handleRouteChange();
    attachOrUpdateScrollListener();

    if (!state.cfg.enabled) {
      restoreAllForCurrentChat();
      state.appliedMode = null;
      setStatus('Антилаг выключен.');
      updateUI();
      return;
    }

    const mode = state.cfg.mode;

    if (state.appliedMode !== mode) {
      suppressScrollReactions(160);
      if (mode === 'hard') {
        restoreSoft();
        state.softCollapsed = false;
      } else {
        restoreHard();
      }
      state.appliedMode = mode;
    }

    if (mode === 'hard') {
      applyHardMode();
    } else {
      applySoftMode();
    }

    refreshStats();
    updateUI();
  }

  function scheduleMaintenance(delay) {
    window.clearTimeout(state.maintenanceTimer);
    state.maintenanceTimer = window.setTimeout(runMaintenance, typeof delay === 'number' ? delay : state.cfg.DEBOUNCE_MS);
  }

  function handleRouteChange() {
    const currentUrl = location.href;
    const currentChatKey = getChatKey();

    if (currentUrl === state.lastUrl && currentChatKey === state.currentChatKey) return;

    restoreAllForCurrentChat();
    state.articleMap.clear();
    state.nextVirtualId = 1;
    state.appliedMode = null;
    state.lastScrollTop = 0;
    state.lastUserScrollAt = 0;
    state.lastScrollDirection = 'none';
    state.lastUrl = currentUrl;
    state.currentChatKey = currentChatKey;
    setStatus('Открыт другой чат.');
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
    window.setInterval(() => {
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

      if (state.cfg.mode === 'hard') {
        scheduleMaintenance(0);
      } else if (state.cfg.mode === 'soft' && !isNearBottom()) {
        scheduleMaintenance(0);
      }
    });
  }

  function setupScrollTracking(scrollContainer, onScrollChange) {
    let lastCheckTime = 0;
    let frameId = null;

    const getScrollTop = () => {
      if (
        scrollContainer instanceof HTMLElement &&
        scrollContainer !== document.body &&
        scrollContainer !== document.documentElement
      ) {
        return scrollContainer.scrollTop;
      }
      const root = document.scrollingElement || document.documentElement;
      return root.scrollTop;
    };

    state.lastScrollTop = getScrollTop();

    const runCheck = () => {
      const currentTime = nowMs();
      if (currentTime - lastCheckTime < state.cfg.SCROLL_THROTTLE_MS) return;
      lastCheckTime = currentTime;

      const currentScrollTop = getScrollTop();
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
    if (state.observer || !document.body) return;

    const onMutation = debounce(() => {
      attachOrUpdateScrollListener();
      scheduleMaintenance(0);
    }, state.cfg.MUTATION_DEBOUNCE_MS);

    state.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (state.ui?.root && state.ui.root.contains(mutation.target)) continue;
        onMutation();
        break;
      }
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function debounce(fn, wait) {
    let timer = 0;
    return function debounced() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn.apply(this, arguments), wait);
    };
  }

  function ensureUI() {
    if (state.ui?.root?.isConnected) return;

    const root = document.createElement('div');
    root.id = UI_ID;
    if (state.cfg.panelCollapsed) root.classList.add('cg-collapsed');

    root.innerHTML = `
      <div class="cg-pill">
        <div class="cg-lightning" title="ChatGPT Anti-Lag">⚡</div>
        <div class="cg-panel">
          <div class="cg-row">
            <span class="cg-title">Антилаг</span>
            <button class="cg-switch" type="button" aria-label="Включить или выключить Anti-Lag">
              <span class="cg-switch-knob"></span>
            </button>
          </div>

          <div class="cg-row">
            <span class="cg-subtle">Режим</span>
            <button class="cg-chip cg-mode" type="button">Мягкий</button>
          </div>

          <div class="cg-row">
            <span class="cg-subtle">Оставлять</span>
            <span class="cg-keep-wrap">
              <button class="cg-step cg-dec" type="button" aria-label="Уменьшить количество">−</button>
              <span class="cg-keep-value">4</span>
              <button class="cg-step cg-inc" type="button" aria-label="Увеличить количество">+</button>
            </span>
          </div>

          <div class="cg-row">
            <span class="cg-subtle">Скрыто</span>
            <span class="cg-hidden-value">0</span>
          </div>

          <div class="cg-row">
            <span class="cg-subtle">Рендер</span>
            <span class="cg-rendered-value">0</span>
          </div>

          <div class="cg-status">Ожидание.</div>

          <div class="cg-actions">
            <button class="cg-btn cg-restore" type="button">Показать всё</button>
            <button class="cg-btn cg-collapse" type="button">Свернуть</button>
          </div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);

    root.querySelector('.cg-switch').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.cfg.enabled = !state.cfg.enabled;
      saveCfg();
      scheduleMaintenance(0);
    });

    root.querySelector('.cg-mode').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const order = ['soft', 'hard'];
      const idx = order.indexOf(state.cfg.mode);
      state.cfg.mode = order[(idx + 1) % order.length];
      saveCfg();
      state.appliedMode = null;
      state.lastUserScrollAt = 0;
      state.lastScrollDirection = 'none';
      restoreAllForCurrentChat();
      scheduleMaintenance(0);
    });

    root.querySelector('.cg-dec').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = clamp(state.cfg.KEEP_OPEN - 1, state.cfg.MIN_KEEP, state.cfg.MAX_KEEP);
      if (next === state.cfg.KEEP_OPEN) return;
      state.cfg.KEEP_OPEN = next;
      saveCfg();
      state.appliedMode = null;
      state.lastUserScrollAt = 0;
      state.lastScrollDirection = 'none';
      restoreAllForCurrentChat();
      scheduleMaintenance(0);
    });

    root.querySelector('.cg-inc').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = clamp(state.cfg.KEEP_OPEN + 1, state.cfg.MIN_KEEP, state.cfg.MAX_KEEP);
      if (next === state.cfg.KEEP_OPEN) return;
      state.cfg.KEEP_OPEN = next;
      saveCfg();
      state.appliedMode = null;
      state.lastUserScrollAt = 0;
      state.lastScrollDirection = 'none';
      restoreAllForCurrentChat();
      scheduleMaintenance(0);
    });

    root.querySelector('.cg-restore').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.cfg.enabled = false;
      saveCfg();
      state.appliedMode = null;
      state.lastUserScrollAt = 0;
      state.lastScrollDirection = 'none';
      restoreAllForCurrentChat();
      setStatus('Все сообщения показаны. Антилаг выключен.');
      updateUI();
    });

    root.querySelector('.cg-collapse').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.cfg.panelCollapsed = !state.cfg.panelCollapsed;
      saveCfg();
      root.classList.toggle('cg-collapsed', state.cfg.panelCollapsed);
      updateUI();
    });

    root.querySelector('.cg-pill').addEventListener('click', (event) => {
      if (!state.cfg.panelCollapsed) return;
      if (event.target.closest('button')) return;
      state.cfg.panelCollapsed = false;
      saveCfg();
      root.classList.remove('cg-collapsed');
      updateUI();
    });

    state.ui = {
      root,
      modeBtn: root.querySelector('.cg-mode'),
      keepValue: root.querySelector('.cg-keep-value'),
      hiddenValue: root.querySelector('.cg-hidden-value'),
      renderedValue: root.querySelector('.cg-rendered-value'),
      statusEl: root.querySelector('.cg-status'),
      collapseBtn: root.querySelector('.cg-collapse'),
    };

    updateUI();
  }

  function updateUI() {
    if (!state.ui) return;

    refreshStats();
    const hiddenCount = state.stats.softHiddenMessages + state.stats.hardSpacerMessages;

    state.ui.root.setAttribute('data-enabled', state.cfg.enabled ? 'true' : 'false');
    state.ui.root.setAttribute('data-mode', state.cfg.mode);
    state.ui.modeBtn.textContent = getModeLabel(state.cfg.mode);
    state.ui.keepValue.textContent = String(state.cfg.KEEP_OPEN);
    state.ui.hiddenValue.textContent = String(hiddenCount);
    state.ui.renderedValue.textContent = String(state.stats.renderedMessages);
    state.ui.collapseBtn.textContent = state.cfg.panelCollapsed ? 'Развернуть' : 'Свернуть';
    state.ui.statusEl.textContent = state.statusText;

    if (state.cfg.mode === 'soft') {
      state.ui.modeBtn.title = 'Мягкий режим: старые сообщения скрываются только у нижней границы чата.';
    } else {
      state.ui.modeBtn.title = 'Жёсткий режим: сообщения вне экрана заменяются spacers с сохранением высоты.';
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;

    ensureUI();
    patchHistory();
    startObserver();
    attachOrUpdateScrollListener();
    state.appliedMode = null;
    setStatus(`Антилаг включён. Текущий режим: ${getModeLabel(state.cfg.mode)}.`);
    updateUI();

    state.fallbackTimer = window.setInterval(() => {
      scheduleMaintenance(0);
    }, state.cfg.FALLBACK_TICK_MS);

    scheduleMaintenance(200);
    window.setTimeout(() => scheduleMaintenance(0), 1200);
  }

  if (document.body) {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();