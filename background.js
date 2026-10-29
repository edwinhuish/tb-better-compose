/**
 * 写信增强 BetterCompose — background
 *
 * 职责只有三件：
 *   1. 注册 compose script（注入撰写窗口）
 *   2. 维护每个撰写 tab 的 Port，缓存最新 HTML
 *   3. 发送前把编辑器内容写回 Thunderbird 自己的编辑区
 *
 * 与 Thunderpen 的差别：
 *   - 缓存与落盘分离：平时只缓存不 setComposeDetails（否则 TB 重绘 body 会毁掉 TinyMCE 的 DOM）
 *   - onBeforeSend 超时从 3s 收到 1.2s，超时后仍用缓存兜底，避免"整封信丢格式"
 *   - 内容与缓存一致时跳过写回，减少发送路径上的无谓 IO
 */

'use strict';

const ports = new Map();     // tabId -> Port
const cache = new Map();     // tabId -> 最新 HTML
const sendAcks = new Map();  // tabId -> ack resolver

const SEND_ACK_TIMEOUT = 800;
const CONTENT_TIMEOUT = 1200;

function log(...args) {
  console.log('[BetterCompose]', ...args);
}

(async function registerComposeScripts() {
  try {
    const api = browser.composeScripts || (typeof messenger !== 'undefined' && messenger.composeScripts);
    if (!api) throw new Error('composeScripts API 不存在（Thunderbird 版本过低？）');
    await api.register({
      // 顺序有意义：composeScripts 按数组顺序注入，前面几个把东西挂到 window 上，
      // inject.js 在启动时直接取用 ——
      //   config.js  → window.__tcsConfig   （默认值、白名单、校验）
      //   i18n.js    → window.__tcsI18n     （语言解析、文案加载）
      //   markdown.js→ window.__tcsMarkdown （md→HTML、粘贴检测）
      // 任何一个没加载，inject.js 都能自己降级：前两个缺了就不接管（编辑器
      // 保持原样），markdown 缺了只是粘贴不转换。
      js: [
        { file: 'compose/config.js' },
        { file: 'compose/i18n.js' },
        { file: 'compose/markdown.js' },
        { file: 'compose/inject.js' },
      ],
      css: [{ file: 'compose/shell.css' }],
    });
    log('compose script 已注册');
  } catch (e) {
    console.error('[BetterCompose] composeScripts 注册失败:', e);
  }
})();

browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'compose-studio') return;

  const tab = port.sender && port.sender.tab;
  if (!tab) return;
  const tabId = tab.id;
  ports.set(tabId, port);

  port.onDisconnect.addListener(() => {
    ports.delete(tabId);
    cache.delete(tabId);
    sendAcks.delete(tabId);
  });

  port.onMessage.addListener(async msg => {
    switch (msg.action) {
      case 'getComposeDetails': {
        try {
          const details = await browser.compose.getComposeDetails(tabId);
          port.postMessage({ action: 'composeDetails', details });
        } catch (e) {
          console.error('[BetterCompose] getComposeDetails 失败:', e);
          port.postMessage({
            action: 'composeDetails',
            details: { body: '', isPlainText: false },
          });
        }
        break;
      }

      // 常规同步：只缓存。落盘会触发 TB 重绘 body，把 TinyMCE 的 DOM 一起干掉。
      case 'syncContent':
        cache.set(tabId, msg.html);
        break;

      // 存草稿等 TB 内部路径直接读 DOM 时，需要立刻落盘
      case 'flushContent':
        cache.set(tabId, msg.html);
        try {
          await browser.compose.setComposeDetails(tabId, { body: msg.html });
        } catch (e) {
          console.error('[BetterCompose] flush 失败:', e);
        }
        break;

      case 'content':
        resolveContent(tabId, msg.html);
        break;

      case 'prepareForSendAck':
        resolveAck(tabId);
        break;
    }
  });
});

let pendingContent = new Map();

function resolveContent(tabId, html) {
  const resolve = pendingContent.get(tabId);
  if (resolve) {
    pendingContent.delete(tabId);
    resolve(html);
  }
}

function resolveAck(tabId) {
  const resolve = sendAcks.get(tabId);
  if (resolve) {
    sendAcks.delete(tabId);
    resolve();
  }
}

function waitAck(tabId, port) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      sendAcks.delete(tabId);
      resolve();
    }, SEND_ACK_TIMEOUT);
    sendAcks.set(tabId, () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      port.postMessage({ action: 'prepareForSend' });
    } catch (e) {
      clearTimeout(timer);
      sendAcks.delete(tabId);
      resolve();
    }
  });
}

function waitContent(tabId, port) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingContent.delete(tabId);
      resolve(cache.get(tabId) || '');
    }, CONTENT_TIMEOUT);
    pendingContent.set(tabId, html => {
      clearTimeout(timer);
      resolve(html);
    });
    try {
      port.postMessage({ action: 'requestContent' });
    } catch (e) {
      clearTimeout(timer);
      pendingContent.delete(tabId);
      resolve(cache.get(tabId) || '');
    }
  });
}

browser.compose.onBeforeSend.addListener(async tab => {
  const tabId = tab.id;
  const port = ports.get(tabId);
  if (!port) return {};

  // 1. 让编辑器把工具栏/弹出层从文档里摘掉，并回 ack
  await waitAck(tabId, port);

  // 2. 取干净内容（超时用缓存兜底）
  const html = await waitContent(tabId, port);
  cache.set(tabId, html);

  // 3. 写回 Thunderbird 自己的编辑区，后续 MIME 序列化走它原生逻辑
  try {
    await browser.compose.setComposeDetails(tabId, { body: html });
  } catch (e) {
    console.error('[BetterCompose] 发送前写回失败:', e);
  }

  // 4. 双保险：onBeforeSend 的返回值也是正文来源之一
  return { details: { body: html } };
});
