const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const HexoProServer = require('./hexo-server');
const AuthManager = require('./auth-manager');

const execAsync = promisify(exec);

// 对于Node.js < 18版本，需要安装node-fetch
const fetch = (() => {
  try {
    return require('node-fetch');
  } catch {
    // Node.js 18+ 内置fetch
    return globalThis.fetch;
  }
})();

// 动态导入 electron-store
let Store;
let store;

class HexoProDesktop {
  constructor() {
    this.mainWindow = null;
    this.progressWindow = null;
    this.loadingWindow = null; // 添加加载窗口
    this.hexoServer = null;
    this.currentProjectPath = null;
    this.isDev = process.env.NODE_ENV === 'development';
    this.authManager = new AuthManager();
    
    // 添加状态管理，防止循环重定向
    this.isLoadingWebInterface = false;
    this.lastTokenInjected = null;
    this.pageLoadCount = 0;
    this.tokenInjectionAttempts = 0;
    this.maxTokenInjectionAttempts = 2;
    
    // 添加token验证缓存
    this.lastValidatedToken = null;
    this.lastValidationSuccess = false;
    
    // 添加窗口状态管理
    this.windowHidden = false;
    this.lastWindowState = null; // 用于保存窗口关闭前的状态
    
    // 添加项目加载状态管理
    this.isProjectLoading = false;
    
    // 设置全局变量，供HexoProServer访问
    global.desktopAuthManager = this.authManager;
    
    // 等待 app ready 后初始化
    app.whenReady().then(async () => {
      await this.initializeStore();
      // AuthManager现在使用共享的store，不需要单独初始化
      await this.authManager.loadAuthData();
    });
  }

  async initializeStore() {
    try {
      console.log('应用名称:', app.getName());
      console.log('用户数据路径:', app.getPath('userData'));
      
      const electronStore = await import('electron-store');
      Store = electronStore.default;
      store = new Store();
      console.log('electron-store 初始化成功');
      console.log('store存储路径:', store.path);
      
      // 将store实例传递给AuthManager
      this.authManager.setStore(store);
      
    } catch (error) {
      console.error('初始化 electron-store 失败:', error);
      // 提供一个简单的内存存储作为后备
      store = {
        get: () => null,
        set: () => {},
        delete: () => {},
        clear: () => {}
      };
      
      // 也要设置给AuthManager
      this.authManager.setStore(store);
    }
  }

  // 安全的store操作方法
  safeStoreGet(key) {
    return store ? store.get(key) : null;
  }

  safeStoreSet(key, value) {
    if (store) {
      store.set(key, value);
    }
  }

  safeStoreDelete(key) {
    if (store) {
      store.delete(key);
    }
  }

  async createWindow() {
    console.log(path.join(__dirname, '../../assets/icon.png'))
    // 创建主窗口
    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 1000,
      minHeight: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        enableRemoteModule: false,
        sandbox: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        preload: path.join(__dirname, 'preload.js')
      },
      icon: path.join(__dirname, '../../assets/icon.png'),
      titleBarStyle: 'default',
      show: false
    });

    // 窗口准备显示时显示
    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
    });

    // 监听页面内导航（单页应用内的路由变化）
    this.mainWindow.webContents.on('did-navigate-in-page', (event, navigationUrl) => {
      console.log('[Desktop]: 页面内导航到:', navigationUrl);
      // 如果是在主页面内的导航（非登录页），减少拦截器重新注入的频率
      if (navigationUrl.includes('/pro') && !navigationUrl.includes('/pro')) {
        console.log('[Desktop]: 主页面内导航，检查拦截器是否需要重新注入');
        
        // 检查拦截器是否还存在
        this.mainWindow.webContents.executeJavaScript(`
          (function() {
            return {
              hasInterceptor: localStorage.setItem.toString().includes('Hexo Pro Desktop'),
              isDesktopEnv: window.isHexoProDesktop || false
            };
          })();
        `).then((result) => {
          if (!result.hasInterceptor || !result.isDesktopEnv) {
            console.log('[Desktop]: 主页面检测到拦截器缺失，重新注入');
            // 只有在拦截器确实缺失时才重新注入
            setTimeout(async () => {
              try {
                await this.injectLocalStorageInterceptor();
                await this.injectDesktopFeatures();
                console.log('[Desktop]: 主页面拦截器重新注入完成');
              } catch (error) {
                console.error('[Desktop]: 主页面重新注入拦截器失败:', error);
              }
            }, 200);
          } else {
            console.log('[Desktop]: 主页面拦截器正常，无需重新注入');
          }
        }).catch((error) => {
          console.error('[Desktop]: 检查拦截器状态失败:', error);
        });
        
        return; // 跳过默认的注入逻辑
      }
      
      // 添加防抖，避免过度触发
      if (this.navigationTimeout) {
        clearTimeout(this.navigationTimeout);
      }
      
      this.navigationTimeout = setTimeout(async () => {
        try {
          console.log('[Desktop]: 页面内导航后检查并重新注入拦截器...');
          
          // 只注入拦截器和桌面功能，不重新处理token
          await this.injectLocalStorageInterceptor();
          await this.injectDesktopFeatures();
          
          console.log('[Desktop]: 页面内导航后拦截器检查完成');
        } catch (error) {
          console.error('[Desktop]: 页面内导航后注入拦截器失败:', error);
        }
      }, 500); // 增加防抖时间到500ms
    });

    // 暂时不启动服务器，等检查项目后再决定
    
    // 加载桌面端专用的前端界面
    const indexPath = path.join(__dirname, '../renderer/index.html');
    
    if (this.isDev) {
      // 开发环境：加载本地文件并打开开发者工具
      await this.mainWindow.loadFile(indexPath);
      this.mainWindow.webContents.openDevTools();
    } else {
      // 生产环境：加载本地文件
      await this.mainWindow.loadFile(indexPath);
    }

    // 处理窗口关闭 - macOS 特殊处理
    if (process.platform === 'darwin') {
      // macOS: 点击关闭按钮时隐藏窗口而不是销毁
      this.mainWindow.on('close', (event) => {
        if (!app.isQuittingApp) {
          event.preventDefault();
          
          // 保存当前窗口状态（URL、项目路径等）
          this.saveWindowState();
          
          this.mainWindow.hide();
          this.windowHidden = true;
          
          console.log('[Desktop]: 窗口已隐藏到程序坞，状态已保存');
        }
      });
      
      // 只有在应用真正退出时才清理
      this.mainWindow.on('closed', () => {
        this.mainWindow = null;
      });
    } else {
      // 其他平台：正常关闭行为
      this.mainWindow.on('closed', () => {
        this.mainWindow = null;
      });
    }

    // 处理外部链接
    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  }

  // 保存窗口关闭前的状态
  saveWindowState() {
    try {
      this.lastWindowState = {
        projectPath: this.currentProjectPath,
        serverUrl: this.hexoServer ? this.hexoServer.getUrl() : null,
        currentUrl: this.mainWindow ? this.mainWindow.webContents.getURL() : null,
        timestamp: Date.now()
      };
      console.log('[Desktop]: 已保存窗口状态:', this.lastWindowState);
    } catch (error) {
      console.error('[Desktop]: 保存窗口状态失败:', error);
    }
  }

  // 恢复窗口状态
  async restoreWindowState() {
    try {
      if (!this.lastWindowState) {
        console.log('[Desktop]: 没有保存的窗口状态，正常初始化');
        return false;
      }

      console.log('[Desktop]: 恢复窗口状态:', this.lastWindowState);
      
      // 检查状态是否过期（超过10分钟认为过期）
      const stateAge = Date.now() - this.lastWindowState.timestamp;
      if (stateAge > 10 * 60 * 1000) {
        console.log('[Desktop]: 窗口状态已过期，正常初始化');
        this.lastWindowState = null;
        return false;
      }

      // 如果有项目路径，尝试恢复到Web界面
      if (this.lastWindowState.projectPath && await fs.pathExists(this.lastWindowState.projectPath)) {
        console.log('[Desktop]: 恢复到项目Web界面:', this.lastWindowState.projectPath);
        await this.loadProject(this.lastWindowState.projectPath);
        return true;
      } else if (this.lastWindowState.serverUrl) {
        // 如果没有项目路径但有服务器URL，说明之前在某个状态下
        console.log('[Desktop]: 有服务器URL但无有效项目路径，正常初始化');
      }

      return false;
    } catch (error) {
      console.error('[Desktop]: 恢复窗口状态失败:', error);
      return false;
    }
  }

  // 验证项目名称是否符合规范
  validateProjectName(projectName) {
    if (!projectName || typeof projectName !== 'string') {
      return {
        isValid: false,
        message: '项目名称不能为空'
      };
    }

    // 去除首尾空格
    projectName = projectName.trim();

    // 长度检查
    if (projectName.length === 0) {
      return {
        isValid: false,
        message: '项目名称不能为空'
      };
    }

    if (projectName.length > 100) {
      return {
        isValid: false,
        message: '项目名称不能超过100个字符'
      };
    }

    // GitHub仓库名称规范：只能包含字母、数字、连字符和下划线
    const validNamePattern = /^[a-zA-Z0-9_-]+$/;
    if (!validNamePattern.test(projectName)) {
      return {
        isValid: false,
        message: '项目名称只能包含英文字母、数字、连字符(-)和下划线(_)'
      };
    }

    // 不能以连字符或下划线开头或结尾
    if (projectName.startsWith('-') || projectName.startsWith('_') || 
        projectName.endsWith('-') || projectName.endsWith('_')) {
      return {
        isValid: false,
        message: '项目名称不能以连字符(-)或下划线(_)开头或结尾'
      };
    }

    // 不能包含连续的连字符
    if (projectName.includes('--')) {
      return {
        isValid: false,
        message: '项目名称不能包含连续的连字符(--)'
      };
    }

    // 检查是否为保留名称
    const reservedNames = ['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'];
    if (reservedNames.includes(projectName.toLowerCase())) {
      return {
        isValid: false,
        message: '项目名称不能使用系统保留名称'
      };
    }

    return {
      isValid: true,
      message: '项目名称格式正确'
    };
  }

  // 检查系统依赖
  async checkSystemDependencies() {
    const results = {
      npm: false,
      hexoCli: false,
      errors: []
    };

    try {
      console.log('[依赖检查]: 检查 npm...');
      const npmResult = await execAsync('npm --version');
      results.npm = true;
      console.log('[依赖检查]: npm版本:', npmResult.stdout.trim());
    } catch (error) {
      console.error('[依赖检查]: npm检查失败:', error.message);
      results.errors.push('npm未安装或不在PATH中');
    }

    try {
      console.log('[依赖检查]: 检查 hexo-cli...');
      const hexoResult = await execAsync('hexo --version');
      results.hexoCli = true;
      console.log('[依赖检查]: hexo-cli版本:', hexoResult.stdout.trim().split('\n')[0]);
    } catch (error) {
      console.error('[依赖检查]: hexo-cli检查失败:', error.message);
      results.errors.push('hexo-cli未安装，请运行 npm install hexo-cli -g 安装');
    }

    return results;
  }

  // 执行shell命令并显示进度
  async executeCommand(command, workingDir, progressCallback) {
    return new Promise((resolve, reject) => {
      console.log(`[命令执行]: 在 ${workingDir} 执行: ${command}`);
      
      const child = spawn(command, [], {
        cwd: workingDir,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        console.log(`[命令输出]: ${output.trim()}`);
        if (progressCallback) {
          progressCallback({ type: 'stdout', data: output });
        }
      });

      child.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        console.error(`[命令错误]: ${output.trim()}`);
        if (progressCallback) {
          progressCallback({ type: 'stderr', data: output });
        }
      });

      child.on('close', (code) => {
        console.log(`[命令执行]: 命令执行完成，退出码: ${code}`);
        if (code === 0) {
          resolve({ stdout, stderr, code });
        } else {
          reject(new Error(`命令执行失败，退出码: ${code}\n错误信息: ${stderr}`));
        }
      });

      child.on('error', (error) => {
        console.error(`[命令执行]: 命令执行异常:`, error);
        reject(error);
      });
    });
  }

  createMenu() {
    const isProjectLoading = this.isProjectLoading; // 获取当前加载状态
    
    const template = [
      {
        label: '文件',
        submenu: [
          {
            label: '新建博客项目',
            accelerator: 'CmdOrCtrl+N',
            enabled: !isProjectLoading, // 加载期间禁用
            click: () => {
              this.createNewProject();
            }
          },
          {
            label: '打开博客项目',
            accelerator: 'CmdOrCtrl+O',
            enabled: !isProjectLoading, // 加载期间禁用
            click: () => {
              this.openProject();
            }
          },
          {
            label: '关闭当前项目',
            accelerator: 'CmdOrCtrl+W',
            enabled: !isProjectLoading, // 加载期间禁用
            click: () => {
              this.closeProject();
            }
          },
          { type: 'separator' },
          {
            label: '设置',
            accelerator: 'CmdOrCtrl+,',
            click: () => {
              this.openSettings();
            }
          },
          { type: 'separator' },
          {
            label: process.platform === 'darwin' ? '退出 Hexo Pro' : '退出',
            accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
            click: () => {
              app.quit();
            }
          }
        ]
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectall', label: '全选' }
        ]
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { role: 'forceReload', label: '强制重新加载' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '切换全屏' }
        ]
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'close', label: '关闭' }
        ]
      },
      {
        label: '帮助',
        submenu: [
          {
            label: '关于 Hexo Pro Desktop',
            click: () => {
              this.showAbout();
            }
          },
          {
            label: '访问官网',
            click: () => {
              shell.openExternal('https://github.com/wuzheng228/hexo-pro');
            }
          }
        ]
      }
    ];

    // macOS 特殊处理
    if (process.platform === 'darwin') {
      template.unshift({
        label: app.getName(),
        submenu: [
          { role: 'about', label: '关于 Hexo Pro Desktop' },
          { type: 'separator' },
          { role: 'services', label: '服务' },
          { type: 'separator' },
          { role: 'hide', label: '隐藏 Hexo Pro Desktop' },
          { role: 'hideOthers', label: '隐藏其他' },
          { role: 'unhide', label: '显示全部' },
          { type: 'separator' },
          { role: 'quit', label: '退出 Hexo Pro Desktop' }
        ]
      });

      // 窗口菜单
      template[4].submenu = [
        { role: 'close', label: '关闭' },
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' }
      ];
    }

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  // 更新菜单状态
  updateMenuState() {
    this.createMenu(); // 重新创建菜单以更新禁用状态
  }

  async createNewProject() {
    try {
      console.log('[创建项目]: 开始创建新项目流程...');

      // 1. 检查系统依赖
      console.log('[创建项目]: 检查系统依赖...');
      const dependencies = await this.checkSystemDependencies();
      
      if (!dependencies.npm || !dependencies.hexoCli) {
        const missingDeps = dependencies.errors.join('\n');
        const result = await dialog.showMessageBox(this.mainWindow, {
          type: 'error',
          title: '缺少必要依赖',
          message: '创建Hexo项目需要以下依赖：',
          detail: `${missingDeps}\n\n请先安装缺少的依赖后再创建项目。\n\n安装方法：\n1. 安装 Node.js (包含npm)\n2. 运行命令: npm install hexo-cli -g`,
          buttons: ['取消', '继续创建', '打开安装指南'],
          defaultId: 0,
          cancelId: 0
        });

        if (result.response === 0) {
          return; // 用户选择取消
        } else if (result.response === 2) {
          // 打开安装指南
          shell.openExternal('https://hexo.io/zh-cn/docs/');
          return;
        }
        // 用户选择继续创建，尝试继续（可能有些依赖实际存在但检查失败）
      }

      // 2. 选择父目录
      console.log('[创建项目]: 选择项目父目录...');
      const result = await dialog.showOpenDialog(this.mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: '选择新博客项目的父目录'
      });

      if (result.canceled || !result.filePaths.length) {
        console.log('[创建项目]: 用户取消目录选择');
        return;
      }

      const parentDir = result.filePaths[0];
      console.log('[创建项目]: 选择的父目录:', parentDir);

      // 3. 输入项目名称
      console.log('[创建项目]: 请求项目名称输入...');
      const projectNameResult = await this.showProjectNameDialog();
      
      if (!projectNameResult.success) {
        console.log('[创建项目]: 用户取消项目名称输入');
        return;
      }

      const projectName = projectNameResult.projectName;
      const projectPath = path.join(parentDir, projectName);

      // 4. 检查项目目录是否已存在
      if (await fs.pathExists(projectPath)) {
        const overwriteResult = await this.showCustomConfirmDialog({
          title: '目录已存在',
          message: `目录 "${projectName}" 已存在`,
          detail: `是否要覆盖现有目录？这将删除目录中的所有内容。

注意事项：
• 此操作不可撤销
• 目录中的所有文件和子目录都将被永久删除  
• 请确保您不需要保留现有内容
• 建议在操作前备份重要数据

风险说明：
- 覆盖后无法恢复原有数据
- 如果目录中有重要文件，请先进行备份
- 建议选择其他目录名称以避免冲突

确认要继续吗？`,
          confirmLabel: '覆盖',
          cancelLabel: '取消',
          width: 500,
          height: 500,
          type: 'warning'
        });

        if (!overwriteResult.confirmed) {
          console.log('[创建项目]: 用户取消覆盖');
          return;
        }

        // 删除现有目录
        console.log('[创建项目]: 删除现有目录:', projectPath);
        await fs.remove(projectPath);
      }

      // 5. 显示进度对话框并创建项目
      await this.createProjectWithProgress(projectPath, projectName);

    } catch (error) {
      console.error('[创建项目]: 创建项目失败:', error);
      dialog.showErrorBox('创建项目失败', `创建项目时出现错误：\n${error.message}`);
    }
  }

  // 显示项目名称输入对话框
  async showProjectNameDialog() {
    return new Promise((resolve) => {
      const inputWindow = new BrowserWindow({
        width: 450,
        height: 450,
        resizable: false,
        modal: true,
        parent: this.mainWindow,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        },
        title: '创建新项目'
      });

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>创建新项目</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
              margin: 0;
              padding: 20px;
              background-color: #f5f5f5;
            }
            .container {
              background: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            h2 {
              margin-top: 0;
              color: #333;
              text-align: center;
            }
            .form-group {
              margin-bottom: 20px;
            }
            label {
              display: block;
              margin-bottom: 8px;
              font-weight: 500;
              color: #555;
            }
            input {
              width: 100%;
              padding: 10px;
              border: 2px solid #ddd;
              border-radius: 4px;
              font-size: 14px;
              box-sizing: border-box;
            }
            input:focus {
              border-color: #007acc;
              outline: none;
            }
            .help-text {
              font-size: 12px;
              color: #666;
              margin-top: 5px;
            }
            .error-text {
              font-size: 12px;
              color: #e74c3c;
              margin-top: 5px;
            }
            .buttons {
              display: flex;
              gap: 10px;
              justify-content: flex-end;
              margin-top: 30px;
            }
            button {
              padding: 10px 20px;
              border: none;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
              font-weight: 500;
            }
            .btn-cancel {
              background-color: #6c757d;
              color: white;
            }
            .btn-cancel:hover {
              background-color: #5a6268;
            }
            .btn-create {
              background-color: #007acc;
              color: white;
            }
            .btn-create:hover {
              background-color: #0056b3;
            }
            .btn-create:disabled {
              background-color: #ccc;
              cursor: not-allowed;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>创建新的 Hexo 博客项目</h2>
            <form id="projectForm">
              <div class="form-group">
                <label for="projectName">项目名称：</label>
                <input type="text" id="projectName" placeholder="请输入项目名称" autofocus>
                <div class="help-text">
                  项目名称只能包含英文字母、数字、连字符(-)和下划线(_)，不能以连字符或下划线开头/结尾
                </div>
                <div id="errorMessage" class="error-text" style="display: none;"></div>
              </div>
              <div class="buttons">
                <button type="button" class="btn-cancel" onclick="cancel()">取消</button>
                <button type="submit" class="btn-create" id="createBtn" disabled>创建</button>
              </div>
            </form>
          </div>

          <script>
            const { ipcRenderer } = require('electron');
            const projectNameInput = document.getElementById('projectName');
            const createBtn = document.getElementById('createBtn');
            const errorMessage = document.getElementById('errorMessage');

            // 项目名称验证
            function validateProjectName(name) {
              if (!name || typeof name !== 'string') {
                return { isValid: false, message: '项目名称不能为空' };
              }

              name = name.trim();
              if (name.length === 0) {
                return { isValid: false, message: '项目名称不能为空' };
              }
              if (name.length > 100) {
                return { isValid: false, message: '项目名称不能超过100个字符' };
              }

              const validNamePattern = /^[a-zA-Z0-9_-]+$/;
              if (!validNamePattern.test(name)) {
                return { isValid: false, message: '项目名称只能包含英文字母、数字、连字符(-)和下划线(_)' };
              }

              if (name.startsWith('-') || name.startsWith('_') || name.endsWith('-') || name.endsWith('_')) {
                return { isValid: false, message: '项目名称不能以连字符(-)或下划线(_)开头或结尾' };
              }

              if (name.includes('--')) {
                return { isValid: false, message: '项目名称不能包含连续的连字符(--)' };
              }

              const reservedNames = ['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'];
              if (reservedNames.includes(name.toLowerCase())) {
                return { isValid: false, message: '项目名称不能使用系统保留名称' };
              }

              return { isValid: true, message: '项目名称格式正确' };
            }

            // 实时验证
            projectNameInput.addEventListener('input', function() {
              const name = this.value.trim();
              const validation = validateProjectName(name);
              
              if (validation.isValid) {
                createBtn.disabled = false;
                errorMessage.style.display = 'none';
                this.style.borderColor = '#ddd';
              } else {
                createBtn.disabled = true;
                errorMessage.textContent = validation.message;
                errorMessage.style.display = 'block';
                this.style.borderColor = '#e74c3c';
              }
            });

            // 表单提交
            document.getElementById('projectForm').addEventListener('submit', function(e) {
              e.preventDefault();
              const projectName = projectNameInput.value.trim();
              const validation = validateProjectName(projectName);
              
              if (validation.isValid) {
                ipcRenderer.send('project-name-result', { success: true, projectName });
              }
            });

            // 取消按钮
            function cancel() {
              ipcRenderer.send('project-name-result', { success: false });
            }

            // 回车键提交
            projectNameInput.addEventListener('keydown', function(e) {
              if (e.key === 'Enter' && !createBtn.disabled) {
                document.getElementById('projectForm').dispatchEvent(new Event('submit'));
              }
            });
          </script>
        </body>
        </html>
      `;

      inputWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      // 处理结果
      // const { ipcMain } = require('electron');
      const handler = (event, result) => {
        ipcMain.removeListener('project-name-result', handler);
        inputWindow.close();
        resolve(result);
      };

      ipcMain.on('project-name-result', handler);

      inputWindow.on('closed', () => {
        ipcMain.removeListener('project-name-result', handler);
        resolve({ success: false });
      });
    });
  }

  // 显示自定义确认对话框
  async showCustomConfirmDialog(options = {}) {
    const {
      title = '确认',
      message = '',
      detail = '',
      confirmLabel = '确认',
      cancelLabel = '取消',
      width = 450,
      height = 400,
      type = 'warning'
    } = options;

    return new Promise((resolve) => {
      const confirmWindow = new BrowserWindow({
        width,
        height,
        resizable: false,
        modal: true,
        parent: this.mainWindow,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        },
        title
      });

      const iconMap = {
        warning: '⚠️',
        error: '❌',
        info: 'ℹ️',
        question: '❓'
      };

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>${title}</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
              margin: 0;
              padding: 20px;
              background-color: #f5f5f5;
              height: calc(100vh - 40px);
              box-sizing: border-box;
              display: flex;
              flex-direction: column;
            }
            .container {
              background: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              flex: 1;
              display: flex;
              flex-direction: column;
            }
            .header {
              display: flex;
              align-items: flex-start;
              margin-bottom: 20px;
            }
            .icon {
              font-size: 48px;
              margin-right: 20px;
              flex-shrink: 0;
            }
            .content {
              flex: 1;
            }
            .message {
              font-size: 16px;
              font-weight: 500;
              color: #333;
              margin-bottom: 15px;
              line-height: 1.4;
            }
            .detail {
              font-size: 14px;
              color: #666;
              line-height: 1.6;
              white-space: pre-line;
              flex: 1;
              overflow-y: auto;
              padding: 10px;
              background-color: #f8f9fa;
              border-radius: 4px;
              border: 1px solid #e9ecef;
            }
            .buttons {
              display: flex;
              gap: 10px;
              justify-content: flex-end;
              margin-top: 20px;
              flex-shrink: 0;
            }
            button {
              padding: 10px 20px;
              border: none;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
              font-weight: 500;
              min-width: 80px;
            }
            .btn-cancel {
              background-color: #6c757d;
              color: white;
            }
            .btn-cancel:hover {
              background-color: #5a6268;
            }
            .btn-confirm {
              background-color: #dc3545;
              color: white;
            }
            .btn-confirm:hover {
              background-color: #c82333;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="icon">${iconMap[type] || iconMap.info}</div>
              <div class="content">
                <div class="message">${message}</div>
              </div>
            </div>
            <div class="detail">${detail}</div>
            <div class="buttons">
              <button type="button" class="btn-cancel" onclick="cancel()">${cancelLabel}</button>
              <button type="button" class="btn-confirm" onclick="confirm()">${confirmLabel}</button>
            </div>
          </div>

          <script>
            const { ipcRenderer } = require('electron');

            function confirm() {
              ipcRenderer.send('custom-confirm-result', { confirmed: true });
            }

            function cancel() {
              ipcRenderer.send('custom-confirm-result', { confirmed: false });
            }

            // 键盘事件
            document.addEventListener('keydown', function(e) {
              if (e.key === 'Escape') {
                cancel();
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                confirm();
              }
            });
          </script>
        </body>
        </html>
      `;

      confirmWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      // 处理结果
      const handler = (event, result) => {
        ipcMain.removeListener('custom-confirm-result', handler);
        confirmWindow.close();
        resolve(result);
      };

      ipcMain.on('custom-confirm-result', handler);

      confirmWindow.on('closed', () => {
        ipcMain.removeListener('custom-confirm-result', handler);
        resolve({ confirmed: false });
      });
    });
  }

  async openProject() {
    // 防止重复操作
    if (this.isProjectLoading) {
      console.log('[打开项目]: 项目正在加载中，忽略重复操作');
      return;
    }

    const result = await dialog.showOpenDialog(this.mainWindow, {
      properties: ['openDirectory'],
      title: '选择 Hexo 博客项目目录'
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const projectPath = result.filePaths[0];
      
      // 验证是否是有效的 Hexo 项目
      const validation = await this.validateHexoProject(projectPath);
      if (!validation.isValid) {
        dialog.showErrorBox('无效的 Hexo 项目', validation.message);
        return;
      }
      
      // 显示加载窗口并加载项目
      this.showProjectLoadingWindow(projectPath);
      
      try {
        await this.loadProject(projectPath);
      } catch (error) {
        console.error('[打开项目]: 加载项目失败:', error);
        // 确保在出错时也隐藏加载窗口
        this.hideProjectLoadingWindow();
        throw error;
      }
    }
  }

  // 验证是否是有效的 Hexo 项目
  async validateHexoProject(projectPath) {
    try {
      console.log('验证 Hexo 项目:', projectPath);
      
      // 检查基本文件和目录
      const configPath = path.join(projectPath, '_config.yml');
      const packagePath = path.join(projectPath, 'package.json');
      const sourcePath = path.join(projectPath, 'source');
      const themesPath = path.join(projectPath, 'themes');
      
      // 检查 _config.yml 是否存在
      if (!await fs.pathExists(configPath)) {
        return {
          isValid: false,
          message: '该目录不是有效的 Hexo 项目：缺少 _config.yml 配置文件'
        };
      }
      
      // 检查 package.json 是否存在
      if (!await fs.pathExists(packagePath)) {
        return {
          isValid: false,
          message: '该目录不是有效的 Hexo 项目：缺少 package.json 文件'
        };
      }
      
      // 检查 source 目录是否存在
      if (!await fs.pathExists(sourcePath)) {
        return {
          isValid: false,
          message: '该目录不是有效的 Hexo 项目：缺少 source 目录'
        };
      }
      
      // 检查 package.json 中是否包含 hexo 依赖
      try {
        const packageJson = await fs.readJson(packagePath);
        const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
        
        if (!dependencies.hexo) {
          return {
            isValid: false,
            message: '该目录不是有效的 Hexo 项目：package.json 中未找到 hexo 依赖'
          };
        }
      } catch (error) {
        return {
          isValid: false,
          message: '该目录不是有效的 Hexo 项目：package.json 文件格式错误'
        };
      }
      
      // 检查 _config.yml 的基本格式
      try {
        const configContent = await fs.readFile(configPath, 'utf8');
        
        // 基本检查是否包含 Hexo 项目的关键配置
        if (!configContent.includes('title:') || !configContent.includes('url:')) {
          console.warn('_config.yml 可能格式不完整，但继续加载');
        }
      } catch (error) {
        return {
          isValid: false,
          message: '该目录不是有效的 Hexo 项目：_config.yml 文件无法读取'
        };
      }
      
      console.log('Hexo 项目验证通过:', projectPath);
      return {
        isValid: true,
        message: 'Hexo 项目验证通过'
      };
      
    } catch (error) {
      console.error('验证 Hexo 项目时出错:', error);
      return {
        isValid: false,
        message: `验证项目时出错: ${error.message}`
      };
    }
  }

  async loadProject(projectPath) {
    try {
      console.log('准备加载项目:', projectPath);
      
      // 设置加载状态
      this.isProjectLoading = true;
      this.updateMenuState(); // 更新菜单状态
      
      // 步骤1: 验证项目
      this.updateLoadingStep(1, false);
      const validation = await this.validateHexoProject(projectPath);
      if (!validation.isValid) {
        const errorMessage = `无法加载项目: ${validation.message}`;
        console.error(errorMessage);
        dialog.showErrorBox('无效的 Hexo 项目', validation.message);
        throw new Error(errorMessage);
      }
      this.updateLoadingStep(1, true);
      
      console.log('Hexo 项目验证通过，继续加载');
      
      // 重置状态，防止之前的状态影响新项目
      this.isLoadingWebInterface = false;
      this.lastTokenInjected = null;
      this.pageLoadCount = 0;
      this.tokenInjectionAttempts = 0;
      
      // 重置token验证缓存
      this.lastValidatedToken = null;
      this.lastValidationSuccess = false;
      
      if (this.navigationTimeout) {
        clearTimeout(this.navigationTimeout);
        this.navigationTimeout = null;
      }
      
      // 检查是否是同一个项目，如果是且服务器正在运行，则不需要重启
      if (this.currentProjectPath === projectPath && this.hexoServer) {
        try {
          const serverUrl = this.hexoServer.getUrl();
          // 尝试检查服务器是否仍在正常运行
          const response = await fetch(`${serverUrl}/hexopro/api/desktop/status`);
          if (response.ok) {
            console.log('项目已加载且服务器运行正常，无需重启');
            this.updateLoadingStep(4, false);
            await this.loadWebInterface();
            this.updateLoadingStep(4, true);
            console.log('1022web界面加载完成了返回数据');
            
            // 隐藏加载窗口
            this.hideProjectLoadingWindow();
            this.isProjectLoading = false;
            this.updateMenuState(); // 更新菜单状态
            
            return { url: serverUrl, port: this.hexoServer.getPort() };
          }
        } catch (error) {
          console.log('服务器状态检查失败，需要重启:', error.message);
        }
      }
      
      // 步骤2: 停止现有服务器
      this.updateLoadingStep(2, false);
      if (this.hexoServer) {
        console.log('停止现有服务器...');
        try {
          await this.hexoServer.stop();
          // 等待一段时间确保端口完全释放
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.warn('正常停止失败，尝试强制停止:', error);
          await this.hexoServer.forceStop();
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      this.updateLoadingStep(2, true);
      
      this.currentProjectPath = projectPath;
      
      // 步骤3: 启动新服务器
      this.updateLoadingStep(3, false);
      console.log('创建新的服务器实例...');
      this.hexoServer = new HexoProServer(projectPath);
      
      // 尝试启动服务器，包含重试机制
      let serverInfo;
      let attempts = 0;
      const maxAttempts = 3;
      
      while (attempts < maxAttempts) {
        try {
          console.log(`尝试启动服务器 (${attempts + 1}/${maxAttempts})...`);
          serverInfo = await this.hexoServer.start();
          console.log('服务器启动成功:', serverInfo);
          break;
        } catch (error) {
          attempts++;
          console.error(`服务器启动失败 (尝试 ${attempts}/${maxAttempts}):`, error);
          
          if (attempts < maxAttempts) {
            // 如果是端口占用错误，等待更长时间
            if (error.message.includes('EADDRINUSE') || error.code === 'EADDRINUSE') {
              console.log('端口被占用，等待端口释放...');
              await new Promise(resolve => setTimeout(resolve, 3000));
              
              // 尝试强制清理
              if (this.hexoServer) {
                await this.hexoServer.forceStop();
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
              
              // 重新创建服务器实例
              this.hexoServer = new HexoProServer(projectPath);
            } else {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } else {
            throw error;
          }
        }
      }
      
      if (!serverInfo) {
        throw new Error('服务器启动失败，已达到最大重试次数');
      }
      this.updateLoadingStep(3, true);
      
      // 保存项目路径
      this.safeStoreSet('lastProjectPath', projectPath);
      
      // 等待服务器完全启动
      await this.waitForServer(serverInfo.url);
      
      // 步骤4: 加载Web界面
      this.updateLoadingStep(4, false);
      console.log('[Desktop]: 即将调用loadWebInterface方法...');
      await this.loadWebInterface();
      console.log('[Desktop]: loadWebInterface方法调用完成');
      this.updateLoadingStep(4, true);
      
      // 隐藏加载窗口
      this.hideProjectLoadingWindow();
      this.isProjectLoading = false;
      this.updateMenuState(); // 更新菜单状态
      
      console.log('1100web界面加载完成了返回数据');
      // 通知渲染进程项目已加载（如果当前在主页）
      if (this.mainWindow) {
        console.log('[Desktop]: mainWindow存在，开始检查URL...');
        // 确保在 loadWebInterface 完成导航后，如果URL没有改变，则强制刷新以确保前端状态更新
        const finalUrl = this.mainWindow.webContents.getURL();
        console.log('[Desktop]: 获取到finalUrl:', finalUrl);
        console.log('[Desktop]: serverInfo.url:', serverInfo.url);
        if (finalUrl.startsWith(serverInfo.url)) {
          console.log('[Desktop]: 项目切换完成，Web界面URL与预期一致，通知前端项目已加载。', serverInfo.url, '\n ', finalUrl);
          // this.mainWindow.webContents.send('project-loaded', {
          //   projectPath: projectPath,
          //   serverUrl: serverInfo.url
          // });
          console.log('准备return serverInfo');
          return serverInfo;
        } else {
          // 如果 loadWebInterface 后的 URL 不是期望的（例如还在旧项目的URL上），则强制加载新URL
          console.log(`[Desktop]: 项目切换后，URL (${finalUrl}) 与预期 (${serverInfo.url})不符，强制重新加载新URL。`);
          console.log('[Desktop]: 即将调用mainWindow.loadURL...');
          await this.mainWindow.loadURL(`${serverInfo.url}/pro/login?reason=project_switched`);
          console.log('[Desktop]: mainWindow.loadURL调用完成');
          // 添加缺少的return语句
          return serverInfo;
        }
      }

      // if(this.progressWindow){
      //   this.progressWindow.webContents.send('progress-window-close');
      // }
      console.log('1123 加载项目完成', serverInfo);
      return serverInfo;
    } catch (error) {
      console.error('加载项目失败:', error);
      
      // 隐藏加载窗口
      this.hideProjectLoadingWindow();
      this.isProjectLoading = false;
      this.updateMenuState(); // 更新菜单状态
      
      // 清理失败的服务器实例
      if (this.hexoServer) {
        try {
          await this.hexoServer.forceStop();
        } catch (cleanupError) {
          console.error('清理失败的服务器时出错:', cleanupError);
        }
        this.hexoServer = null;
      }
      
      // 显示错误对话框
      const errorMessage = error.message.includes('EADDRINUSE') 
        ? '端口被占用，请稍后重试或重启应用程序'
        : `加载项目失败: ${error.message}`;
        
      dialog.showErrorBox('错误', errorMessage);
      throw error;
    }
  }

  async waitForServer(serverUrl, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`${serverUrl}/hexopro/api/desktop/status`);
        if (response.ok) {
          return true;
        }
      } catch (error) {
        // 服务器还未就绪，继续等待
        console.log('服务器还未就绪，继续等待')
      }
      
      // 等待500ms后重试
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    throw new Error('服务器启动超时');
  }

  openSettings() {
    // 通知渲染进程打开设置页面
    this.mainWindow.webContents.send('open-settings');
  }

  showAbout() {
    dialog.showMessageBox(this.mainWindow, {
      type: 'info',
      title: '关于 Hexo Pro Desktop',
      message: 'Hexo Pro Desktop',
      detail: `版本: ${app.getVersion()}\n基于 Electron 的 Hexo 博客管理工具\n\n© 2024 wuzheng`,
      buttons: ['确定']
    });
  }

  async initialize() {
    // 设置应用名称
    app.setName('Hexo Pro Desktop');

    // 当应用准备好时创建窗口
    app.whenReady().then(async () => {
      await this.createWindow();
      this.createMenu();

      // 在macOS上，如果是从隐藏状态恢复，尝试恢复之前的状态
      if (process.platform === 'darwin' && this.windowHidden) {
        const restored = await this.restoreWindowState();
        if (restored) {
          console.log('[Desktop]: 已恢复到之前的状态');
          return;
        }
      }

      // 检查是否有上次打开的项目
      const lastProjectPath = this.safeStoreGet('lastProjectPath');
      if (lastProjectPath && await fs.pathExists(lastProjectPath)) {
        // 直接加载项目，会自动显示Web界面
        await this.loadProject(lastProjectPath);
      } else {
        // 没有项目时，启动静态服务器并显示主页界面
        console.log('没有上次的项目，启动静态服务器');
        this.hexoServer = new HexoProServer(null);
        try {
          const serverInfo = await this.hexoServer.startStaticServer();
          console.log('静态服务器已启动:', serverInfo.url);
        } catch (error) {
          console.error('启动静态服务器失败:', error);
        }
      }
    });

    // 当所有窗口关闭时退出应用（macOS 除外）
    app.on('window-all-closed', async () => {
      // await this.cleanup();
      
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    // 当应用激活时创建窗口或显示现有窗口（macOS）
    app.on('activate', async () => {
      if (process.platform === 'darwin') {
        if (this.mainWindow) {
          // 如果窗口存在但被隐藏，显示它并尝试恢复状态
          if (this.windowHidden) {
            console.log('[Desktop]: 从程序坞恢复应用，显示现有窗口');
            this.mainWindow.show();
            this.windowHidden = false;
            
            // 尝试恢复到之前的状态
            const restored = await this.restoreWindowState();
            if (!restored) {
              console.log('[Desktop]: 无法恢复之前状态，检查是否有上次的项目');
              // 如果无法恢复状态，检查是否有项目需要加载
              const lastProjectPath = this.safeStoreGet('lastProjectPath');
              if (lastProjectPath && await fs.pathExists(lastProjectPath) && 
                  this.currentProjectPath !== lastProjectPath) {
                await this.loadProject(lastProjectPath);
              }
            }
          } else {
            // 窗口存在且可见，前置到最前面
            this.mainWindow.show();
            this.mainWindow.focus();
          }
        } else {
          // 窗口不存在，创建新窗口
          console.log('[Desktop]: 窗口不存在，创建新窗口');
          await this.createWindow();
          this.createMenu();
          
          // 检查是否有上次打开的项目
          const lastProjectPath = this.safeStoreGet('lastProjectPath');
          if (lastProjectPath && await fs.pathExists(lastProjectPath)) {
            await this.loadProject(lastProjectPath);
          } else {
            // 启动静态服务器
            this.hexoServer = new HexoProServer(null);
            try {
              const serverInfo = await this.hexoServer.startStaticServer();
              console.log('静态服务器已启动:', serverInfo.url);
            } catch (error) {
              console.error('启动静态服务器失败:', error);
            }
          }
        }
      } else {
        // 非 macOS 平台的处理
        if (BrowserWindow.getAllWindows().length === 0) {
          await this.createWindow();
        }
      }
    });

    // 在应用退出前清理
    app.on('before-quit', async (event) => {
      // 标记应用正在退出，这样close事件就不会阻止退出
      app.isQuittingApp = true;
      
      event.preventDefault();
      await this.cleanup();
      app.exit(0);
    });

    // 处理 IPC 消息
    this.setupIPC();
  }

  // 清理资源的统一方法
  async cleanup() {
    try {
      console.log('开始清理资源...');
      
      // 设置加载状态为false
      this.isProjectLoading = false;
      
      // 清理加载窗口
      this.hideProjectLoadingWindow();
      
      // 清理导航相关的状态
      this.isLoadingWebInterface = false;
      this.lastTokenInjected = null;
      this.pageLoadCount = 0;
      this.tokenInjectionAttempts = 0;
      
      // 清理token验证缓存
      this.lastValidatedToken = null;
      this.lastValidationSuccess = false;
      
      if (this.navigationTimeout) {
        clearTimeout(this.navigationTimeout);
        this.navigationTimeout = null;
      }
      
      // 停止服务器
      if (this.hexoServer) {
        console.log('正在停止服务器...');
        try {
          await this.hexoServer.stop();
          console.log('服务器已停止');
        } catch (error) {
          console.warn('正常停止失败，尝试强制停止:', error);
          try {
            await this.hexoServer.forceStop();
            console.log('服务器已强制停止');
          } catch (forceError) {
            console.error('强制停止失败:', forceError);
          }
        }
        this.hexoServer = null;
      }
      
      console.log('资源清理完成');
    } catch (error) {
      console.error('资源清理失败:', error);
    }
  }

  setupIPC() {
    // 获取项目信息
    ipcMain.handle('get-project-info', () => {
      return {
        projectPath: this.safeStoreGet('lastProjectPath'),
        serverUrl: this.hexoServer ? this.hexoServer.getUrl() : null,
        isLoading: this.isProjectLoading // 添加加载状态
      };
    });

    // 打开项目
    ipcMain.handle('open-project', async () => {
      if (this.isProjectLoading) {
        throw new Error('项目正在加载中，请稍候再试');
      }
      await this.openProject();
    });

    // 创建项目
    ipcMain.handle('create-project', async () => {
      if (this.isProjectLoading) {
        throw new Error('项目正在加载中，请稍候再试');
      }
      await this.createNewProject();
    });

    // 选择文件夹
    ipcMain.handle('select-folder', async () => {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        properties: ['openDirectory']
      });
      return result.canceled ? null : result.filePaths[0];
    });

    // 选择文件
    ipcMain.handle('select-file', async (event, options = {}) => {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        properties: ['openFile'],
        filters: options.filters || []
      });
      return result.canceled ? null : result.filePaths[0];
    });

    // 显示保存对话框
    ipcMain.handle('show-save-dialog', async (event, options = {}) => {
      const result = await dialog.showSaveDialog(this.mainWindow, options);
      return result.canceled ? null : result.filePath;
    });

    // 显示消息框
    ipcMain.handle('show-message', async (event, options) => {
      const result = await dialog.showMessageBox(this.mainWindow, options);
      return result;
    });

    // 打开外部链接
    ipcMain.handle('open-external', async (event, url) => {
      await shell.openExternal(url);
    });

    // 重启服务器
    ipcMain.handle('restart-server', async () => {
      if (this.hexoServer) {
        await this.hexoServer.restart();
        return this.hexoServer.getUrl();
      }
      return null;
    });

    // 加载Web管理界面
    ipcMain.handle('load-web-interface', async () => {
      if (this.isProjectLoading) {
        console.log('[IPC]: 项目正在加载中，跳过Web界面加载请求');
        return false;
      }
      
      if (this.hexoServer && this.currentProjectPath) {
        // 避免重复调用
        if (this.isLoadingWebInterface) {
          console.log('[IPC]: 已有Web界面加载流程在进行，跳过IPC调用');
          return false;
        }
        
        await this.loadWebInterface();
        console.log('1406web界面加载完成了返回数据');
        return true;
      }
      return false;
    });

    // 强制重启应用（用于严重的端口问题）
    ipcMain.handle('force-restart-app', async () => {
      console.log('用户请求强制重启应用...');
      await this.cleanup();
      app.relaunch();
      app.exit(0);
    });

    // 验证 Hexo 项目
    ipcMain.handle('validate-hexo-project', async (event, projectPath) => {
      return await this.validateHexoProject(projectPath);
    });
  }

  async closeProject() {
    try {
      // 防止重复操作
      if (this.isProjectLoading) {
        console.log('[关闭项目]: 项目正在加载中，忽略关闭操作');
        return;
      }
      
      // 设置加载状态
      this.isProjectLoading = true;
      this.updateMenuState(); // 更新菜单状态
      
      // 显示关闭项目的加载窗口
      this.showProjectClosingWindow();
      
      console.log('正在关闭当前项目...');
      
      // 步骤1: 停止当前的 Hexo Pro 服务器
      this.updateLoadingStep(1, false);
      if (this.hexoServer) {
        try {
          await this.hexoServer.stop();
          // 等待端口释放
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.warn('正常停止失败，强制停止服务器:', error);
          await this.hexoServer.forceStop();
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      this.updateLoadingStep(1, true);

      // 清除保存的项目路径
      this.safeStoreDelete('lastProjectPath');
      this.currentProjectPath = null;

      // 步骤2: 启动静态服务器，包含重试机制
      this.updateLoadingStep(2, false);
      console.log('启动静态服务器...');
      this.hexoServer = new HexoProServer(null);
      
      let attempts = 0;
      const maxAttempts = 3;
      
      while (attempts < maxAttempts) {
        try {
          await this.hexoServer.startStaticServer();
          console.log('静态服务器启动成功');
          break;
        } catch (error) {
          attempts++;
          console.error(`静态服务器启动失败 (尝试 ${attempts}/${maxAttempts}):`, error);
          
          if (attempts < maxAttempts) {
            if (error.message.includes('EADDRINUSE') || error.code === 'EADDRINUSE') {
              console.log('端口被占用，等待端口释放...');
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              // 强制清理后重新创建实例
              if (this.hexoServer) {
                await this.hexoServer.forceStop();
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
              this.hexoServer = new HexoProServer(null);
            } else {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } else {
            throw error;
          }
        }
      }
      this.updateLoadingStep(2, true);

      // 步骤3: 返回主页界面
      this.updateLoadingStep(3, false);
      await this.returnToHome();
      this.updateLoadingStep(3, true);
      
      // 隐藏加载窗口并更新状态
      this.hideProjectLoadingWindow();
      this.isProjectLoading = false;
      this.updateMenuState(); // 更新菜单状态

    } catch (error) {
      console.error('关闭项目失败:', error);
      
      // 隐藏加载窗口
      this.hideProjectLoadingWindow();
      this.isProjectLoading = false;
      this.updateMenuState(); // 更新菜单状态
      
      // 错误处理：强制清理并显示错误
      if (this.hexoServer) {
        try {
          await this.hexoServer.forceStop();
        } catch (cleanupError) {
          console.error('清理失败的服务器时出错:', cleanupError);
        }
      }
      
      const errorMessage = error.message.includes('EADDRINUSE')
        ? '端口被占用，请重启应用程序'
        : `关闭项目失败: ${error.message}`;
        
      dialog.showErrorBox('错误', errorMessage);
    }
  }

  async returnToHome() {
    try {
      // 加载桌面端专用的前端界面
      const indexPath = path.join(__dirname, '../renderer/index.html');
      await this.mainWindow.loadFile(indexPath);
      
      console.log('已返回主页界面');
    } catch (error) {
      console.error('返回主页失败:', error);
      dialog.showErrorBox('错误', `返回主页失败: ${error.message}`);
    }
  }

  async loadWebInterface() {
    try {
      console.log('[Desktop]: 开始加载Web界面...');
      
      // 防止并发调用和循环重定向
      if (this.isLoadingWebInterface) {
        console.log('[Desktop]: 已有Web界面加载流程在进行，跳过重复调用');
        return;
      }
      
      this.isLoadingWebInterface = true;
      this.pageLoadCount++;
      
      console.log('', this.pageLoadCount);
      
      // 如果页面加载次数过多，说明可能陷入了循环
      if (this.pageLoadCount > 3) {
        console.warn('[Desktop]: 页面加载次数过多，可能陷入循环，停止自动刷新');
        this.isLoadingWebInterface = false;
        return;
      }
      
      if (!this.mainWindow) throw new Error('主窗口不存在');
      if (!this.hexoServer) throw new Error('服务器未启动');

      // 暂时禁用navigationTimeout，避免事件竞争
      if (this.navigationTimeout) {
        clearTimeout(this.navigationTimeout);
        this.navigationTimeout = null;
      }

      // 0. 首先清理可能存在的无效tokens
      console.log('[Desktop]: 步骤0: 清理无效tokens...');
      await this.cleanupInvalidTokens();

      // 1. 准备并验证Token
      console.log('[Desktop]: 步骤1: 准备并验证Token...');
      const validToken = await this.prepareAndValidateToken();

      // 2. 确定目标URL - 只有在token确实有效的情况下才跳转到主页
      let webUrl;
      let  needsNavigation = false;
      console.log('tokenInjectionAttempts', this.tokenInjectionAttempts, this.maxTokenInjectionAttempts);
      if (validToken && validToken !== this.lastTokenInjected && this.tokenInjectionAttempts < this.maxTokenInjectionAttempts) {
        // 有有效token，先尝试注入，如果注入成功再跳转到主页
        webUrl = `${this.hexoServer.getUrl()}/pro`; // 先跳转到登录页，让前端处理token验证
        console.log('[Desktop]: 检测到有效token，先跳转到登录页让前端验证:', webUrl);
      } else {
        // 如果 token 无效或不存在，或者注入次数过多，都跳转到登录页，并明确告知原因
        const reason = validToken ? 'token_injection_failed' : 'token_invalid_or_missing';
        webUrl = `${this.hexoServer.getUrl()}/pro/login?reason=${reason}`; 
        console.log(`[Desktop]: 没有有效token或注入失败，跳转到登录页 (reason: ${reason}):`, webUrl);
        needsNavigation = true;
      }

      // 3. 如果当前页面已经在正确的URL，就不需要重新加载
      const currentUrl = this.mainWindow.webContents.getURL();
      console.log('currentUrl:', currentUrl);
  
      
      if (needsNavigation) {
        console.log('[Desktop]: 步骤2: 需要导航到Web界面，当前URL:', currentUrl);
        await this.mainWindow.loadURL(webUrl);//  这里会触发 did-navigate-in-page 事件
        console.log('[Desktop]: URL已加载，等待页面ready事件...');

        let pageLoadResolved = false;
        const waitForPageLoad = async () => {
          return new Promise((resolve, reject) => {
            const done = () => {
              if (!pageLoadResolved) {
                pageLoadResolved = true;
                resolve();
              }
            };
            
            // 添加超时机制
            const timeout = setTimeout(() => {
              if (!pageLoadResolved) {
                pageLoadResolved = true;
                console.warn('[Desktop]: 页面加载超时，继续执行');
                resolve();
              }
            }, 10000); // 10秒超时
        
            this.mainWindow.webContents.once('did-finish-load', () => {
              console.log('[Desktop]: did-finish-load事件触发');
              clearTimeout(timeout);
              done();
            });
            console.log('挂载dom-ready事件');
            this.mainWindow.webContents.once('dom-ready', async () => {
              console.log('[Desktop]: dom-ready事件触发');
              // 4. 注入localStorage拦截器
              console.log('[Desktop]: 步骤3: 注入localStorage拦截器...');
              await this.injectLocalStorageInterceptor();
              clearTimeout(timeout);
              done();
            });
          });
        };
        await waitForPageLoad();
        console.log('[Desktop]: 页面ready事件处理完毕，开始注入流程...');
      } else {
        console.log('[Desktop]: 步骤2: 当前已在Web界面，无需重新导航，当前URL:', currentUrl);
      }
      
      // 等待一小段时间，确保拦截器有足够时间初始化
      await new Promise(resolve => setTimeout(resolve, 300)); 

      // 5. 如果有有效token且之前没有注入过相同的token，才注入
      console.log('validToken:', validToken, this.lastTokenInjected, this.tokenInjectionAttempts, this.maxTokenInjectionAttempts);
      console.log('lastTokenInjected:', this.lastTokenInjected);
      if (validToken && validToken !== this.lastTokenInjected && this.tokenInjectionAttempts < this.maxTokenInjectionAttempts) {
        console.log('[Desktop]: 步骤4: 发现有效且新的token，尝试注入...');
        this.tokenInjectionAttempts++;
        
        const tokenInjectedSuccessfully = await this.injectToken(validToken);
        
        if (tokenInjectedSuccessfully) {
          console.log('[Desktop]: Token注入成功，记录已注入的token');
          this.lastTokenInjected = validToken;
          
          // 不再自动跳转到主页，让前端来处理token验证和页面跳转
          console.log('[Desktop]: Token注入成功，等待前端处理token验证和页面跳转');
          await this.mainWindow.webContents.loadURL(webUrl);
        } else {
          console.log('[Desktop]: Token注入失败');
        }
      } else if (validToken === this.lastTokenInjected && this.lastTokenInjected !== null) {
        console.log('[Desktop]: 步骤4: Token已经注入过，跳过重复注入');
      } else if (this.tokenInjectionAttempts >= this.maxTokenInjectionAttempts) {
        console.log('[Desktop]: 步骤4: Token注入尝试次数已达上限，跳过');
      } else {
        console.log('[Desktop]: 步骤4: 没有有效token，用户需要手动登录');
      }
      
      // 6. 注入桌面端功能
      console.log('[Desktop]: 步骤5: 注入桌面端功能...');
      await this.injectDesktopFeatures(); // 添加桌面端元素标记、以及桌面端的博文链接跳转功能
      
      console.log('[Desktop]: Web界面加载流程完成。');

    } catch (error) {
      console.error('[Desktop]: 加载Web界面主流程失败:', error);
      // 应急处理：即使主流程失败，也尝试注入拦截器
      try {
        console.warn('[Desktop]: 发生错误，尝试应急注入...');
        if (this.mainWindow && this.mainWindow.webContents) {
          await this.injectLocalStorageInterceptor();
          await this.injectDesktopFeatures();
        }
      } catch (fallbackError) {
        console.error('[Desktop]: 应急注入也失败:', fallbackError);
      }
    } finally {
      // 清理状态
      this.isLoadingWebInterface = false;
    }
  }

  async prepareAndValidateToken() {
    console.log('[Desktop]: 准备并验证token...');
    console.log('[Desktop]: 当前项目路径:', this.currentProjectPath);
    
    if (!this.currentProjectPath) {
      console.log('[Desktop]: 当前项目路径未设置，无法准备token');
      return null;
    }
    
    const token = this.authManager.getToken(this.currentProjectPath);
    console.log('[Desktop]: 获取到的token:', token ? '存在(长度:' + token.length + ')' : '不存在');
    
    if (!token) {
      console.log('[Desktop]: 没有token，用户需要手动登录');
      return null;
    }
    
    // 如果token和上次验证的相同，且上次验证成功，跳过重复验证
    if (token === this.lastValidatedToken && this.lastValidationSuccess) {
      console.log('[Desktop]: Token与上次验证的相同且上次验证成功，跳过重复验证');
      return token;
    }
    
    // 验证token有效性
    console.log('[Desktop]: 开始验证token有效性...');
    try {
      const serverUrl = this.hexoServer.getUrl();
      const isValid = await this.validateTokenWithServer(serverUrl, token);
      
      // 记录验证结果
      this.lastValidatedToken = token;
      this.lastValidationSuccess = isValid;
      
      if (isValid) {
        console.log('[Desktop]: Token验证成功，可以使用');
        return token;
      } else {
        console.log('[Desktop]: Token验证失败，清除无效token');
        // 清除AuthManager中的无效token
        this.authManager.clearToken(this.currentProjectPath);
        console.log('[Desktop]: 已从AuthManager中清除无效token，用户需要重新登录');
        return null;
      }
    } catch (error) {
      console.error('[Desktop]: Token验证过程中出错:', error);
      // 验证出错时，为了安全起见，也清除token
      console.log('[Desktop]: 由于验证出错，清除token以确保安全');
      this.authManager.clearToken(this.currentProjectPath);
      
      // 记录验证失败
      this.lastValidatedToken = token;
      this.lastValidationSuccess = false;
      
      return null;
    }
  }

  async validateTokenWithServer(serverUrl, token) {
    try {
      console.log('[Desktop]: 向服务器验证token...');
      
      const response = await fetch(`${serverUrl}/hexopro/api/userInfo`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(3000) // 缩短超时时间到3秒
      });
      
      console.log('[Desktop]: Token验证响应状态:', response.status);
      
      if (response.ok) {
        const data = await response.json();
        console.log('[Desktop]: Token验证响应数据:', data);
        
        // 检查是否返回了有效的用户信息且没有401错误码
        if (data && data.code !== 401) {
          console.log('[Desktop]: Token验证成功');
          return true;
        } else {
          console.log('[Desktop]: Token验证失败 - 返回了401错误码');
          return false;
        }
      } else if (response.status === 401) {
        console.log('[Desktop]: Token验证失败 - 401未授权');
        return false;
      } else {
        console.log('[Desktop]: Token验证失败 - 服务器错误:', response.status);
        return false;
      }
    } catch (error) {
      console.error('[Desktop]: Token验证请求失败:', error);
      // 超时或网络错误时，为了避免影响用户体验，认为token可能有效
      if (error.name === 'TimeoutError' || error.message.includes('timeout')) {
        console.log('[Desktop]: Token验证超时，假设token有效以避免阻塞用户');
        return true;
      }
      return false;
    }
  }

  async prepareTokenInjection() {
    console.log('[Desktop]: 准备token注入数据...');
    console.log('[Desktop]: 当前项目路径:', this.currentProjectPath);
    
    if (!this.currentProjectPath) {
      console.log('[Desktop]: 当前项目路径未设置，无法准备token');
      return null;
    }
    
    // 显示所有保存的token
    const allTokens = {};
    if (this.authManager && this.authManager.tokens) {
      for (const [path, tokenValue] of this.authManager.tokens) {
        allTokens[path] = tokenValue ? '存在' : '不存在';
      }
      console.log('[Desktop]: 所有保存的token:', allTokens);
    }
    
    const token = this.authManager.getToken(this.currentProjectPath);
    console.log('[Desktop]: 获取到的token:', token ? '存在(长度:' + token.length + ')' : '不存在');
    
    return token;
  }

  async injectToken(tokenToInject) {
    try {
      console.log('[Desktop]: 开始执行token注入...');
      
      if (tokenToInject) {
        console.log('[Desktop]: 准备注入的token长度:', tokenToInject.length);
        
        // 验证token格式 - JWT应该是3个用.分隔的base64字符串
        const jwtPattern = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
        if (!jwtPattern.test(tokenToInject)) {
          console.error('[Desktop]: Token格式无效，不是标准JWT格式:', tokenToInject.substring(0, 50) + '...');
          return false;
        }
        
        const script = `
          (function() {
            try {
              const token = ${JSON.stringify(tokenToInject)};
              
              // 验证接收到的token格式
              const jwtPattern = /^[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]*$/;
              if (!jwtPattern.test(token)) {
                console.error('[Hexo Pro Desktop]: 接收到的token格式无效:', token.substring(0, 50) + '...');
                return { success: false, message: 'Token格式无效' };
              }
              
              // 清除可能存在的旧token
              const oldToken = localStorage.getItem('hexoProToken');
              if (oldToken) {
                console.log('[Hexo Pro Desktop]: 清除旧token，长度:', oldToken.length);
              }
              
              localStorage.setItem('hexoProToken', token);
              console.log('[Hexo Pro Desktop]: Token已注入到localStorage，长度:', token.length);
              
              const savedToken = localStorage.getItem('hexoProToken');
              if (savedToken === token) {
                console.log('[Hexo Pro Desktop]: Token注入验证成功');
                return { success: true, message: 'Token注入成功' };
              } else {
                console.error('[Hexo Pro Desktop]: Token注入验证失败');
                console.error('[Hexo Pro Desktop]: 期望:', token.substring(0, 50) + '...');
                console.error('[Hexo Pro Desktop]: 实际:', savedToken ? savedToken.substring(0, 50) + '...' : 'null');
                return { success: false, message: 'Token注入验证失败' };
              }
            } catch (error) {
              console.error('[Hexo Pro Desktop]: Token注入过程中出错:', error);
              return { success: false, message: error.message };
            }
          })();
        `;
        
        const result = await this.mainWindow.webContents.executeJavaScript(script);
        console.log('[Desktop]: Token注入结果:', result);
        
        return result && result.success;
        
      } else {
        console.log('[Desktop]: 没有提供token，跳过注入');
        return false;
      }
    } catch (error) {
      console.error('[Desktop]: Token注入过程中发生异常:', error);
      console.log('[Desktop]: 继续执行，忽略token注入错误');
      return false;
    }
  }

  async injectLocalStorageInterceptor() {
    try {
      console.log('[Desktop]: 注入localStorage拦截器...');
      
      const interceptorScript = `
        (function() {
          try {
            // 检查是否已经注入过（通过检查localStorage.setItem是否已被重写）
            const isAlreadyInjected = localStorage.setItem.toString().includes('Hexo Pro Desktop');
            
            if (isAlreadyInjected && window.hexoProDesktopInterceptorInjected) {
              console.log('[Hexo Pro Desktop]: localStorage拦截器已存在，跳过重复注入');
              return { success: true, message: '拦截器已存在' };
            }
            
            console.log('[Hexo Pro Desktop]: 开始注入localStorage拦截器...');
            
            // 标记当前运行环境为桌面端
            window.isHexoProDesktop = true;
            window.hexoProDesktopInterceptorInjected = true;
            
            // 保存原始的localStorage.setItem方法（如果还没有保存的话）
            if (!window.originalLocalStorageSetItem) {
              window.originalLocalStorageSetItem = localStorage.setItem;
            }
            
            // 重写localStorage.setItem方法
            localStorage.setItem = function(key, value) {
              try {
                // 先调用原始方法
                window.originalLocalStorageSetItem.call(this, key, value);
                console.log('[Hexo Pro Desktop]: localStorage.setItem被调用，key:', key, 'value长度:', value ? value.length : 0);
                
                // 如果是设置token，验证格式并同时保存到桌面端AuthManager
                if (key === 'hexoProToken' && value) {
                  console.log('[Hexo Pro Desktop]: 检测到token设置，开始验证格式');
                  
                  // 验证token格式 - JWT应该是3个用.分隔的base64字符串
                  const jwtPattern = /^[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]*$/;
                  if (!jwtPattern.test(value)) {
                    console.error('[Hexo Pro Desktop]: Token格式无效，拒绝处理:', value.substring(0, 50) + '...');
                    console.error('[Hexo Pro Desktop]: Token必须是标准JWT格式');
                    return; // 不处理格式错误的token
                  }
                  
                  console.log('[Hexo Pro Desktop]: Token格式验证通过，准备保存到桌面端AuthManager');
                  console.log('[Hexo Pro Desktop]: Token内容预览:', value.substring(0, 20) + '...');
                  
                  // 立即验证localStorage中是否真的保存了token
                  const savedToken = localStorage.getItem('hexoProToken');
                  if (savedToken === value) {
                    console.log('[Hexo Pro Desktop]: localStorage保存验证成功');
                  } else {
                    console.error('[Hexo Pro Desktop]: localStorage保存验证失败');
                  }
                  
                  // 直接发送请求，不使用延时
                  console.log('[Hexo Pro Desktop]: 开始发送保存token请求...');
                  fetch('/hexopro/api/desktop/save-token', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ token: value })
                  }).then(function(response) {
                    console.log('[Hexo Pro Desktop]: 保存token请求响应状态:', response.status);
                    if (!response.ok) {
                      console.error('[Hexo Pro Desktop]: 请求失败，状态码:', response.status);
                    }
                    return response.json();
                  }).then(function(result) {
                    console.log('[Hexo Pro Desktop]: 保存token响应结果:', result);
                    if (result.success) {ƒ
                      console.log('[Hexo Pro Desktop]: Token已成功保存到桌面端AuthManager');
                    } else {
                      console.error('[Hexo Pro Desktop]: 保存token到桌面端失败:', result.message);
                    }
                  }).catch(function(error) {
                    console.error('[Hexo Pro Desktop]: 保存token到桌面端请求出错:', error);ƒ
                  });
                }
              } catch (error) {
                console.error('[Hexo Pro Desktop]: localStorage.setItem拦截器内部错误:', error);
                // 如果拦截器出错，至少确保原始操作完成
                try {
                  window.originalLocalStorageSetItem.call(this, key, value);
                } catch (fallbackError) {
                  console.error('[Hexo Pro Desktop]: localStorage.setItem回退操作也失败:', fallbackError);
                }
              }
            };
            
            // 添加全局调试函数
            window.debugHexoProDesktop = function() {
              console.log('[Hexo Pro Desktop Debug Info]:');
              console.log('- 拦截器已注入:', window.hexoProDesktopInterceptorInjected);
              console.log('- 是否桌面端:', window.isHexoProDesktop);
              console.log('- 当前token:', localStorage.getItem('hexoProToken') ? '存在' : '不存在');
              console.log('- localStorage.setItem已被重写:', localStorage.setItem.toString().includes('Hexo Pro Desktop'));
              console.log('- 原始setItem已保存:', !!window.originalLocalStorageSetItem);
            };
            
            // 定期检查拦截器是否还存在（防止被其他代码覆盖）
            window.hexoProInterceptorChecker = setInterval(function() {
              if (!localStorage.setItem.toString().includes('Hexo Pro Desktop')) {
                console.warn('[Hexo Pro Desktop]: 检测到拦截器被覆盖，重新注入...');
                window.hexoProDesktopInterceptorInjected = false;
                // 触发重新注入（通过设置一个全局标记）
                window.needReinjection = true;
              }
            }, 5000); // 每5秒检查一次
            
            console.log('[Hexo Pro Desktop]: localStorage拦截器注入成功');
            console.log('[Hexo Pro Desktop]: 使用 window.debugHexoProDesktop() 查看调试信息');
            return { success: true, message: 'localStorage拦截器注入成功' };
            
          } catch (error) {
            console.error('[Hexo Pro Desktop]: localStorage拦截器注入失败:', error);
            return { success: false, message: error.message };
          }
        })();
      `;
      
      const result = await this.mainWindow.webContents.executeJavaScript(interceptorScript);
      console.log('[Desktop]: localStorage拦截器注入结果:', result);
      
      if (result && result.success) {
        console.log('[Desktop]: localStorage拦截器注入成功');
      } else {
        console.error('[Desktop]: localStorage拦截器注入失败:', result ? result.message : '未知错误');
      }
      
    } catch (error) {
      console.error('[Desktop]: localStorage拦截器注入异常:', error);
      // 不抛出错误，避免影响整个应用
      console.log('[Desktop]: 继续执行，localStorage拦截器注入失败但不影响基本功能');
    }
  }

  async injectDesktopFeatures() {
    try {
      console.log('[Desktop]: 开始注入桌面端功能...');
      
      // 检查主窗口是否存在
      if (!this.mainWindow || !this.mainWindow.webContents) {
        console.warn('[Desktop]: 主窗口或webContents不存在，跳过功能注入');
        return;
      }

      // 注入桌面端UI增强功能
      console.log('[Desktop]: 注入UI增强功能...');
      const result = await this.mainWindow.webContents.executeJavaScript(`
        (function() {
          // 避免重复添加
          if (document.querySelector('#desktop-enhancements')) {
            console.log('[Hexo Pro Desktop]: 桌面端功能已存在，跳过重复注入');
            return { success: true, message: '功能已存在' };
          }
          
          // 创建桌面端功能容器（用于标记这是桌面版本）
          const desktopContainer = document.createElement('div');
          desktopContainer.id = 'desktop-enhancements';
          desktopContainer.style.display = 'none'; // 隐藏容器，只是用来标记
          desktopContainer.setAttribute('data-desktop-version', 'true');
          document.body.appendChild(desktopContainer);
          
          // 重写window.open来正确处理博客链接预览
          if (typeof window !== 'undefined' && typeof window.open === 'function') {
            const originalWindowOpen = window.open;
            window.open = function(url, target, features) {
              console.log('[Hexo Pro Desktop]: Intercepted window.open call:', url, target);
              
              // 检查是否是博客permalink（相对路径且不是以http开头）
              if (url && typeof url === 'string' && !url.startsWith('http') && !url.startsWith('//')) {
                // 构建指向Hexo内置服务器的完整URL
                // 动态获取当前服务器端口
                const currentPort = window.location.port || '4000';
                const blogUrl = window.location.protocol + '//' + window.location.hostname + ':' + currentPort + (url.startsWith('/') ? url : '/' + url);
                
                console.log('[Hexo Pro Desktop]: 转换博客链接从', url, '到', blogUrl);
                
                // 使用electron的外部链接打开功能
                if (window.electronAPI && window.electronAPI.openExternal) {
                  window.electronAPI.openExternal(blogUrl);
                  return null; // 阻止默认的window.open行为
                } else {
                  // 如果electronAPI不可用，使用原始的window.open打开完整URL
                  return originalWindowOpen.call(this, blogUrl, target, features);
                }
              } else {
                // 对于其他URL（如外部链接），使用electron的外部链接打开
                if (window.electronAPI && window.electronAPI.openExternal) {
                  window.electronAPI.openExternal(url);
                  return null;
                } else {
                  // 如果electronAPI不可用，使用原始window.open
                  return originalWindowOpen.call(this, url, target, features);
                }
              }
            };
            console.log('[Hexo Pro Desktop]: window.open已重写，支持博客链接预览');
          }
          
          console.log('[Hexo Pro Desktop]: 桌面端UI功能已注入');
          return { success: true, message: '注入成功' };
        })();
      `);
      
      console.log('[Desktop]: 桌面端功能注入结果:', result);
      console.log('[Desktop]: 桌面端功能注入完成');

    } catch (error) {
      console.error('[Desktop]: 注入桌面端功能失败:', error);
      // 不抛出错误，因为这不影响基本功能
      console.log('[Desktop]: 桌面端功能注入失败，但继续执行');
    }
  }

  async cleanupInvalidTokens() {
    try {
      console.log('[Desktop]: 开始清理无效tokens...');
      
      const script = `
        (function() {
          try {
            const token = localStorage.getItem('hexoProToken');
            if (!token) {
              console.log('[Hexo Pro Desktop]: 没有找到token，无需清理');
              return { success: true, message: '没有token' };
            }
            
            console.log('[Hexo Pro Desktop]: 检查token格式，长度:', token.length);
            
            // 验证token格式 - JWT应该是3个用.分隔的base64字符串
            const jwtPattern = /^[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]*$/;
            if (!jwtPattern.test(token)) {
              console.warn('[Hexo Pro Desktop]: 发现格式无效的token，清理中...');
              console.warn('[Hexo Pro Desktop]: 无效token内容:', token.substring(0, 100) + '...');
              localStorage.removeItem('hexoProToken');
              return { success: true, message: '已清理无效token', cleaned: true };
            }
            
            console.log('[Hexo Pro Desktop]: Token格式正常，无需清理');
            return { success: true, message: 'Token格式正常', cleaned: false };
          } catch (error) {
            console.error('[Hexo Pro Desktop]: 清理token时出错:', error);
            // 出错时也尝试清理token
            try {
              localStorage.removeItem('hexoProToken');
            } catch (e) {}
            return { success: false, message: error.message, cleaned: true };
          }
        })();
      `;
      
      const result = await this.mainWindow.webContents.executeJavaScript(script);
      console.log('[Desktop]: Token清理结果:', result);
      
      return result && result.cleaned;
    } catch (error) {
      console.error('[Desktop]: 清理token过程中发生异常:', error);
      return false;
    }
  }

  // 带进度的项目创建
  async createProjectWithProgress(projectPath, projectName) {
    const progressWindow = new BrowserWindow({
      width: 500,
      height: 600,
      resizable: false,
      modal: true,
      parent: this.mainWindow,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      title: '创建项目中...'
    });

    this.progressWindow = progressWindow;

    const progressHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>创建项目中...</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
          }
          .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            height: calc(100vh - 40px);
            box-sizing: border-box;
          }
          h2 {
            margin-top: 0;
            color: #333;
            text-align: center;
          }
          .progress-info {
            margin-bottom: 20px;
          }
          .current-step {
            font-weight: 500;
            color: #007acc;
            margin-bottom: 10px;
          }
          .log-container {
            background-color: #1e1e1e;
            color: #d4d4d4;
            padding: 15px;
            border-radius: 4px;
            height: 200px;
            overflow-y: auto;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 12px;
            line-height: 1.4;
          }
          .log-line {
            margin-bottom: 5px;
          }
          .log-stdout {
            color: #d4d4d4;
          }
          .log-stderr {
            color: #f48771;
          }
          .log-info {
            color: #4fc1ff;
          }
          .loading-spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid #f3f3f3;
            border-top: 3px solid #007acc;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 10px;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          .success-message {
            color: #28a745;
            font-weight: 500;
            text-align: center;
            margin-top: 20px;
          }
          .error-message {
            color: #dc3545;
            font-weight: 500;
            text-align: center;
            margin-top: 20px;
          }
          .buttons {
            display: flex;
            justify-content: center;
            margin-top: 20px;
          }
          button {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            background-color: #007acc;
            color: white;
          }
          button:hover {
            background-color: #0056b3;
          }
          button:disabled {
            background-color: #ccc;
            cursor: not-allowed;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>创建 Hexo 项目</h2>
          <div class="progress-info">
            <div class="current-step" id="currentStep">
              <span class="loading-spinner"></span>
              正在准备创建项目...
            </div>
          </div>
          <div class="log-container" id="logContainer"></div>
          <div id="resultMessage"></div>
        </div>

        <script>
          const { ipcRenderer } = require('electron');
          const logContainer = document.getElementById('logContainer');
          const currentStep = document.getElementById('currentStep');
          const resultMessage = document.getElementById('resultMessage');
          const buttonsContainer = document.getElementById('buttonsContainer');

          function addLog(message, type = 'info') {
            const logLine = document.createElement('div');
            logLine.className = \`log-line log-\${type}\`;
            logLine.textContent = new Date().toLocaleTimeString() + ' - ' + message;
            logContainer.appendChild(logLine);
            logContainer.scrollTop = logContainer.scrollHeight;
          }

          function updateStep(step) {
            currentStep.innerHTML = '<span class="loading-spinner"></span>' + step;
          }

          function showResult(success, message) {
            currentStep.innerHTML = success ? '✅ 创建完成' : '❌ 创建失败';
            resultMessage.innerHTML = \`<div class="\${success ? 'success' : 'error'}-message">\${message}</div>\`;
            buttonsContainer.style.display = 'block';
          }

          function closeWindow() {
            ipcRenderer.send('close-progress-window');
          }

          // 接收进度更新
          ipcRenderer.on('progress-update', (event, data) => {
            if (data.step) {
              updateStep(data.step);
            }
            if (data.log) {
              addLog(data.log, data.logType || 'info');
            }
            if (data.result) {
              showResult(data.result.success, data.result.message);
            }
          });

          // 窗口关闭时清理
          window.addEventListener('beforeunload', () => {
            ipcRenderer.send('close-progress-window');
          });
        </script>
      </body>
      </html>
    `;

    progressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(progressHtml)}`);

    // 开始创建项目
    try {
      await this.performProjectCreation(projectPath, projectName, progressWindow);
    } catch (error) {
      console.error('[创建项目]: 项目创建过程中出错:', error);
      progressWindow.webContents.send('progress-update', {
        result: {
          success: false,
          message: `创建项目失败: ${error.message}`
        }
      });
    }

    // 处理窗口关闭
    // const { ipcMain } = require('electron');
    const closeHandler = () => {
      ipcMain.removeListener('close-progress-window', closeHandler);
      console.log('[创建项目]: 窗口关闭');
      if (!progressWindow.isDestroyed()) {
        progressWindow.close();
      }
    };
    ipcMain.on('close-progress-window', closeHandler);

    progressWindow.on('closed', () => {
      ipcMain.removeListener('close-progress-window', closeHandler);
    });
  }

  // 执行实际的项目创建
  async performProjectCreation(projectPath, projectName, progressWindow) {
    const sendProgress = (step, log, logType) => {
      if (!progressWindow.isDestroyed()) {
        progressWindow.webContents.send('progress-update', { step, log, logType });
      }
    };

    try {
      // 步骤1: 初始化Hexo项目
      sendProgress('正在初始化 Hexo 项目...', `开始初始化项目: ${projectName}`);
      
      await this.executeCommand(`hexo init ${projectName}`, path.dirname(projectPath), (output) => {
        sendProgress(null, output.data.trim(), output.type === 'stderr' ? 'stderr' : 'stdout');
      });

      sendProgress('Hexo 项目初始化完成', 'Hexo 项目结构创建成功');

      // 步骤2: 安装依赖
      sendProgress('正在安装项目依赖...', '开始安装 npm 依赖');
      
      await this.executeCommand('npm install', projectPath, (output) => {
        sendProgress(null, output.data.trim(), output.type === 'stderr' ? 'stderr' : 'stdout');
      });

      sendProgress('依赖安装完成', 'npm 依赖安装成功');

      // 步骤3: 验证项目
      sendProgress('正在验证项目...', '验证项目结构');
      
      const validation = await this.validateHexoProject(projectPath);
      if (!validation.isValid) {
        throw new Error(`项目验证失败: ${validation.message}`);
      }

      sendProgress('项目验证完成', '项目结构验证通过');

      // 步骤4: 加载项目
      sendProgress('正在加载项目...', '启动项目服务');
      console.log('[创建项目]: 即将调用loadProject方法，项目路径:', projectPath);
      
      await this.loadProject(projectPath);
      
      console.log('[创建项目]: loadProject方法调用完成，继续后续步骤');
      sendProgress('项目创建完成', '项目已成功创建并加载');

      // 发送成功结果
      if (!progressWindow.isDestroyed()) {
        console.log('[创建项目]: 发送成功结果到进度窗口');
        progressWindow.webContents.send('progress-update', {
          result: {
            success: true,
            message: `项目 "${projectName}" 创建成功！\n路径: ${projectPath}`
          }
        });
        console.log('[创建项目]: 成功结果已发送');
        progressWindow.close();
      } else {
        console.log('[创建项目]: 进度窗口已销毁，跳过发送成功结果');
      }

    } catch (error) {
      console.error('[创建项目]: 项目创建失败:', error);
      
      // 清理失败的项目目录
      try {
        if (await fs.pathExists(projectPath)) {
          await fs.remove(projectPath);
          sendProgress(null, '已清理失败的项目目录', 'info');
        }
      } catch (cleanupError) {
        console.error('[创建项目]: 清理失败的项目目录时出错:', cleanupError);
      }

      throw error;
    }
  }

  // 显示项目加载窗口
  showProjectLoadingWindow(projectPath) {
    if (this.loadingWindow && !this.loadingWindow.isDestroyed()) {
      return; // 如果已经存在加载窗口，直接返回
    }

    this.loadingWindow = new BrowserWindow({
      width: 400,
      height: 500,
      resizable: false,
      modal: true,
      parent: this.mainWindow,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      title: '加载项目中...',
      frame: false,
      transparent: true,
      alwaysOnTop: true
    });

    const projectName = path.basename(projectPath);
    const loadingHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>加载项目中...</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            margin: 0;
            padding: 0;
            background: transparent;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
          }
          .loading-container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 12px;
            padding: 30px;
            text-align: center;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            min-width: 300px;
          }
          .loading-spinner {
            width: 50px;
            height: 50px;
            border: 4px solid #f3f3f3;
            border-top: 4px solid #007acc;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          .loading-title {
            font-size: 18px;
            font-weight: 500;
            color: #333;
            margin-bottom: 10px;
          }
          .loading-subtitle {
            font-size: 14px;
            color: #666;
            margin-bottom: 5px;
          }
          .project-name {
            font-size: 16px;
            font-weight: 500;
            color: #007acc;
            word-break: break-all;
          }
          .loading-steps {
            margin-top: 20px;
            font-size: 12px;
            color: #888;
            text-align: left;
          }
          .step {
            margin: 5px 0;
            padding-left: 20px;
            position: relative;
          }
          .step.active::before {
            content: '→';
            position: absolute;
            left: 0;
            color: #007acc;
            font-weight: bold;
          }
          .step.completed::before {
            content: '✓';
            position: absolute;
            left: 0;
            color: #28a745;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <div class="loading-container">
          <div class="loading-spinner"></div>
          <div class="loading-title">正在加载项目</div>
          <div class="loading-subtitle">项目名称：</div>
          <div class="project-name">${projectName}</div>
          <div class="loading-steps">
            <div class="step active" id="step1">验证项目结构</div>
            <div class="step" id="step2">停止现有服务</div>
            <div class="step" id="step3">启动项目服务</div>
            <div class="step" id="step4">加载Web界面</div>
          </div>
        </div>

        <script>
          const { ipcRenderer } = require('electron');
          
          let currentStep = 1;
          
          function updateStep(stepNumber, completed = false) {
            if (stepNumber > currentStep) {
              // 标记之前的步骤为完成
              for (let i = 1; i < stepNumber; i++) {
                const step = document.getElementById('step' + i);
                if (step) {
                  step.className = 'step completed';
                }
              }
              currentStep = stepNumber;
            }
            
            const step = document.getElementById('step' + stepNumber);
            if (step) {
              step.className = completed ? 'step completed' : 'step active';
            }
          }
          
          // 接收步骤更新
          ipcRenderer.on('loading-step-update', (event, stepNumber, completed) => {
            updateStep(stepNumber, completed);
          });
          
          // 窗口关闭时清理
          window.addEventListener('beforeunload', () => {
            ipcRenderer.removeAllListeners('loading-step-update');
          });
        </script>
      </body>
      </html>
    `;

    this.loadingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
    
    // 窗口关闭时清理
    this.loadingWindow.on('closed', () => {
      this.loadingWindow = null;
    });
  }

  // 更新加载步骤
  updateLoadingStep(stepNumber, completed = false) {
    if (this.loadingWindow && !this.loadingWindow.isDestroyed()) {
      this.loadingWindow.webContents.send('loading-step-update', stepNumber, completed);
    }
  }

  // 隐藏项目加载窗口
  hideProjectLoadingWindow() {
    if (this.loadingWindow && !this.loadingWindow.isDestroyed()) {
      this.loadingWindow.close();
    }
    this.loadingWindow = null;
  }

  // 显示项目关闭加载窗口
  showProjectClosingWindow() {
    if (this.loadingWindow && !this.loadingWindow.isDestroyed()) {
      return; // 如果已经存在加载窗口，直接返回
    }

    this.loadingWindow = new BrowserWindow({
      width: 400,
      height: 250,
      resizable: false,
      modal: true,
      parent: this.mainWindow,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      title: '关闭项目中...',
      frame: false,
      transparent: true,
      alwaysOnTop: true
    });

    const loadingHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>关闭项目中...</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            margin: 0;
            padding: 0;
            background: transparent;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
          }
          .loading-container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 12px;
            padding: 30px;
            text-align: center;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            min-width: 300px;
          }
          .loading-spinner {
            width: 50px;
            height: 50px;
            border: 4px solid #f3f3f3;
            border-top: 4px solid #dc3545;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          .loading-title {
            font-size: 18px;
            font-weight: 500;
            color: #333;
            margin-bottom: 20px;
          }
          .loading-steps {
            margin-top: 20px;
            font-size: 12px;
            color: #888;
            text-align: left;
          }
          .step {
            margin: 5px 0;
            padding-left: 20px;
            position: relative;
          }
          .step.active::before {
            content: '→';
            position: absolute;
            left: 0;
            color: #dc3545;
            font-weight: bold;
          }
          .step.completed::before {
            content: '✓';
            position: absolute;
            left: 0;
            color: #28a745;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <div class="loading-container">
          <div class="loading-spinner"></div>
          <div class="loading-title">正在关闭项目</div>
          <div class="loading-steps">
            <div class="step active" id="step1">停止项目服务</div>
            <div class="step" id="step2">启动主页服务</div>
            <div class="step" id="step3">返回主页面</div>
          </div>
        </div>

        <script>
          const { ipcRenderer } = require('electron');
          
          let currentStep = 1;
          
          function updateStep(stepNumber, completed = false) {
            if (stepNumber > currentStep) {
              // 标记之前的步骤为完成
              for (let i = 1; i < stepNumber; i++) {
                const step = document.getElementById('step' + i);
                if (step) {
                  step.className = 'step completed';
                }
              }
              currentStep = stepNumber;
            }
            
            const step = document.getElementById('step' + stepNumber);
            if (step) {
              step.className = completed ? 'step completed' : 'step active';
            }
          }
          
          // 接收步骤更新
          ipcRenderer.on('loading-step-update', (event, stepNumber, completed) => {
            updateStep(stepNumber, completed);
          });
          
          // 窗口关闭时清理
          window.addEventListener('beforeunload', () => {
            ipcRenderer.removeAllListeners('loading-step-update');
          });
        </script>
      </body>
      </html>
    `;

    this.loadingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);
    
    // 窗口关闭时清理
    this.loadingWindow.on('closed', () => {
      this.loadingWindow = null;
    });
  }
}

// 创建应用实例并初始化
const hexoProDesktop = new HexoProDesktop();
hexoProDesktop.initialize().catch(console.error); 