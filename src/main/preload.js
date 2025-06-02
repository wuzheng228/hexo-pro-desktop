const { contextBridge, ipcRenderer } = require('electron');

// 安全地导入模块，添加错误处理
let pathModule;
try {
  pathModule = require('path');
} catch (error) {
  console.error('Failed to load path module:', error);
  pathModule = {
    join: (...args) => args.join('/'),
    dirname: (p) => p.split('/').slice(0, -1).join('/'),
    basename: (p) => p.split('/').pop(),
    extname: (p) => {
      const name = p.split('/').pop();
      const lastDot = name.lastIndexOf('.');
      return lastDot > 0 ? name.slice(lastDot) : '';
    },
    resolve: (...args) => args.join('/')
  };
}

let electronApp;
try {
  electronApp = require('electron').app;
} catch (error) {
  console.error('Failed to load electron app:', error);
  electronApp = { getVersion: () => '1.0.0' };
}

// 向渲染进程暴露安全的 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 项目管理
  getProjectInfo: () => ipcRenderer.invoke('get-project-info'),
  openProject: () => ipcRenderer.invoke('open-project'),
  createProject: () => ipcRenderer.invoke('create-project'),
  validateHexoProject: (projectPath) => ipcRenderer.invoke('validate-hexo-project', projectPath),
  
  // 文件系统操作
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  
  // 对话框
  showMessage: (options) => ipcRenderer.invoke('show-message', options),
  
  // 外部链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  
  // 服务器控制
  restartServer: () => ipcRenderer.invoke('restart-server'),
  
  // 导航控制
  loadWebInterface: () => ipcRenderer.invoke('load-web-interface'),
  
  // 强制重启应用
  forceRestartApp: () => ipcRenderer.invoke('force-restart-app'),
  
  // 事件监听
  onProjectLoaded: (callback) => {
    ipcRenderer.on('project-loaded', (event, data) => callback(data));
  },
  
  onCreateNewProject: (callback) => {
    ipcRenderer.on('create-new-project', (event, projectPath) => callback(projectPath));
  },
  
  onOpenSettings: (callback) => {
    ipcRenderer.on('open-settings', () => callback());
  },
  
  // 移除事件监听器
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
  
  // 平台信息
  platform: process.platform,
  
  // 应用信息
  getAppVersion: () => {
    try {
      return electronApp.getVersion();
    } catch (error) {
      console.error('Failed to get app version:', error);
      return '1.0.0';
    }
  },
  
  // 桌面端特有功能
  desktop: {
    // 最小化窗口
    minimize: () => ipcRenderer.invoke('window-minimize'),
    
    // 最大化窗口
    maximize: () => ipcRenderer.invoke('window-maximize'),
    
    // 关闭窗口
    close: () => ipcRenderer.invoke('window-close'),
    
    // 检查是否为全屏
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    
    // 设置窗口标题
    setTitle: (title) => ipcRenderer.invoke('window-set-title', title)
  },
  
  // 通用功能
  showInFolder: (path) => ipcRenderer.invoke('show-in-folder', path)
});

// 暴露一些有用的 Node.js API（只读）
contextBridge.exposeInMainWorld('nodeAPI', {
  path: {
    join: pathModule.join,
    dirname: pathModule.dirname,
    basename: pathModule.basename,
    extname: pathModule.extname,
    resolve: pathModule.resolve
  },
  
  // 环境变量（只读）
  env: {
    NODE_ENV: process.env.NODE_ENV,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE
  }
});

// 服务器控制
ipcRenderer.on('restart-server', () => {
  // 实现服务器重启逻辑
});

// 导航控制
ipcRenderer.on('load-web-interface', () => {
  // 实现加载 Web 接口逻辑
}); 