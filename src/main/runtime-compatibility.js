const MINIMUM_NODE_VERSION = '20.19.0';
const MINIMUM_DEVELOPMENT_NODE_VERSION = '22.12.0';

function isSupportedNodeVersion(version, minimumVersion = MINIMUM_NODE_VERSION) {
  const match = typeof version === 'string' && /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;

  const parts = match.slice(1).map(Number);
  const minimumNodeParts = minimumVersion.split('.').map(Number);
  for (let index = 0; index < minimumNodeParts.length; index++) {
    if (parts[index] !== minimumNodeParts[index]) {
      return parts[index] > minimumNodeParts[index];
    }
  }
  return true;
}

function assertSupportedNodeRuntime(runtime) {
  if (isSupportedNodeVersion(runtime.node)) return;

  const currentRuntime = runtime.electron
    ? `Electron ${runtime.electron}（内置 Node.js ${runtime.node || '未知'}）`
    : `Node.js ${runtime.node || '未知'}`;
  const guidance = runtime.electron
    ? '请升级 Hexo Pro Desktop。桌面版使用 Electron 内置 Node.js，升级系统 Node.js 无法更新它。'
    : `请将 Node.js 升级至 ${MINIMUM_NODE_VERSION} 或更高版本后重试。`;
  const error = new Error(`Hexo 8 需要 Node.js ${MINIMUM_NODE_VERSION} 或更高版本；当前运行环境为 ${currentRuntime}。${guidance}`);
  error.code = 'UNSUPPORTED_NODE_RUNTIME';
  throw error;
}

function assertSupportedDevelopmentRuntime(runtime) {
  if (isSupportedNodeVersion(runtime.node, MINIMUM_DEVELOPMENT_NODE_VERSION)) return;

  const error = new Error(`Hexo Pro Desktop 源码开发和构建需要 Node.js ${MINIMUM_DEVELOPMENT_NODE_VERSION} 或更高版本；当前 Node.js ${runtime.node || '未知'}。请升级系统 Node.js 后重试。`);
  error.code = 'UNSUPPORTED_DEVELOPMENT_NODE_RUNTIME';
  throw error;
}

module.exports = {
  MINIMUM_NODE_VERSION,
  MINIMUM_DEVELOPMENT_NODE_VERSION,
  isSupportedNodeVersion,
  assertSupportedNodeRuntime,
  assertSupportedDevelopmentRuntime
};
