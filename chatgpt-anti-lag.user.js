// ==UserScript==
// @name         ChatGPT Anti-Lag Archive
// @name:ru      ChatGPT Anti-Lag — архиватор длинных чатов
// @namespace    https://chatgpt.com/
// @version      3.0.0
// @description  Keeps recent ChatGPT turns live and stores older static snapshots efficiently in IndexedDB.
// @description:ru  Оставляет последние пары сообщений ChatGPT в DOM, а старые статические снимки эффективно хранит в IndexedDB.
// @author       Nikita + ChatGPT
// @license      MIT
// @homepageURL  https://github.com/modxhelp/chatgpt-anti-lag
// @supportURL   https://github.com/modxhelp/chatgpt-anti-lag/issues
// @updateURL    https://raw.githubusercontent.com/modxhelp/chatgpt-anti-lag/main/chatgpt-anti-lag.user.js
// @downloadURL  https://raw.githubusercontent.com/modxhelp/chatgpt-anti-lag/main/chatgpt-anti-lag.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_addStyle
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP = Object.freeze({
    name: 'ChatGPT Anti-Lag Archive',
    logPrefix: '[ChatGPT Anti-Lag]',
    version: '3.0.0',
  });

  const DOM = Object.freeze({
    uiId: 'cg-anti-lag-v3-root',
    archiveBlockId: 'cg-anti-lag-v3-archive',
    primaryMessageSelector: 'article[data-testid^="conversation-turn-"]',
    fallbackRoleSelector: '[data-message-author-role]',
    restoredSelector: '[data-cg-archive-restored="1"]',
  });

  const STORAGE = Object.freeze({
    configKey: 'cg_anti_lag_archive_cfg_v300',
    legacyConfigKey: 'cg_anti_lag_archive_cfg_v200',
    cleanupKey: 'cg_anti_lag_archive_last_cleanup_v300',
    dbName: 'cgAntiLagArchiveDB',
    dbVersion: 2,
    chatsStore: 'chats',
    messagesStore: 'messages',
    legacyStore: 'chatArchives',
    indexByChat: 'byChat',
    indexByChatSequence: 'byChatSequence',
  });

  const LIMITS = Object.freeze({
    minKeepPairs: 2,
    maxKeepPairs: 30,
    minRestoreBatch: 10,
    maxRestoreBatch: 100,
    maxChats: 30,
    maxArchiveBytes: 150 * 1024 * 1024,
    maxChatBytes: 80 * 1024 * 1024,
    archiveTtlMs: 45 * 24 * 60 * 60 * 1000,
    cleanupIntervalMs: 24 * 60 * 60 * 1000,
    maxSequence: Number.MAX_SAFE_INTEGER,
    minSequence: Number.MIN_SAFE_INTEGER,
  });

  const defaults = Object.freeze({
    enabled: true,
    keepPairs: 6,
    restoreBatch: 20,
    archiveBatch: 24,
    panelCollapsed: false,
    maintenanceDelayMs: 280,
    routeCheckIntervalMs: 1000,
  });

  const state = {
    cfg: loadConfig(),
    started: false,
    sessionEpoch: 0,
    currentChatKey: getChatKey(),
    lastUrl: location.href,
    dbPromise: null,
    observer: null,
    observerRoot: null,
    maintenanceTimer: 0,
    routeTimer: 0,
    runInProgress: false,
    pendingRun: false,
    ignoreMutationsUntil: 0,
    ui: null,
    statusText: 'Инициализация…',
    lastUiSignature: '',
    archive: createEmptyArchiveState(getChatKey()),
    channel: null,
  };

  const css = `
    ${DOM.primaryMessageSelector} {
      content-visibility: auto;
      contain-intrinsic-size: auto 600px;
    }

    #${DOM.archiveBlockId} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin: 14px 0;
      padding: 11px 14px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      border-radius: 16px;
      background: rgba(248, 250, 252, 0.94);
      background: color-mix(in srgb, Canvas 92%, transparent);
      color: #0f172a;
      color: CanvasText;
      box-shadow: 0 8px 26px rgba(0, 0, 0, 0.12);
      backdrop-filter: blur(10px);
      overflow-anchor: auto;
    }

    #${DOM.archiveBlockId} .cg-al-meta {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }

    #${DOM.archiveBlockId} .cg-al-title {
      font-size: 13px;
      font-weight: 700;
    }

    #${DOM.archiveBlockId} .cg-al-subtitle {
      font-size: 12px;
      opacity: 0.72;
      line-height: 1.35;
    }

    #${DOM.archiveBlockId} .cg-al-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 7px;
      flex-wrap: wrap;
      flex: 0 0 auto;
    }

    #${DOM.archiveBlockId} button,
    #${DOM.uiId} button {
      border: 0;
      border-radius: 999px;
      padding: 6px 10px;
      font: inherit;
      cursor: pointer;
      color: #f8fafc;
      background: #334155;
      transition: filter 120ms ease, transform 120ms ease;
    }

    #${DOM.archiveBlockId} button:hover,
    #${DOM.uiId} button:hover {
      filter: brightness(1.1);
    }

    #${DOM.archiveBlockId} button:active,
    #${DOM.uiId} button:active {
      transform: translateY(1px);
    }

    #${DOM.archiveBlockId} button:disabled,
    #${DOM.uiId} button:disabled {
      cursor: default;
      opacity: 0.5;
      filter: none;
    }

    ${DOM.restoredSelector} {
      content-visibility: auto;
      contain-intrinsic-size: auto 600px;
      animation: cg-al-fade-in 150ms ease-out both;
    }

    ${DOM.restoredSelector} button,
    ${DOM.restoredSelector} [role="button"] {
      pointer-events: none !important;
      opacity: 0.62;
    }

    @keyframes cg-al-fade-in {
      from { opacity: 0; transform: translateY(5px); }
      to { opacity: 1; transform: translateY(0); }
    }

    #${DOM.uiId} {
      position: fixed;
      right: 12px;
      bottom: 16px;
      z-index: 2147483647;
      box-sizing: border-box;
      color: #f8fafc;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 11px;
      line-height: 1.3;
    }

    #${DOM.uiId} *,
    #${DOM.uiId} *::before,
    #${DOM.uiId} *::after {
      box-sizing: border-box;
    }

    #${DOM.uiId} .cg-al-panel-shell {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      min-width: 250px;
      max-width: 310px;
      padding: 9px;
      border-radius: 17px;
      background: rgba(15, 23, 42, 0.96);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.32);
      backdrop-filter: blur(10px);
      user-select: none;
    }

    #${DOM.uiId}.cg-al-collapsed .cg-al-panel-shell {
      min-width: auto;
      max-width: none;
      cursor: pointer;
    }

    #${DOM.uiId} .cg-al-icon {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 30%, #fde68a, #f97316);
      box-shadow: 0 0 12px rgba(249, 115, 22, 0.5);
      font-size: 14px;
    }

    #${DOM.uiId} .cg-al-panel {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 100%;
      min-width: 190px;
    }

    #${DOM.uiId}.cg-al-collapsed .cg-al-panel {
      display: none;
    }

    #${DOM.uiId} .cg-al-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 22px;
    }

    #${DOM.uiId} .cg-al-title {
      font-weight: 750;
      letter-spacing: 0.01em;
    }

    #${DOM.uiId} .cg-al-muted {
      opacity: 0.76;
    }

    #${DOM.uiId} .cg-al-value {
      min-width: 44px;
      text-align: right;
      font-weight: 700;
    }

    #${DOM.uiId} .cg-al-stepper {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    #${DOM.uiId} .cg-al-stepper button {
      width: 24px;
      height: 22px;
      padding: 0;
    }

    #${DOM.uiId} .cg-al-stepper-value {
      min-width: 20px;
      text-align: center;
      font-weight: 700;
    }

    #${DOM.uiId} .cg-al-switch {
      position: relative;
      display: inline-flex;
      align-items: center;
      width: 36px;
      height: 20px;
      padding: 2px;
      background: #475569;
    }

    #${DOM.uiId} .cg-al-switch-knob {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #f8fafc;
      box-shadow: 0 1px 3px rgba(0,0,0,.4);
      transform: translateX(0);
      transition: transform 160ms ease;
    }

    #${DOM.uiId}[data-enabled="true"] .cg-al-switch {
      background: #16a34a;
    }

    #${DOM.uiId}[data-enabled="true"] .cg-al-switch-knob {
      transform: translateX(16px);
    }

    #${DOM.uiId} .cg-al-status {
      padding-top: 2px;
      font-size: 10px;
      opacity: 0.82;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    #${DOM.uiId} .cg-al-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }

    #${DOM.uiId} .cg-al-actions button {
      padding: 5px 7px;
      font-size: 10px;
    }

    @media (max-width: 680px) {
      #${DOM.archiveBlockId} {
        align-items: flex-start;
        flex-direction: column;
      }

      #${DOM.archiveBlockId} .cg-al-actions {
        justify-content: flex-start;
      }

      #${DOM.uiId} {
        right: 8px;
        bottom: 10px;
      }
    }
  `;

  addStyle(css);

  function addStyle(text) {
    try {
      if (typeof GM_addStyle === 'function') {
        GM_addStyle(text);
        return;
      }
    } catch (error) {
      logWarn('GM_addStyle недоступен:', error);
    }

    const style = document.createElement('style');
    style.textContent = text;
    (document.head || document.documentElement).appendChild(style);
  }

  function createEmptyArchiveState(chatKey) {
    return {
      chatKey,
      loaded: false,
      entries: [],
      entryByKey: new Map(),
      entriesBySequence: new Map(),
      totalBytes: 0,
      restoredCount: 0,
      restoreBeforeKey: null,
      blockEl: null,
      loadingBatch: false,
    };
  }

  function loadConfig() {
    try {
      const current = localStorage.getItem(STORAGE.configKey);
      if (current) return normalizeConfig(JSON.parse(current));

      const legacy = localStorage.getItem(STORAGE.legacyConfigKey);
      if (legacy) {
        const parsed = JSON.parse(legacy);
        const keepOpen = Number(parsed?.KEEP_OPEN);
        return normalizeConfig({
          enabled: parsed?.enabled,
          keepPairs: Number.isFinite(keepOpen) ? Math.max(2, Math.ceil(keepOpen / 2)) : defaults.keepPairs,
          panelCollapsed: parsed?.panelCollapsed,
        });
      }
    } catch (error) {
      logWarn('Не удалось прочитать настройки:', error);
    }

    return normalizeConfig(null);
  }

  function normalizeConfig(input) {
    const cfg = { ...defaults, ...(input || {}) };
    cfg.enabled = Boolean(cfg.enabled);
    cfg.keepPairs = clamp(toInteger(cfg.keepPairs, defaults.keepPairs), LIMITS.minKeepPairs, LIMITS.maxKeepPairs);
    cfg.restoreBatch = clamp(toInteger(cfg.restoreBatch, defaults.restoreBatch), LIMITS.minRestoreBatch, LIMITS.maxRestoreBatch);
    cfg.archiveBatch = clamp(toInteger(cfg.archiveBatch, defaults.archiveBatch), 10, 80);
    cfg.panelCollapsed = Boolean(cfg.panelCollapsed);
    cfg.maintenanceDelayMs = Math.max(100, toInteger(cfg.maintenanceDelayMs, defaults.maintenanceDelayMs));
    cfg.routeCheckIntervalMs = Math.max(500, toInteger(cfg.routeCheckIntervalMs, defaults.routeCheckIntervalMs));
    return cfg;
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE.configKey, JSON.stringify(state.cfg));
    } catch (error) {
      logWarn('Не удалось сохранить настройки:', error);
    }
  }

  function toInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function logWarn() {
    console.warn(APP.logPrefix, ...arguments);
  }

  function logError() {
    console.error(APP.logPrefix, ...arguments);
  }

  function getChatKey() {
    const match = location.pathname.match(/(?:^|\/)c\/([^/?#]+)/i);
    if (match?.[1]) return `chat:${match[1]}`;

    const shareMatch = location.pathname.match(/(?:^|\/)share\/([^/?#]+)/i);
    if (shareMatch?.[1]) return `share:${shareMatch[1]}`;

    return null;
  }

  function getLiveMessages() {
    const primary = Array.from(document.querySelectorAll(DOM.primaryMessageSelector));
    if (primary.length) return uniqueUsableMessages(primary);

    const fallback = Array.from(document.querySelectorAll(DOM.fallbackRoleSelector)).map((node) => {
      return node.closest('article') || node;
    });
    return uniqueUsableMessages(fallback);
  }

  function uniqueUsableMessages(nodes) {
    const result = [];
    const seen = new Set();

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (!node.isConnected) continue;
      if (node.closest(`#${DOM.uiId}`)) continue;
      if (node.id === DOM.archiveBlockId) continue;
      if (node.dataset.cgArchiveRestored === '1') continue;
      if (seen.has(node)) continue;
      seen.add(node);
      result.push(node);
    }

    return result;
  }

  function getRestoredNodes() {
    return Array.from(document.querySelectorAll(DOM.restoredSelector)).filter((node) => node instanceof HTMLElement);
  }

  function getConversationRoot() {
    const first = getLiveMessages()[0] || document.querySelector(DOM.restoredSelector);
    if (first instanceof HTMLElement) {
      return first.closest('main') || first.parentElement || document.querySelector('main') || document.body;
    }
    return document.querySelector('main') || document.body;
  }

  function getMessageParent() {
    const firstLive = getLiveMessages()[0];
    if (firstLive?.parentElement) return firstLive.parentElement;

    const restored = getRestoredNodes()[0];
    if (restored?.parentElement) return restored.parentElement;

    return getConversationRoot();
  }

  function getRole(article) {
    return article.querySelector(DOM.fallbackRoleSelector)?.getAttribute('data-message-author-role') ||
      article.getAttribute('data-message-author-role') ||
      'unknown';
  }

  function describeMessage(article, domIndex) {
    const testId = article.getAttribute('data-testid') || '';
    const turnMatch = testId.match(/conversation-turn-(\d+)/i);
    const messageIdNode = article.matches('[data-message-id]') ? article : article.querySelector('[data-message-id]');
    const nativeMessageId = messageIdNode?.getAttribute('data-message-id') || '';
    const role = getRole(article);
    const sequence = turnMatch ? Number(turnMatch[1]) : domIndex;
    const sequenceSource = turnMatch ? 'testid' : 'dom';

    let messageKey;
    if (nativeMessageId) {
      messageKey = `id:${nativeMessageId}`;
    } else {
      const fingerprintSource = `${testId}|${role}|${normalizeText(article.textContent || '').slice(0, 3000)}`;
      messageKey = `turn:${testId || sequence}:${hashString(fingerprintSource)}`;
    }

    return {
      article,
      messageKey,
      sequence,
      sequenceSource,
      role,
      testId,
      nativeMessageId,
    };
  }

  function normalizeText(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function hashString(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function makeRecordId(chatKey, messageKey) {
    return `${chatKey}\u0000${messageKey}`;
  }

  function serializeMessage(descriptor) {
    const clone = descriptor.article.cloneNode(true);
    sanitizeElementTree(clone);
    clone.removeAttribute('data-cg-archive-restored');
    clone.removeAttribute('data-cg-static-snapshot');

    const html = clone.outerHTML;
    const byteSize = byteLength(html);
    const preview = normalizeText(descriptor.article.textContent || '').slice(0, 180);

    return {
      id: makeRecordId(state.currentChatKey, descriptor.messageKey),
      chatKey: state.currentChatKey,
      messageKey: descriptor.messageKey,
      sequence: descriptor.sequence,
      sequenceSource: descriptor.sequenceSource,
      role: descriptor.role,
      html,
      preview,
      byteSize,
      archivedAt: Date.now(),
      schemaVersion: 1,
    };
  }

  function sanitizeElementTree(root) {
    if (!(root instanceof Element)) return;

    root.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv="refresh"]').forEach((node) => node.remove());
    const elements = [root, ...root.querySelectorAll('*')];

    for (const element of elements) {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc') {
          element.removeAttribute(attribute.name);
          continue;
        }
        if ((name === 'href' || name === 'src' || name === 'xlink:href') && value.startsWith('javascript:')) {
          element.removeAttribute(attribute.name);
        }
      }
    }
  }

  function byteLength(value) {
    try {
      return new Blob([value]).size;
    } catch (error) {
      return String(value).length * 2;
    }
  }

  function isGeneratingResponse() {
    return Boolean(
      document.querySelector('[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label*="Stop" i]') ||
      document.querySelector('button[aria-label*="Останов" i]')
    );
  }

  function openDb() {
    if (state.dbPromise) return state.dbPromise;

    state.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(STORAGE.dbName, STORAGE.dbVersion);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (db.objectStoreNames.contains(STORAGE.legacyStore)) {
          db.deleteObjectStore(STORAGE.legacyStore);
        }

        if (!db.objectStoreNames.contains(STORAGE.chatsStore)) {
          db.createObjectStore(STORAGE.chatsStore, { keyPath: 'chatKey' });
        }

        let messages;
        if (!db.objectStoreNames.contains(STORAGE.messagesStore)) {
          messages = db.createObjectStore(STORAGE.messagesStore, { keyPath: 'id' });
        } else {
          messages = request.transaction.objectStore(STORAGE.messagesStore);
        }

        if (!messages.indexNames.contains(STORAGE.indexByChat)) {
          messages.createIndex(STORAGE.indexByChat, 'chatKey', { unique: false });
        }
        if (!messages.indexNames.contains(STORAGE.indexByChatSequence)) {
          messages.createIndex(
            STORAGE.indexByChatSequence,
            ['chatKey', 'sequence', 'messageKey'],
            { unique: false }
          );
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          state.dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        state.dbPromise = null;
        reject(request.error || new Error('Не удалось открыть IndexedDB'));
      };

      request.onblocked = () => {
        logWarn('Обновление IndexedDB заблокировано другой вкладкой.');
      };
    });

    return state.dbPromise;
  }

  async function readChatMeta(chatKey) {
    if (!chatKey) return null;
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE.chatsStore, 'readonly');
      const request = tx.objectStore(STORAGE.chatsStore).get(chatKey);
      let result = null;

      request.onsuccess = () => {
        result = request.result || null;
      };
      request.onerror = () => reject(request.error || new Error('Не удалось прочитать метаданные архива'));
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Транзакция чтения архива отменена'));
      tx.onerror = () => reject(tx.error || new Error('Ошибка транзакции чтения архива'));
    });
  }

  async function writeArchiveChanges(recordsToPut, idsToDelete, nextMeta) {
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORAGE.messagesStore, STORAGE.chatsStore], 'readwrite');
      const messages = tx.objectStore(STORAGE.messagesStore);
      const chats = tx.objectStore(STORAGE.chatsStore);

      for (const id of idsToDelete) messages.delete(id);
      for (const record of recordsToPut) messages.put(record);

      if (nextMeta.entries.length > 0) {
        chats.put(nextMeta);
      } else {
        chats.delete(nextMeta.chatKey);
      }

      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Запись архива отменена'));
      tx.onerror = () => reject(tx.error || new Error('Ошибка записи архива'));
    });
  }

  async function readMessageBatch(chatKey, beforeKey, limit) {
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE.messagesStore, 'readonly');
      const store = tx.objectStore(STORAGE.messagesStore);
      const index = store.index(STORAGE.indexByChatSequence);
      const lower = [chatKey, LIMITS.minSequence, ''];
      const upper = beforeKey || [chatKey, LIMITS.maxSequence, '\uffff'];
      const range = IDBKeyRange.bound(lower, upper, false, Boolean(beforeKey));
      const request = index.openCursor(range, 'prev');
      const records = [];
      let oldestIndexKey = null;

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || records.length >= limit) return;

        records.push(cursor.value);
        oldestIndexKey = cursor.key;
        if (records.length < limit) cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('Не удалось прочитать сообщения архива'));
      tx.oncomplete = () => resolve({
        records: records.reverse(),
        nextBeforeKey: oldestIndexKey,
      });
      tx.onabort = () => reject(tx.error || new Error('Чтение сообщений архива отменено'));
      tx.onerror = () => reject(tx.error || new Error('Ошибка чтения сообщений архива'));
    });
  }

  async function listChatMetas() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE.chatsStore, 'readonly');
      const request = tx.objectStore(STORAGE.chatsStore).getAll();
      let records = [];

      request.onsuccess = () => {
        records = Array.isArray(request.result) ? request.result : [];
      };
      request.onerror = () => reject(request.error || new Error('Не удалось получить список архивов'));
      tx.oncomplete = () => resolve(records);
      tx.onabort = () => reject(tx.error || new Error('Чтение списка архивов отменено'));
      tx.onerror = () => reject(tx.error || new Error('Ошибка чтения списка архивов'));
    });
  }

  async function deleteChatArchive(chatKey) {
    if (!chatKey) return;
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORAGE.messagesStore, STORAGE.chatsStore], 'readwrite');
      const messages = tx.objectStore(STORAGE.messagesStore);
      const byChat = messages.index(STORAGE.indexByChat);
      const cursorRequest = byChat.openKeyCursor(IDBKeyRange.only(chatKey));

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        messages.delete(cursor.primaryKey);
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error || new Error('Не удалось очистить сообщения чата'));
      tx.objectStore(STORAGE.chatsStore).delete(chatKey);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Очистка архива отменена'));
      tx.onerror = () => reject(tx.error || new Error('Ошибка очистки архива'));
    });
  }

  async function deleteAllArchives() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORAGE.messagesStore, STORAGE.chatsStore], 'readwrite');
      tx.objectStore(STORAGE.messagesStore).clear();
      tx.objectStore(STORAGE.chatsStore).clear();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Очистка всех архивов отменена'));
      tx.onerror = () => reject(tx.error || new Error('Ошибка очистки всех архивов'));
    });
  }

  async function withChatLock(chatKey, callback) {
    if (!chatKey || !navigator.locks?.request) return callback();
    return navigator.locks.request(`cg-anti-lag:${chatKey}`, { mode: 'exclusive' }, callback);
  }

  function metaFromEntries(chatKey, entries, previousMeta) {
    const sorted = entries.slice().sort(compareEntries);
    const totalBytes = sorted.reduce((sum, entry) => sum + Math.max(0, Number(entry.byteSize) || 0), 0);
    const now = Date.now();

    return {
      chatKey,
      schemaVersion: 1,
      createdAt: previousMeta?.createdAt || now,
      updatedAt: now,
      count: sorted.length,
      totalBytes,
      entries: sorted,
    };
  }

  function compareEntries(a, b) {
    const sequenceDiff = Number(a.sequence) - Number(b.sequence);
    if (sequenceDiff !== 0) return sequenceDiff;
    return String(a.messageKey).localeCompare(String(b.messageKey));
  }

  function toMetaEntry(record) {
    return {
      id: record.id,
      messageKey: record.messageKey,
      sequence: record.sequence,
      sequenceSource: record.sequenceSource,
      role: record.role,
      byteSize: record.byteSize,
      archivedAt: record.archivedAt,
    };
  }

  function applyMeta(meta) {
    const safeEntries = Array.isArray(meta?.entries) ? meta.entries.slice().sort(compareEntries) : [];
    state.archive.entries = safeEntries;
    state.archive.entryByKey = new Map(safeEntries.map((entry) => [entry.messageKey, entry]));
    state.archive.entriesBySequence = new Map();

    for (const entry of safeEntries) {
      const key = Number(entry.sequence);
      const group = state.archive.entriesBySequence.get(key) || [];
      group.push(entry);
      state.archive.entriesBySequence.set(key, group);
    }

    state.archive.totalBytes = Number(meta?.totalBytes) || safeEntries.reduce((sum, entry) => sum + (entry.byteSize || 0), 0);
    state.archive.loaded = true;
  }

  async function ensureArchiveLoaded(epoch) {
    const chatKey = state.currentChatKey;
    if (!chatKey) return;
    if (state.archive.loaded && state.archive.chatKey === chatKey) return;

    const meta = await readChatMeta(chatKey);
    if (epoch !== state.sessionEpoch || chatKey !== state.currentChatKey) return;
    applyMeta(meta);
    setStatus(meta?.entries?.length ? `Локальный архив восстановлен: ${meta.entries.length}.` : 'Архив текущего чата пуст.');
    ensureArchiveBlock();
    updateUI();
  }

  function createArchiveBlock() {
    const block = document.createElement('div');
    block.id = DOM.archiveBlockId;
    block.innerHTML = `
      <div class="cg-al-meta">
        <div class="cg-al-title">Локальный архив</div>
        <div class="cg-al-subtitle">Старые сообщения сохранены как статические снимки.</div>
      </div>
      <div class="cg-al-actions">
        <button class="cg-al-show" type="button">Показать</button>
        <button class="cg-al-more" type="button" hidden>Ещё</button>
        <button class="cg-al-hide" type="button" hidden>Скрыть</button>
      </div>
    `;

    block.querySelector('.cg-al-show').addEventListener('click', () => void restoreOlderBatch());
    block.querySelector('.cg-al-more').addEventListener('click', () => void restoreOlderBatch());
    block.querySelector('.cg-al-hide').addEventListener('click', () => hideRestoredSnapshots());
    return block;
  }

  function ensureArchiveBlock() {
    if (!state.cfg.enabled || !state.currentChatKey || state.archive.entries.length === 0) {
      removeArchiveBlock();
      return;
    }

    let block = document.getElementById(DOM.archiveBlockId);
    if (!(block instanceof HTMLElement)) block = createArchiveBlock();
    state.archive.blockEl = block;

    const live = getLiveMessages();
    const restored = getRestoredNodes();
    const anchor = restored[0] || live[0] || null;

    if (anchor?.parentNode && (block.parentNode !== anchor.parentNode || block.nextSibling !== anchor)) {
      anchor.parentNode.insertBefore(block, anchor);
    } else if (!block.isConnected) {
      getMessageParent()?.prepend(block);
    }

    updateArchiveBlock();
  }

  function updateArchiveBlock() {
    const block = state.archive.blockEl || document.getElementById(DOM.archiveBlockId);
    if (!(block instanceof HTMLElement)) return;

    const count = state.archive.entries.length;
    const remaining = Math.max(0, count - state.archive.restoredCount);
    const title = block.querySelector('.cg-al-title');
    const subtitle = block.querySelector('.cg-al-subtitle');
    const show = block.querySelector('.cg-al-show');
    const more = block.querySelector('.cg-al-more');
    const hide = block.querySelector('.cg-al-hide');

    title.textContent = `В архиве ${count} ${pluralRu(count, ['сообщение', 'сообщения', 'сообщений'])} · ${formatBytes(state.archive.totalBytes)}`;
    subtitle.textContent = state.archive.restoredCount > 0
      ? `Показано ${state.archive.restoredCount}; осталось ${remaining}. Снимки статические, ссылки доступны, кнопки отключены.`
      : 'Сообщения удалены из DOM и сохранены локально. Загружайте их небольшими порциями.';

    show.hidden = state.archive.restoredCount > 0;
    show.disabled = state.archive.loadingBatch || count === 0;
    show.textContent = `Показать ${Math.min(state.cfg.restoreBatch, remaining)}`;

    more.hidden = state.archive.restoredCount === 0 || remaining === 0;
    more.disabled = state.archive.loadingBatch;
    more.textContent = `Ещё ${Math.min(state.cfg.restoreBatch, remaining)}`;

    hide.hidden = state.archive.restoredCount === 0;
    hide.disabled = state.archive.loadingBatch;
  }

  function removeArchiveBlock() {
    const block = document.getElementById(DOM.archiveBlockId);
    if (block) block.remove();
    state.archive.blockEl = null;
  }

  async function restoreOlderBatch() {
    if (state.archive.loadingBatch || state.archive.entries.length === 0) return;
    const chatKey = state.currentChatKey;
    const epoch = state.sessionEpoch;
    state.archive.loadingBatch = true;
    updateArchiveBlock();
    updateUI();

    try {
      const result = await readMessageBatch(
        chatKey,
        state.archive.restoreBeforeKey,
        state.cfg.restoreBatch
      );
      if (epoch !== state.sessionEpoch || chatKey !== state.currentChatKey) return;
      if (!result.records.length) {
        state.archive.restoredCount = state.archive.entries.length;
        setStatus('Все доступные архивные сообщения уже показаны.');
        return;
      }

      ensureArchiveBlock();
      const block = state.archive.blockEl;
      if (!(block instanceof HTMLElement)) return;

      const parsed = parseSnapshotRecords(result.records);
      if (!parsed.nodes.length) return;

      await mutateWithScrollAnchor(() => {
        block.after(parsed.fragment);
      }, getRestoredNodes()[0] || getLiveMessages()[0] || null);

      state.archive.restoreBeforeKey = result.nextBeforeKey;
      state.archive.restoredCount += parsed.nodes.length;
      setStatus(`Показано ${state.archive.restoredCount} из ${state.archive.entries.length} архивных сообщений.`);
    } catch (error) {
      logError('Не удалось показать архив:', error);
      setStatus('Ошибка чтения локального архива.');
    } finally {
      state.archive.loadingBatch = false;
      updateArchiveBlock();
      updateUI();
    }
  }

  function parseSnapshotRecords(records) {
    const fragment = document.createDocumentFragment();
    const nodes = [];

    for (const record of records) {
      if (!record || typeof record.html !== 'string') continue;
      const template = document.createElement('template');
      template.innerHTML = record.html.trim();
      const node = template.content.firstElementChild;
      if (!(node instanceof HTMLElement)) continue;

      sanitizeElementTree(node);
      node.dataset.cgArchiveRestored = '1';
      node.dataset.cgStaticSnapshot = '1';
      node.dataset.cgArchiveMessageKey = record.messageKey;
      fragment.appendChild(node);
      nodes.push(node);
    }

    return { fragment, nodes };
  }

  async function hideRestoredSnapshots() {
    const nodes = getRestoredNodes();
    if (!nodes.length) {
      resetRestoreState();
      return;
    }

    const anchor = getLiveMessages()[0] || null;
    await mutateWithScrollAnchor(() => {
      for (const node of nodes) node.remove();
    }, anchor);

    resetRestoreState();
    setStatus(`Архив снова скрыт: ${state.archive.entries.length}.`);
    ensureArchiveBlock();
    updateUI();
  }

  function resetRestoreState() {
    state.archive.restoredCount = 0;
    state.archive.restoreBeforeKey = null;
    updateArchiveBlock();
  }

  async function archiveMaintenance(epoch) {
    const chatKey = state.currentChatKey;
    if (!chatKey || !state.cfg.enabled) return;
    if (state.archive.restoredCount > 0) {
      setStatus('Архив раскрыт; автоматическая выгрузка временно приостановлена.');
      return;
    }
    if (isGeneratingResponse()) {
      setStatus('Ответ генерируется; архивирование продолжится после завершения.');
      scheduleMaintenance(1200);
      return;
    }

    await withChatLock(chatKey, async () => {
      const freshMeta = await readChatMeta(chatKey);
      if (epoch !== state.sessionEpoch || chatKey !== state.currentChatKey) return;
      applyMeta(freshMeta);

      const articles = getLiveMessages();
      if (!articles.length) {
        ensureArchiveBlock();
        return;
      }

      const descriptors = articles.map((article, index) => describeMessage(article, index));
      const archiveCount = computeArchiveCount(descriptors, state.cfg.keepPairs);
      const allCandidates = descriptors.slice(0, archiveCount);
      const candidates = allCandidates.slice(0, state.cfg.archiveBatch);
      const kept = descriptors.slice(archiveCount);
      const entries = state.archive.entries.slice();
      const entriesByKey = new Map(entries.map((entry) => [entry.messageKey, entry]));
      const entriesByStableSequence = new Map();
      for (const entry of entries) {
        if (entry.sequenceSource !== 'testid') continue;
        const sequence = Number(entry.sequence);
        const group = entriesByStableSequence.get(sequence) || [];
        group.push(entry);
        entriesByStableSequence.set(sequence, group);
      }
      const deleteIds = new Set();
      const putRecords = [];

      // Если пользователь увеличил число живых пар, оригинальные DOM-узлы
      // становятся источником истины, а их старые снимки удаляются из архива.
      for (const descriptor of kept) {
        const archived = entriesByKey.get(descriptor.messageKey);
        if (archived) deleteIds.add(archived.id);
      }

      // При переключении ветки ответа удаляем снимок с тем же conversation-turn,
      // если у нового сообщения другой стабильный ключ.
      for (const descriptor of descriptors) {
        if (descriptor.sequenceSource !== 'testid') continue;
        const sameSequenceEntries = entriesByStableSequence.get(Number(descriptor.sequence)) || [];
        for (const entry of sameSequenceEntries) {
          if (entry.messageKey !== descriptor.messageKey) deleteIds.add(entry.id);
        }
      }

      for (const descriptor of candidates) {
        if (entriesByKey.has(descriptor.messageKey) && !deleteIds.has(entriesByKey.get(descriptor.messageKey).id)) {
          continue;
        }
        const record = serializeMessage(descriptor);
        putRecords.push(record);
      }

      let nextEntries = entries.filter((entry) => !deleteIds.has(entry.id));
      const nextByKey = new Map(nextEntries.map((entry) => [entry.messageKey, entry]));
      const acceptedPutRecords = [];
      let skippedByLimit = 0;
      let projectedBytes = nextEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.byteSize) || 0), 0);

      for (const record of putRecords) {
        const previous = nextByKey.get(record.messageKey);
        if (previous) {
          nextEntries = nextEntries.filter((entry) => entry.id !== previous.id);
          deleteIds.add(previous.id);
          projectedBytes -= Math.max(0, Number(previous.byteSize) || 0);
        }

        if (projectedBytes + record.byteSize > LIMITS.maxChatBytes) {
          skippedByLimit += 1;
          continue;
        }

        const metaEntry = toMetaEntry(record);
        nextEntries.push(metaEntry);
        nextByKey.set(metaEntry.messageKey, metaEntry);
        acceptedPutRecords.push(record);
        projectedBytes += record.byteSize;
      }

      const nextMeta = metaFromEntries(chatKey, nextEntries, freshMeta);
      const hasDbChanges = acceptedPutRecords.length > 0 || deleteIds.size > 0;

      if (hasDbChanges) {
        try {
          await writeArchiveChanges(acceptedPutRecords, Array.from(deleteIds), nextMeta);
        } catch (error) {
          if (isQuotaError(error)) {
            setStatus('Недостаточно места в IndexedDB. Сообщения оставлены в чате.');
          }
          throw error;
        }
      }

      if (epoch !== state.sessionEpoch || chatKey !== state.currentChatKey) return;
      applyMeta(hasDbChanges ? nextMeta : freshMeta);

      const removableCandidates = candidates.filter((descriptor) => state.archive.entryByKey.has(descriptor.messageKey));
      if (removableCandidates.length > 0) {
        const anchor = kept[0]?.article || null;
        ignoreMutations(500);
        await mutateWithScrollAnchor(() => {
          for (const descriptor of removableCandidates) {
            if (descriptor.article.isConnected) descriptor.article.remove();
          }
          ensureArchiveBlock();
        }, anchor);
      } else {
        ensureArchiveBlock();
      }

      if (hasDbChanges) broadcastArchiveChange(chatKey);
      const archived = state.archive.entries.length;
      const remainingToArchive = Math.max(0, allCandidates.length - removableCandidates.length);
      if (skippedByLimit > 0) {
        setStatus(`Достигнут лимит архива чата ${formatBytes(LIMITS.maxChatBytes)}. ${skippedByLimit} ${pluralRu(skippedByLimit, ['сообщение оставлено', 'сообщения оставлены', 'сообщений оставлены'])} в DOM.`);
      } else {
        setStatus(remainingToArchive > 0
          ? `Архивирую пакетами: сохранено ${archived}, осталось обработать около ${remainingToArchive}.`
          : archived > 0
            ? `В DOM оставлено до ${state.cfg.keepPairs} пар; в архиве ${archived}.`
            : `В DOM оставлено до ${state.cfg.keepPairs} пар; архив пока пуст.`);
      }
      if (remainingToArchive > 0 && skippedByLimit === 0) scheduleMaintenance(60);
    });
  }

  function computeArchiveCount(descriptors, keepPairs) {
    const keepMessages = Math.max(2, Number(keepPairs) * 2);
    let cut = Math.max(0, descriptors.length - keepMessages);
    if (cut <= 0) return 0;

    // Стараемся оставить живую часть с вопроса пользователя, а архив
    // завершить полным ответом ассистента. При неизвестных ролях
    // используем безопасную чётную границу.
    if (descriptors[cut]?.role === 'assistant' && cut > 0) cut -= 1;
    if (cut > 0 && descriptors[cut - 1]?.role === 'user') cut -= 1;
    if (cut > 0 && descriptors[cut]?.role !== 'user' && cut % 2 !== 0) cut -= 1;
    return Math.max(0, cut);
  }

  function isQuotaError(error) {
    return error?.name === 'QuotaExceededError' || /quota/i.test(String(error?.message || ''));
  }

  async function mutateWithScrollAnchor(mutator, explicitAnchor) {
    const anchor = explicitAnchor instanceof HTMLElement && explicitAnchor.isConnected
      ? explicitAnchor
      : findFirstVisibleMessage();
    const scroller = findScrollContainer(anchor || getConversationRoot());
    const beforeTop = anchor?.getBoundingClientRect().top ?? null;

    mutator();

    if (anchor?.isConnected && beforeTop !== null) {
      const afterTop = anchor.getBoundingClientRect().top;
      const delta = afterTop - beforeTop;
      if (Math.abs(delta) > 0.5) adjustScrollTop(scroller, delta);
    }
  }

  function findFirstVisibleMessage() {
    const candidates = [...getRestoredNodes(), ...getLiveMessages()];
    for (const node of candidates) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) return node;
    }
    return candidates[0] || null;
  }

  function findScrollContainer(startNode) {
    let node = startNode instanceof HTMLElement ? startNode.parentElement : null;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 2) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function adjustScrollTop(scroller, delta) {
    if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
      window.scrollBy(0, delta);
      return;
    }
    scroller.scrollTop += delta;
  }

  function ignoreMutations(durationMs) {
    state.ignoreMutationsUntil = Math.max(state.ignoreMutationsUntil, performance.now() + durationMs);
  }

  async function runMaintenance() {
    if (state.runInProgress) {
      state.pendingRun = true;
      return;
    }

    state.runInProgress = true;
    const epoch = state.sessionEpoch;

    try {
      ensureUI();
      handleRouteChange();
      startObserver();

      if (!state.currentChatKey) {
        removeArchiveBlock();
        setStatus('Откройте сохранённый чат, чтобы включить архивирование.');
        updateUI();
        return;
      }

      if (!state.cfg.enabled) {
        removeArchiveBlock();
        setStatus('Архиватор выключен. DOM страницы не изменяется.');
        updateUI();
        return;
      }

      await ensureArchiveLoaded(state.sessionEpoch);
      if (epoch !== state.sessionEpoch && state.archive.chatKey !== state.currentChatKey) return;
      await archiveMaintenance(state.sessionEpoch);
      ensureArchiveBlock();
      updateUI();
    } catch (error) {
      logError('Ошибка обслуживания:', error);
      setStatus(isQuotaError(error)
        ? 'Хранилище переполнено; сообщения не удалены.'
        : 'Ошибка архиватора. Подробности находятся в консоли.');
      updateUI();
    } finally {
      state.runInProgress = false;
      if (state.pendingRun) {
        state.pendingRun = false;
        scheduleMaintenance(0);
      }
    }
  }

  function scheduleMaintenance(delayMs) {
    clearTimeout(state.maintenanceTimer);
    state.maintenanceTimer = window.setTimeout(() => {
      void runMaintenance();
    }, typeof delayMs === 'number' ? delayMs : state.cfg.maintenanceDelayMs);
  }

  function startObserver() {
    const root = getConversationRoot();
    if (!root) return;
    if (state.observer && state.observerRoot === root && root.isConnected) return;

    state.observer?.disconnect();
    state.observer = new MutationObserver((mutations) => {
      if (performance.now() < state.ignoreMutationsUntil) return;
      if (!mutations.some(isMeaningfulMutation)) return;
      scheduleMaintenance();
    });
    state.observer.observe(root, { childList: true, subtree: true });
    state.observerRoot = root;
  }

  function isMeaningfulMutation(mutation) {
    if (state.ui?.root?.contains(mutation.target)) return false;
    if (mutation.target instanceof HTMLElement && mutation.target.closest(`#${DOM.archiveBlockId}`)) return false;

    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.closest?.(`#${DOM.uiId}`) || node.closest?.(`#${DOM.archiveBlockId}`)) continue;
      if (
        node.matches?.(DOM.primaryMessageSelector) ||
        node.matches?.(DOM.fallbackRoleSelector) ||
        node.querySelector?.(DOM.primaryMessageSelector) ||
        node.querySelector?.(DOM.fallbackRoleSelector)
      ) return true;
    }
    return false;
  }

  function patchHistory() {
    if (window.__cgAntiLagHistoryPatchedV3) return;
    window.__cgAntiLagHistoryPatchedV3 = true;

    const notify = () => setTimeout(() => scheduleMaintenance(0), 0);
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function () {
      const result = originalPushState.apply(this, arguments);
      notify();
      return result;
    };
    history.replaceState = function () {
      const result = originalReplaceState.apply(this, arguments);
      notify();
      return result;
    };
    window.addEventListener('popstate', notify, true);
  }

  function handleRouteChange() {
    const nextUrl = location.href;
    const nextChatKey = getChatKey();
    if (nextUrl === state.lastUrl && nextChatKey === state.currentChatKey) return;

    ignoreMutations(400);
    getRestoredNodes().forEach((node) => node.remove());
    removeArchiveBlock();

    state.lastUrl = nextUrl;
    state.currentChatKey = nextChatKey;
    state.sessionEpoch += 1;
    state.archive = createEmptyArchiveState(nextChatKey);
    state.observer?.disconnect();
    state.observer = null;
    state.observerRoot = null;
    state.lastUiSignature = '';
    setStatus(nextChatKey ? 'Открыт другой чат; загружаю его локальный архив…' : 'Ожидаю открытия сохранённого чата.');
  }

  function setupBroadcastChannel() {
    if (typeof BroadcastChannel !== 'function') return;
    state.channel = new BroadcastChannel('cg-anti-lag-v3');
    state.channel.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.source === getTabId()) return;
      if (data.type === 'archive-change' && data.chatKey === state.currentChatKey) {
        state.archive.loaded = false;
        scheduleMaintenance(50);
      }
      if (data.type === 'clear-all') {
        state.archive = createEmptyArchiveState(state.currentChatKey);
        scheduleMaintenance(50);
      }
    });
  }

  function broadcastArchiveChange(chatKey) {
    state.channel?.postMessage({
      type: 'archive-change',
      chatKey,
      source: getTabId(),
      at: Date.now(),
    });
  }

  function getTabId() {
    if (!window.__cgAntiLagTabIdV3) {
      window.__cgAntiLagTabIdV3 = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return window.__cgAntiLagTabIdV3;
  }

  async function performScheduledCleanup() {
    try {
      const lastCleanup = Number(localStorage.getItem(STORAGE.cleanupKey)) || 0;
      if (Date.now() - lastCleanup < LIMITS.cleanupIntervalMs) return;

      const metas = await listChatMetas();
      if (!metas.length) {
        localStorage.setItem(STORAGE.cleanupKey, String(Date.now()));
        return;
      }

      const now = Date.now();
      const sorted = metas.slice().sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
      const toDelete = new Set();

      for (const meta of sorted) {
        if (meta.chatKey === state.currentChatKey) continue;
        if (now - Number(meta.updatedAt || 0) > LIMITS.archiveTtlMs) toDelete.add(meta.chatKey);
      }

      while (sorted.filter((meta) => !toDelete.has(meta.chatKey)).length > LIMITS.maxChats) {
        const oldest = sorted.find((meta) => !toDelete.has(meta.chatKey) && meta.chatKey !== state.currentChatKey);
        if (!oldest) break;
        toDelete.add(oldest.chatKey);
      }

      let totalBytes = sorted
        .filter((meta) => !toDelete.has(meta.chatKey))
        .reduce((sum, meta) => sum + Number(meta.totalBytes || 0), 0);

      for (const meta of sorted) {
        if (totalBytes <= LIMITS.maxArchiveBytes) break;
        if (meta.chatKey === state.currentChatKey || toDelete.has(meta.chatKey)) continue;
        toDelete.add(meta.chatKey);
        totalBytes -= Number(meta.totalBytes || 0);
      }

      for (const chatKey of toDelete) await deleteChatArchive(chatKey);
      localStorage.setItem(STORAGE.cleanupKey, String(Date.now()));
    } catch (error) {
      logWarn('Автоматическая очистка архивов не выполнена:', error);
    }
  }

  function ensureUI() {
    if (state.ui?.root?.isConnected) return;

    const root = document.createElement('div');
    root.id = DOM.uiId;
    root.classList.toggle('cg-al-collapsed', state.cfg.panelCollapsed);
    root.innerHTML = `
      <div class="cg-al-panel-shell">
        <div class="cg-al-icon" title="${APP.name} ${APP.version}">🧊</div>
        <div class="cg-al-panel">
          <div class="cg-al-row">
            <span class="cg-al-title">Anti-Lag ${APP.version}</span>
            <button class="cg-al-switch" type="button" aria-label="Включить или выключить архиватор">
              <span class="cg-al-switch-knob"></span>
            </button>
          </div>
          <div class="cg-al-row">
            <span class="cg-al-muted">Пар в DOM</span>
            <span class="cg-al-stepper">
              <button class="cg-al-pairs-minus" type="button" aria-label="Уменьшить">−</button>
              <span class="cg-al-stepper-value cg-al-pairs-value">${state.cfg.keepPairs}</span>
              <button class="cg-al-pairs-plus" type="button" aria-label="Увеличить">+</button>
            </span>
          </div>
          <div class="cg-al-row">
            <span class="cg-al-muted">В архиве</span>
            <span class="cg-al-value cg-al-count">0</span>
          </div>
          <div class="cg-al-row">
            <span class="cg-al-muted">Объём</span>
            <span class="cg-al-value cg-al-bytes">0 Б</span>
          </div>
          <div class="cg-al-status">Инициализация…</div>
          <div class="cg-al-actions">
            <button class="cg-al-toggle-snapshots" type="button">Показать архив</button>
            <button class="cg-al-collapse" type="button">Свернуть</button>
            <button class="cg-al-clear-current" type="button">Пересобрать чат</button>
            <button class="cg-al-clear-all" type="button">Очистить всё</button>
          </div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);

    root.querySelector('.cg-al-switch').addEventListener('click', () => void toggleEnabled());
    root.querySelector('.cg-al-pairs-minus').addEventListener('click', () => changeKeepPairs(-1));
    root.querySelector('.cg-al-pairs-plus').addEventListener('click', () => changeKeepPairs(1));
    root.querySelector('.cg-al-toggle-snapshots').addEventListener('click', () => {
      if (state.archive.restoredCount > 0) void hideRestoredSnapshots();
      else void restoreOlderBatch();
    });
    root.querySelector('.cg-al-collapse').addEventListener('click', () => togglePanelCollapsed());
    root.querySelector('.cg-al-clear-current').addEventListener('click', () => void clearCurrentArchive());
    root.querySelector('.cg-al-clear-all').addEventListener('click', () => void clearAllArchivesFromUi());
    root.querySelector('.cg-al-panel-shell').addEventListener('click', (event) => {
      if (!state.cfg.panelCollapsed || event.target.closest('button')) return;
      state.cfg.panelCollapsed = false;
      saveConfig();
      root.classList.remove('cg-al-collapsed');
      state.lastUiSignature = '';
      updateUI();
    });

    state.ui = {
      root,
      count: root.querySelector('.cg-al-count'),
      bytes: root.querySelector('.cg-al-bytes'),
      pairs: root.querySelector('.cg-al-pairs-value'),
      status: root.querySelector('.cg-al-status'),
      toggleSnapshots: root.querySelector('.cg-al-toggle-snapshots'),
      collapse: root.querySelector('.cg-al-collapse'),
      clearCurrent: root.querySelector('.cg-al-clear-current'),
    };
    updateUI();
  }

  async function toggleEnabled() {
    const nextEnabled = !state.cfg.enabled;
    state.cfg.enabled = nextEnabled;
    saveConfig();
    state.lastUiSignature = '';

    if (!nextEnabled) {
      setStatus('Выключаю архиватор и восстанавливаю оригинальную страницу…');
      updateUI();
      try {
        if (state.currentChatKey) await deleteChatArchive(state.currentChatKey);
      } catch (error) {
        logWarn('Не удалось очистить архив текущего чата перед отключением:', error);
      }
      location.reload();
      return;
    }

    state.archive.loaded = false;
    setStatus('Архиватор включён.');
    scheduleMaintenance(0);
  }

  function changeKeepPairs(delta) {
    state.cfg.keepPairs = clamp(state.cfg.keepPairs + delta, LIMITS.minKeepPairs, LIMITS.maxKeepPairs);
    saveConfig();
    state.lastUiSignature = '';
    scheduleMaintenance(0);
    updateUI();
  }

  function togglePanelCollapsed() {
    state.cfg.panelCollapsed = !state.cfg.panelCollapsed;
    saveConfig();
    state.ui.root.classList.toggle('cg-al-collapsed', state.cfg.panelCollapsed);
    state.lastUiSignature = '';
    updateUI();
  }

  async function clearCurrentArchive() {
    const chatKey = state.currentChatKey;
    if (!chatKey) return;
    if (!confirm('Пересобрать локальный архив текущего чата? Страница перезагрузится, история на сервере ChatGPT не изменится.')) return;

    setStatus('Очищаю локальный архив текущего чата…');
    updateUI();
    try {
      await deleteChatArchive(chatKey);
      broadcastArchiveChange(chatKey);
      location.reload();
    } catch (error) {
      logError('Не удалось очистить архив текущего чата:', error);
      setStatus('Не удалось очистить архив текущего чата.');
      updateUI();
    }
  }

  async function clearAllArchivesFromUi() {
    if (!confirm('Удалить все локальные архивы ChatGPT Anti-Lag в этом браузере? Серверная история ChatGPT не удаляется.')) return;

    setStatus('Очищаю все локальные архивы…');
    updateUI();
    try {
      await deleteAllArchives();
      state.channel?.postMessage({ type: 'clear-all', source: getTabId(), at: Date.now() });
      location.reload();
    } catch (error) {
      logError('Не удалось очистить все архивы:', error);
      setStatus('Не удалось очистить все локальные архивы.');
      updateUI();
    }
  }

  function updateUI() {
    if (!state.ui) return;

    const count = state.archive.entries.length;
    const signature = [
      state.cfg.enabled ? 1 : 0,
      state.cfg.keepPairs,
      state.cfg.panelCollapsed ? 1 : 0,
      count,
      state.archive.totalBytes,
      state.archive.restoredCount,
      state.archive.loadingBatch ? 1 : 0,
      state.statusText,
      state.currentChatKey || '',
    ].join('|');

    if (signature === state.lastUiSignature) return;
    state.lastUiSignature = signature;
    state.ui.root.dataset.enabled = state.cfg.enabled ? 'true' : 'false';
    state.ui.root.classList.toggle('cg-al-collapsed', state.cfg.panelCollapsed);
    state.ui.count.textContent = String(count);
    state.ui.bytes.textContent = formatBytes(state.archive.totalBytes);
    state.ui.pairs.textContent = String(state.cfg.keepPairs);
    state.ui.status.textContent = state.statusText;
    state.ui.toggleSnapshots.textContent = state.archive.restoredCount > 0 ? 'Скрыть архив' : 'Показать архив';
    state.ui.toggleSnapshots.disabled = !state.cfg.enabled || count === 0 || state.archive.loadingBatch;
    state.ui.collapse.textContent = state.cfg.panelCollapsed ? 'Развернуть' : 'Свернуть';
    state.ui.clearCurrent.disabled = !state.currentChatKey || count === 0;
  }

  function setStatus(text) {
    state.statusText = text || 'Ожидание.';
    if (state.ui?.status) state.ui.status.textContent = state.statusText;
  }

  function pluralRu(number, forms) {
    const value = Math.abs(Number(number)) % 100;
    const last = value % 10;
    if (value > 10 && value < 20) return forms[2];
    if (last === 1) return forms[0];
    if (last > 1 && last < 5) return forms[1];
    return forms[2];
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} Б`;
    const units = ['КБ', 'МБ', 'ГБ'];
    let current = value / 1024;
    let unitIndex = 0;
    while (current >= 1024 && unitIndex < units.length - 1) {
      current /= 1024;
      unitIndex += 1;
    }
    const digits = current >= 100 ? 0 : current >= 10 ? 1 : 2;
    return `${current.toFixed(digits)} ${units[unitIndex]}`;
  }

  function start() {
    if (state.started) return;
    state.started = true;

    ensureUI();
    patchHistory();
    setupBroadcastChannel();
    startObserver();

    state.routeTimer = window.setInterval(() => {
      if (location.href !== state.lastUrl || getChatKey() !== state.currentChatKey) {
        scheduleMaintenance(0);
      }
    }, state.cfg.routeCheckIntervalMs);

    scheduleMaintenance(150);
    setTimeout(() => scheduleMaintenance(0), 1000);
    setTimeout(() => scheduleMaintenance(0), 2500);
    setTimeout(() => void performScheduledCleanup(), 3500);
  }

  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start, { once: true });
})();
