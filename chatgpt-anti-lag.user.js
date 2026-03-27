 ==UserScript==
 @name         ChatGPT Anti-Lag — облегчение длинных чатов
 @nameru      ChatGPT Anti-Lag — облегчение длинных чатов
 @namespace    httpschatgpt.com
 @version      1.0.2
 @description  Makes long ChatGPT chats lighter by hiding or archiving old messages, with restore controls and a compact panel.
 @descriptionru  Уменьшает лаги в длинных чатах ChatGPT скрывает или архивирует старые сообщения, оставляя удобную панель управления и быстрое восстановление.
 @author       You
 @match        httpschatgpt.com
 @grant        GM_addStyle
 @run-at       document-idle
 ==UserScript==

(function () {
  'use strict';

  const LS_KEY = 'cg_anti_lag_cfg_v102_ru';

  const defaults = {
    enabled true,
    mode 'auto',                auto  soft  hard
    KEEP_OPEN 3,
    MIN_KEEP 1,
    MAX_KEEP 20,

    DEBOUNCE_MS 220,
    FALLBACK_TICK_MS 2500,
    NEAR_BOTTOM_PX 260,

    AUTO_HARD_TOTAL_MESSAGES 18,
    AUTO_HARD_HIDDEN_MESSAGES 10,

    HARD_ARCHIVE_LIMIT 120,     сколько недавних скрытых сообщений держать в hard-памяти
    panelCollapsed false
  };

  const MODE_LABELS = {
    auto 'Авто',
    soft 'Мягкий',
    hard 'Жёсткий'
  };

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function toInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n)  Math.round(n)  fallback;
  }

  function mergeDefaults(obj) {
    const out = { ...defaults, ...(obj  {}) };

    out.enabled = Boolean(out.enabled);
    out.mode = ['auto', 'soft', 'hard'].includes(out.mode)  out.mode  defaults.mode;
    out.MIN_KEEP = Math.max(1, toInt(out.MIN_KEEP, defaults.MIN_KEEP));
    out.MAX_KEEP = Math.max(out.MIN_KEEP, toInt(out.MAX_KEEP, defaults.MAX_KEEP));
    out.KEEP_OPEN = clamp(toInt(out.KEEP_OPEN, defaults.KEEP_OPEN), out.MIN_KEEP, out.MAX_KEEP);

    out.DEBOUNCE_MS = Math.max(50, toInt(out.DEBOUNCE_MS, defaults.DEBOUNCE_MS));
    out.FALLBACK_TICK_MS = Math.max(800, toInt(out.FALLBACK_TICK_MS, defaults.FALLBACK_TICK_MS));
    out.NEAR_BOTTOM_PX = Math.max(0, toInt(out.NEAR_BOTTOM_PX, defaults.NEAR_BOTTOM_PX));

    out.AUTO_HARD_TOTAL_MESSAGES = Math.max(8, toInt(out.AUTO_HARD_TOTAL_MESSAGES, defaults.AUTO_HARD_TOTAL_MESSAGES));
    out.AUTO_HARD_HIDDEN_MESSAGES = Math.max(4, toInt(out.AUTO_HARD_HIDDEN_MESSAGES, defaults.AUTO_HARD_HIDDEN_MESSAGES));
    out.HARD_ARCHIVE_LIMIT = Math.max(20, toInt(out.HARD_ARCHIVE_LIMIT, defaults.HARD_ARCHIVE_LIMIT));

    out.panelCollapsed = Boolean(out.panelCollapsed);

    return out;
  }

  function loadCfg() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return mergeDefaults(null);
      return mergeDefaults(JSON.parse(raw));
    } catch (e) {
      return mergeDefaults(null);
    }
  }

  function saveCfg() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        enabled cfg.enabled,
        mode cfg.mode,
        KEEP_OPEN cfg.KEEP_OPEN,
        MIN_KEEP cfg.MIN_KEEP,
        MAX_KEEP cfg.MAX_KEEP,
        DEBOUNCE_MS cfg.DEBOUNCE_MS,
        FALLBACK_TICK_MS cfg.FALLBACK_TICK_MS,
        NEAR_BOTTOM_PX cfg.NEAR_BOTTOM_PX,
        AUTO_HARD_TOTAL_MESSAGES cfg.AUTO_HARD_TOTAL_MESSAGES,
        AUTO_HARD_HIDDEN_MESSAGES cfg.AUTO_HARD_HIDDEN_MESSAGES,
        HARD_ARCHIVE_LIMIT cfg.HARD_ARCHIVE_LIMIT,
        panelCollapsed cfg.panelCollapsed
      }));
    } catch (e) {}
  }

  const cfg = loadCfg();

  const state = {
    ui null,
    observer null,
    maintenanceTimer 0,
    started false,
    historyPatched false,
    chatKey getChatKey(),
    hardArchived [],
    statusText 'Ожидание.'
  };

  const css = `
    html, body {
      scroll-behavior auto !important;
      overflow-anchor none !important;
    }

    [data-message-author-role] {
      content-visibility auto;
      contain content;
      contain-intrinsic-size 600px 400px;
    }

    .cg-soft-hidden {
      display none !important;
    }

    .cg-archiver-btn {
      position fixed;
      right 12px;
      bottom 16px;
      z-index 2147483647;
      font-family system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
      font-size 11px;
      line-height 1.25;
      color #f9fafb;
    }

    .cg-archiver-btn  {
      box-sizing border-box;
    }

    .cg-archiver-btn .cg-pill {
      display flex;
      align-items flex-start;
      gap 8px;
      padding 7px 8px;
      border-radius 16px;
      background rgba(17, 24, 39, 0.96);
      box-shadow 0 4px 16px rgba(0, 0, 0, 0.35);
      min-width 214px;
      max-width 250px;
      user-select none;
    }

    .cg-archiver-btn.cg-collapsed .cg-pill {
      min-width auto;
      max-width none;
      padding-right 10px;
      cursor pointer;
    }

    .cg-archiver-btn .cg-lightning {
      width 22px;
      height 22px;
      border-radius 999px;
      display flex;
      align-items center;
      justify-content center;
      background radial-gradient(circle at 30% 30%, #fde68a, #f97316);
      box-shadow 0 0 10px rgba(250, 204, 21, 0.6);
      font-size 14px;
      flex 0 0 auto;
      margin-top 2px;
    }

    .cg-archiver-btn .cg-panel {
      display flex;
      flex-direction column;
      gap 4px;
      min-width 160px;
      width 100%;
    }

    .cg-archiver-btn.cg-collapsed .cg-panel {
      display none;
    }

    .cg-archiver-btn .cg-row {
      display flex;
      align-items center;
      justify-content space-between;
      gap 8px;
      min-height 22px;
    }

    .cg-archiver-btn .cg-title {
      font-weight 700;
      letter-spacing 0.01em;
    }

    .cg-archiver-btn .cg-subtle {
      opacity 0.82;
    }

    .cg-archiver-btn .cg-btn,
    .cg-archiver-btn .cg-chip,
    .cg-archiver-btn .cg-step {
      border 0;
      color #f9fafb;
      background #374151;
      border-radius 999px;
      cursor pointer;
      font inherit;
    }

    .cg-archiver-btn .cg-btnhover,
    .cg-archiver-btn .cg-chiphover,
    .cg-archiver-btn .cg-stephover {
      filter brightness(1.08);
    }

    .cg-archiver-btn .cg-btn {
      padding 4px 8px;
      min-height 24px;
    }

    .cg-archiver-btn .cg-chip {
      padding 4px 8px;
      min-height 24px;
      min-width 68px;
      text-align center;
    }

    .cg-archiver-btn .cg-keep-wrap {
      display inline-flex;
      align-items center;
      gap 4px;
    }

    .cg-archiver-btn .cg-step {
      width 22px;
      height 22px;
      padding 0;
      display inline-flex;
      align-items center;
      justify-content center;
      font-weight 700;
    }

    .cg-archiver-btn .cg-keep-value,
    .cg-archiver-btn .cg-hidden-value {
      min-width 18px;
      text-align center;
      font-weight 700;
    }

    .cg-archiver-btn .cg-status {
      font-size 10px;
      line-height 1.25;
      opacity 0.86;
      padding-top 2px;
      word-break break-word;
    }

    .cg-archiver-btn .cg-actions {
      display flex;
      gap 6px;
      justify-content space-between;
    }

    .cg-archiver-btn .cg-actions .cg-btn {
      flex 1 1 auto;
    }

    .cg-switch {
      position relative;
      width 34px;
      height 18px;
      border-radius 999px;
      border 0;
      padding 2px;
      background #4b5563;
      display inline-flex;
      align-items center;
      cursor pointer;
      transition background 0.18s ease-out, box-shadow 0.18s ease-out;
    }

    .cg-switch-knob {
      width 14px;
      height 14px;
      border-radius 999px;
      background #f9fafb;
      box-shadow 0 1px 3px rgba(0, 0, 0, 0.4);
      transform translateX(0);
      transition transform 0.18s ease-out;
    }

    .cg-archiver-btn[data-enabled=true] .cg-switch {
      background #22c55e;
      box-shadow 0 0 0 1px rgba(34, 197, 94, 0.35);
    }

    .cg-archiver-btn[data-enabled=true] .cg-switch-knob {
      transform translateX(14px);
    }

    .cg-archiver-btn[data-enabled=false] .cg-title {
      opacity 0.65;
    }

    .cg-archiver-btn[data-mode=soft] .cg-chip {
      background #2563eb;
    }

    .cg-archiver-btn[data-mode=hard] .cg-chip {
      background #b45309;
    }

    .cg-archiver-btn[data-mode=auto] .cg-chip {
      background #7c3aed;
    }
  `;

  try {
    GM_addStyle(css);
  } catch (e) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function $(sel, root) {
    return (root  document).querySelector(sel);
  }

  function $all(sel, root) {
    return Array.from((root  document).querySelectorAll(sel));
  }

  function getChatKey() {
    return location.pathname  '';
  }

  function getScrollRoot() {
    return document.scrollingElement  document.documentElement;
  }

  function nearBottom() {
    const d = getScrollRoot();
    const dist = (d.scrollHeight - d.clientHeight) - d.scrollTop;
    return dist  cfg.NEAR_BOTTOM_PX;
  }

  function getModeLabel(mode) {
    return MODE_LABELS[mode]  mode;
  }

  function setStatus(text) {
    state.statusText = text  'Ожидание.';
    if (state.ui.statusEl) {
      state.ui.statusEl.textContent = state.statusText;
    }
  }

  function getAllMessageNodes() {
    return $all('[data-message-author-role]').filter((node) = {
      if (!node  !node.isConnected) return false;
      if (state.ui.root && state.ui.root.contains(node)) return false;
      return true;
    });
  }

  function getActiveMessageNodes() {
    return getAllMessageNodes().filter((node) = {
      if (node.dataset.cgSoftHidden === '1') return false;
      if (node.dataset.cgHardArchived === '1') return false;
      return true;
    });
  }

  function getSoftHiddenNodes() {
    return $all('[data-cg-soft-hidden=1]');
  }

  function getSoftHiddenCount() {
    return getSoftHiddenNodes().length;
  }

  function getHardArchivedItems(chatKey) {
    const key = chatKey  state.chatKey;
    return state.hardArchived.filter((item) = item && item.chatKey === key);
  }

  function getHardHiddenCount() {
    return getHardArchivedItems(state.chatKey).length;
  }

  function getEffectiveMode() {
    if (cfg.mode !== 'auto') return cfg.mode;

    const total = getAllMessageNodes().length + getHardHiddenCount();
    const hiddenSoft = getSoftHiddenCount();

    if (total = cfg.AUTO_HARD_TOTAL_MESSAGES) return 'hard';
    if (hiddenSoft = cfg.AUTO_HARD_HIDDEN_MESSAGES) return 'hard';

    return 'soft';
  }

  function getHiddenCountForMode(mode) {
    if (mode === 'hard') {
      return getHardHiddenCount() + getSoftHiddenCount();
    }
    return getSoftHiddenCount();
  }

  function ensureUI() {
    if (state.ui.root.isConnected) return;

    const root = document.createElement('div');
    root.className = 'cg-archiver-btn';
    if (cfg.panelCollapsed) root.classList.add('cg-collapsed');

    root.innerHTML = `
      div class=cg-pill
        div class=cg-lightning title=ChatGPT Anti-Lag⚡div

        div class=cg-panel
          div class=cg-row
            span class=cg-titleАнтилагspan
            button class=cg-switch type=button aria-label=Включить или выключить Anti-Lag
              span class=cg-switch-knobspan
            button
          div

          div class=cg-row
            span class=cg-subtleРежимspan
            button class=cg-chip cg-mode type=buttonАвтоbutton
          div

          div class=cg-row
            span class=cg-subtleОставлятьspan
            span class=cg-keep-wrap
              button class=cg-step cg-dec type=button aria-label=Уменьшить количество−button
              span class=cg-keep-value3span
              button class=cg-step cg-inc type=button aria-label=Увеличить количество+button
            span
          div

          div class=cg-row
            span class=cg-subtleСкрытоspan
            span class=cg-hidden-value0span
          div

          div class=cg-statusОжидание.div

          div class=cg-actions
            button class=cg-btn cg-restore type=buttonПоказать всёbutton
            button class=cg-btn cg-collapse type=buttonСвернутьbutton
          div
        div
      div
    `;

    document.documentElement.appendChild(root);

    root.querySelector('.cg-switch').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      cfg.enabled = !cfg.enabled;
      saveCfg();
      applyEnabled();
    });

    root.querySelector('.cg-mode').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      const order = ['auto', 'soft', 'hard'];
      const idx = order.indexOf(cfg.mode);
      cfg.mode = order[(idx + 1) % order.length];

      saveCfg();
      restoreCurrentChat();
      updateUI();

      if (cfg.enabled) scheduleMaintenance();
    });

    root.querySelector('.cg-dec').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      const next = clamp(cfg.KEEP_OPEN - 1, cfg.MIN_KEEP, cfg.MAX_KEEP);
      if (next === cfg.KEEP_OPEN) return;

      cfg.KEEP_OPEN = next;
      saveCfg();
      restoreCurrentChat();
      updateUI();

      if (cfg.enabled) scheduleMaintenance();
    });

    root.querySelector('.cg-inc').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      const next = clamp(cfg.KEEP_OPEN + 1, cfg.MIN_KEEP, cfg.MAX_KEEP);
      if (next === cfg.KEEP_OPEN) return;

      cfg.KEEP_OPEN = next;
      saveCfg();
      restoreCurrentChat();
      updateUI();

      if (cfg.enabled) scheduleMaintenance();
    });

    root.querySelector('.cg-restore').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      cfg.enabled = false;
      saveCfg();
      restoreCurrentChat();
      applyEnabled();
      setStatus('Все сообщения показаны. Антилаг выключен.');
    });

    root.querySelector('.cg-collapse').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      cfg.panelCollapsed = !cfg.panelCollapsed;
      saveCfg();

      root.classList.toggle('cg-collapsed', cfg.panelCollapsed);
      updateUI();
    });

    root.querySelector('.cg-pill').addEventListener('click', function (ev) {
      if (!cfg.panelCollapsed) return;
      if (ev.target.closest('button')) return;

      cfg.panelCollapsed = false;
      saveCfg();
      root.classList.remove('cg-collapsed');
      updateUI();
    });

    state.ui = {
      root,
      modeBtn root.querySelector('.cg-mode'),
      keepValue root.querySelector('.cg-keep-value'),
      hiddenValue root.querySelector('.cg-hidden-value'),
      statusEl root.querySelector('.cg-status'),
      collapseBtn root.querySelector('.cg-collapse')
    };

    updateUI();
  }

  function updateUI() {
    if (!state.ui) return;

    const effectiveMode = getEffectiveMode();
    const hiddenCount = getHiddenCountForMode(effectiveMode);

    state.ui.root.setAttribute('data-enabled', cfg.enabled  'true'  'false');
    state.ui.root.setAttribute('data-mode', cfg.mode);

    state.ui.modeBtn.textContent = getModeLabel(cfg.mode);

    if (cfg.mode === 'auto') {
      state.ui.modeBtn.title = `Автоматический режим. Сейчас выбран ${getModeLabel(effectiveMode)}.`;
    } else if (cfg.mode === 'soft') {
      state.ui.modeBtn.title = 'Мягкий режим старые сообщения просто скрываются.';
    } else {
      state.ui.modeBtn.title = 'Жёсткий режим недавние старые сообщения архивируются, а самые старые переводятся в мягтое скрытие.';
    }

    state.ui.keepValue.textContent = String(cfg.KEEP_OPEN);
    state.ui.hiddenValue.textContent = String(hiddenCount);
    state.ui.collapseBtn.textContent = cfg.panelCollapsed  'Развернуть'  'Свернуть';
    state.ui.statusEl.textContent = state.statusText;
  }

  function markSoftHidden(node) {
    if (!node) return;
    node.dataset.cgSoftHidden = '1';
    node.classList.add('cg-soft-hidden');
    node.setAttribute('aria-hidden', 'true');
  }

  function unmarkSoftHidden(node) {
    if (!node) return;
    node.dataset.cgSoftHidden = '';
    node.removeAttribute('data-cg-soft-hidden');
    node.classList.remove('cg-soft-hidden');
    node.removeAttribute('aria-hidden');
  }

  function restoreSoft() {
    const nodes = getSoftHiddenNodes();
    for (const node of nodes) {
      unmarkSoftHidden(node);
    }
  }

  function archiveSoft() {
    const nodes = getActiveMessageNodes();
    const limit = nodes.length - cfg.KEEP_OPEN;
    if (limit = 0) return 0;

    let count = 0;
    for (let i = 0; i  limit; i++) {
      const node = nodes[i];
      if (!node) continue;
      markSoftHidden(node);
      count++;
    }

    return count;
  }

  function hardArchiveNode(node) {
    if (!node  !node.parentNode) return false;

    const placeholder = document.createElement('span');
    placeholder.hidden = true;
    placeholder.style.display = 'none';
    placeholder.dataset.cgPlaceholder = '1';
    placeholder.dataset.cgChatKey = state.chatKey;

    try {
      node.dataset.cgHardArchived = '1';
      node.parentNode.replaceChild(placeholder, node);

      state.hardArchived.push({
        node,
        placeholder,
        chatKey state.chatKey
      });

      return true;
    } catch (e) {
      node.removeAttribute('data-cg-hard-archived');
      return false;
    }
  }

  function archiveHard() {
    const nodes = getActiveMessageNodes();
    const limit = nodes.length - cfg.KEEP_OPEN;
    if (limit = 0) return 0;

    let count = 0;
    for (let i = 0; i  limit; i++) {
      const node = nodes[i];
      if (hardArchiveNode(node)) count++;
    }

    softenOldHardArchived(state.chatKey);
    return count;
  }

  function restoreHard(chatKey) {
    const survivors = [];

    for (const item of state.hardArchived) {
      if (!item) continue;

      if (item.chatKey !== chatKey) {
        survivors.push(item);
        continue;
      }

      try {
        if (item.placeholder && item.placeholder.parentNode) {
          item.placeholder.parentNode.replaceChild(item.node, item.placeholder);
        }
      } catch (e) {}

      if (item.node.removeAttribute) {
        item.node.removeAttribute('data-cg-hard-archived');
      }
    }

    state.hardArchived = survivors;
  }

  function softenOldHardArchived(chatKey) {
    const currentItems = [];
    const otherItems = [];

    for (const item of state.hardArchived) {
      if (!item) continue;
      if (item.chatKey === chatKey) currentItems.push(item);
      else otherItems.push(item);
    }

    if (currentItems.length = cfg.HARD_ARCHIVE_LIMIT) {
      state.hardArchived = [...otherItems, ...currentItems];
      return 0;
    }

    const excess = currentItems.length - cfg.HARD_ARCHIVE_LIMIT;
    const toSoften = currentItems.slice(0, excess);
    const toKeepHard = currentItems.slice(excess);

    let softened = 0;

    for (const item of toSoften) {
      try {
        if (item.placeholder && item.placeholder.parentNode) {
          item.placeholder.parentNode.replaceChild(item.node, item.placeholder);
          item.node.removeAttribute('data-cg-hard-archived');
          markSoftHidden(item.node);
          softened++;
        }
      } catch (e) {}
    }

    state.hardArchived = [...otherItems, ...toKeepHard];

    if (softened  0) {
      setStatus(`Жёсткий кэш переполнен ${softened} старых сообщений переведено в мягкое скрытие.`);
    }

    return softened;
  }

  function restoreCurrentChat() {
    restoreSoft();
    restoreHard(state.chatKey);
    updateUI();
  }

  function handleRouteChange() {
    const nextKey = getChatKey();
    if (nextKey === state.chatKey) return;

    restoreCurrentChat();
    state.hardArchived = state.hardArchived.filter((item) = item.chatKey !== state.chatKey);

    state.chatKey = nextKey;
    setStatus('Открыт другой чат.');
    updateUI();
  }

  function runMaintenance() {
    ensureUI();
    handleRouteChange();

    if (!cfg.enabled) {
      setStatus('Антилаг выключен.');
      updateUI();
      return;
    }

    if (!nearBottom()) {
      setStatus(`Ожидание прокрутка не у нижней границы чата (${getModeLabel(getEffectiveMode())}).`);
      updateUI();
      return;
    }

    const effectiveMode = getEffectiveMode();

    if (effectiveMode === 'hard') {
      const archived = archiveHard();
      if (archived  0) {
        setStatus(`Жёсткий режим скрыто ${archived} сообщений.`);
      } else if (getHardHiddenCount()  0) {
        setStatus('Жёсткий режим активен.');
      } else {
        setStatus('Жёсткий режим изменений нет.');
      }
    } else {
      if (getHardHiddenCount()  0) {
        restoreHard(state.chatKey);
      }
      const hidden = archiveSoft();
      if (hidden  0) {
        setStatus(`Мягкий режим скрыто ${hidden} сообщений.`);
      } else if (getSoftHiddenCount()  0) {
        setStatus('Мягкий режим активен.');
      } else {
        setStatus('Мягкий режим изменений нет.');
      }
    }

    updateUI();
  }

  function scheduleMaintenance() {
    window.clearTimeout(state.maintenanceTimer);
    state.maintenanceTimer = window.setTimeout(runMaintenance, cfg.DEBOUNCE_MS);
  }

  function applyEnabled() {
    ensureUI();

    if (!cfg.enabled) {
      restoreCurrentChat();
      setStatus('Антилаг выключен.');
    } else {
      setStatus(`Антилаг включён. Текущий режим ${getModeLabel(getEffectiveMode())}.`);
      scheduleMaintenance();
    }

    updateUI();
  }

  function patchHistory() {
    if (state.historyPatched) return;
    state.historyPatched = true;

    const fire = () = window.setTimeout(scheduleMaintenance, 0);

    const origPushState = history.pushState;
    history.pushState = function () {
      const ret = origPushState.apply(this, arguments);
      fire();
      return ret;
    };

    const origReplaceState = history.replaceState;
    history.replaceState = function () {
      const ret = origReplaceState.apply(this, arguments);
      fire();
      return ret;
    };

    window.addEventListener('popstate', fire, true);
  }

  function startObserver() {
    if (state.observer  !document.body) return;

    state.observer = new MutationObserver((mutations) = {
      let shouldRun = false;

      for (const m of mutations) {
        if (state.ui.root && state.ui.root.contains(m.target)) continue;
        shouldRun = true;
        break;
      }

      if (shouldRun) {
        scheduleMaintenance();
      }
    });

    state.observer.observe(document.body, {
      childList true,
      subtree true
    });
  }

  function start() {
    if (state.started) return;
    state.started = true;

    ensureUI();
    patchHistory();
    startObserver();
    applyEnabled();

    window.setInterval(runMaintenance, cfg.FALLBACK_TICK_MS);
    window.setTimeout(runMaintenance, 350);
    window.setTimeout(runMaintenance, 1200);
  }

  if (document.body) {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start, { once true });
  }
})();