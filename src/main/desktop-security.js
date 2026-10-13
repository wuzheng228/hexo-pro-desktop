const { pathToFileURL } = require('url');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function isValidProjectName(name) {
  return typeof name === 'string' && name.length <= 100 &&
    /^[a-z\d](?:[a-z\d_-]*[a-z\d])?$/i.test(name) && !name.includes('--') &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
}

function getExternalUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('不支持的外部链接');
  }
  const url = new URL(value);
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('不支持的外部链接');
  }
  return url.href;
}

function isTrustedAppUrl(value, indexPath, serverUrl) {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      url.search = '';
      url.hash = '';
      return url.href === pathToFileURL(indexPath).href;
    }
    return Boolean(serverUrl && url.origin === new URL(serverUrl).origin &&
      (url.pathname === '/pro' || url.pathname.startsWith('/pro/')));
  } catch (_) {
    return false;
  }
}

function isTrustedSender(event, window, acceptsUrl) {
  if (!window || window.isDestroyed() || !event.senderFrame) return false;
  const contents = window.webContents;
  return event.sender === contents && event.senderFrame === contents.mainFrame &&
    acceptsUrl(event.senderFrame.url);
}

function restrictNavigation(window, acceptsUrl, openExternal) {
  const blockNavigation = (event, url) => {
    if (!acceptsUrl(url)) event.preventDefault();
  };
  window.webContents.on('will-navigate', blockNavigation);
  window.webContents.on('will-redirect', blockNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (openExternal) {
      try {
        Promise.resolve(openExternal(getExternalUrl(url))).catch(() => {});
      } catch (_) { /* Unsupported schemes are never passed to the OS. */ }
    }
    return { action: 'deny' };
  });
}

const dialogUrls = new WeakMap();

function loadDialog(window, html) {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  dialogUrls.set(window, url);
  restrictNavigation(window, candidate => candidate === url);
  return window.loadURL(url);
}

function isDialogSender(event, window) {
  return isTrustedSender(event, window, url => url === dialogUrls.get(window));
}

module.exports = {
  escapeHtml, isValidProjectName, getExternalUrl, isTrustedAppUrl,
  isTrustedSender, restrictNavigation, loadDialog, isDialogSender
};
