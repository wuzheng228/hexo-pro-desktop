const path = require('path');
const fs = require('fs-extra');
const express = require('express');
const bodyParser = require('body-parser');
const serveStatic = require('serve-static');
const net = require('net');
const mime = require('mime');
// 移除不需要的代理中间件

// 复制 hexo-pro 的核心模块
const api = require('./hexo-pro-core/api');
const databaseManager = require('./hexo-pro-core/database-manager'); // 导入数据库管理器

class HexoProServer {
  constructor(projectPath) {
    this.projectPath = projectPath;
    this.app = null;
    this.server = null;
    this.hexoServer = null; // Hexo内置服务器实例
    this.hexoPort = 4000; // Hexo内置服务器端口（和hexo s默认端口一致）
    this.hexoInstance = null;
    this.isWatching = false;
  }

  async start() {
    try {
      // 在开始前确保数据库管理器重置
      if (this.projectPath) {
        console.log('[Hexo Server]: 重置数据库管理器状态');
        databaseManager.reset();
      }
      
      // 初始化 Hexo 实例
      await this.initHexo();
      
      // 启动集成的 Hexo 服务器（包含博客静态文件、API 和管理界面）
      await this.startIntegratedHexoServer();
      
      console.log(`Hexo Pro Server started at http://localhost:${this.hexoPort}`);
      
      return {
        url: `http://localhost:${this.hexoPort}`,
        port: this.hexoPort
      };
    } catch (error) {
      console.error('启动 Hexo Pro 服务器失败:', error);
      throw error;
    }
  }

  async startIntegratedHexoServer() {
    if (!this.hexoInstance) {
      throw new Error('Hexo 实例未初始化');
    }

    try {
      console.log('[Hexo Server]: 启动集成的 Hexo 服务器...');
      
      // 先注册Hexo插件（在服务器启动前）
      await this.registerHexoPlugin();
      
      // 先尝试找到可用端口，优先使用4000
      const availablePort = await this.findAvailablePort(4000);
      this.hexoPort = availablePort;
      
      console.log(`[Hexo Server]: 使用端口 ${this.hexoPort}`);
      
      // 启动 Hexo 内置服务器
      this.hexoServer = await this.hexoInstance.call('server', {
        port: this.hexoPort,
        open: false,
        watch: true,
        draft: false,
        log: false // 减少日志输出
      });
      
      console.log(`[Hexo Server]: 集成的 Hexo 服务器已启动在端口 ${this.hexoPort}`);
    } catch (error) {
      console.error('[Hexo Server]: 启动集成的 Hexo 服务器失败:', error);
      throw error;
    }
  }

  async registerHexoPlugin() {
    console.log('[Hexo Server]: 注册Hexo插件...');
    
    // 创建一个临时插件来添加我们的路由
    this.hexoInstance.extend.filter.register('server_middleware', (app) => {
      console.log('[Hexo Server]: Hexo插件 - 添加中间件到应用');
      
      // 检查是否已经初始化过数据库，避免重复初始化
      if (!global.hexoProDbInitialized) {
        console.log('[Hexo Server]: 首次初始化，设置中间件...');
        
        // 添加查询字符串解析中间件
        const querystring = require('querystring');
        app.use((req, res, next) => {
          if (!req.query && req.url.includes('?')) {
            const queryStr = req.url.split('?')[1];
            req.query = querystring.parse(queryStr);
          }
          next();
        });
        
        // 添加body parser中间件（用于API）
        const bodyParser = require('body-parser');
        app.use('/hexopro/api', bodyParser.json({ limit: '50mb' }));
        app.use('/hexopro/api', bodyParser.urlencoded({ extended: true }));
        
        // 添加hexo-pro管理界面的静态文件服务
        const serveStatic = require('serve-static');
        app.use('/pro', serveStatic(path.join(__dirname, 'hexo-pro-core/www')));
        
        // 处理前端路由（SPA）
        app.use('/pro', (req, res, next) => {
          console.log('[Hexo Server]: 收到前端路由请求:', req.originalUrl);
          console.log('[Hexo Server]: 请求方法:', req.method);
          console.log('[Hexo Server]: 请求头:', req.headers);
          
          const isStaticFile = ['.html', '.css', '.js', '.jpg', '.png', '.gif', '.svg', '.ico'].some(
            extension => req.originalUrl.endsWith(extension)
          );
          
          console.log('[Hexo Server]: 是否静态文件:', isStaticFile);
          
          if (!isStaticFile) {
            const indexPath = path.resolve(__dirname, 'hexo-pro-core/www/index.html');
            console.log('[Hexo Server]: 准备发送index.html, 路径:', indexPath);
            
            // 检查文件是否存在
            if (!fs.existsSync(indexPath)) {
              console.error('[Hexo Server]: index.html不存在:', indexPath);
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('File not found');
              return;
            }
            
            // 检查 sendFile 方法是否可用
            if (typeof res.sendFile === 'function') {
              console.log('[Hexo Server]: 使用 sendFile 方法');
              res.sendFile(indexPath);
            } else if (res._originalSendFile && typeof res._originalSendFile === 'function') {
              // 使用保存的原始方法
              console.log('[Hexo Server]: 使用 _originalSendFile 方法');
              res._originalSendFile.call(res, indexPath);
            } else {
              // 降级方案：直接读取文件并发送
              console.log('[Hexo Server]: 使用降级方案读取文件');
              const fs = require('fs');
              
              fs.readFile(indexPath, (err, data) => {
                if (err) {
                  console.error('[Hexo Server]: 读取文件失败:', err);
                  res.writeHead(404, { 'Content-Type': 'text/plain' });
                  res.end('File not found');
                } else {
                  const contentType = mime.getType(indexPath) || 'text/html';
                  console.log('[Hexo Server]: 发送文件内容, Content-Type:', contentType);
                  res.writeHead(200, { 'Content-Type': contentType });
                  res.end(data);
                }
              });
            }
          } else {
            console.log('[Hexo Server]: 静态文件请求，交给下一个中间件处理');
            next();
          }
        });
        
        // 添加桌面端特定路由
        this.setupDesktopRoutesForConnect(app);
        
        // 标记数据库已初始化
        global.hexoProDbInitialized = true;
      } else {
        console.log('[Hexo Server]: 数据库已初始化，跳过中间件设置');
      }
      
      // 添加 hexo-pro 的 API 路由（每次都需要重新绑定到新的app实例）
      api(app, this.hexoInstance).then(() => {
        console.log('[Hexo Server]: API路由已添加');
      }).catch(error => {
        console.error('[Hexo Server]: 添加API路由失败:', error);
      });
      
      console.log('[Hexo Server]: Hexo插件 - 中间件添加完成');
    });
    
    console.log('[Hexo Server]: Hexo插件已注册');
  }

  async findAvailablePort(startPort) {
    for (let port = startPort; port < startPort + 100; port++) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    
    throw new Error(`无法找到可用端口，从 ${startPort} 开始尝试了100个端口`);
  }

  async isPortAvailable(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, () => {
        server.close(() => {
          resolve(true);
        });
      });
      server.on('error', () => {
        resolve(false);
      });
    });
  }

  setupDesktopRoutesForConnect(app) {
    // 桌面端状态路由（统一状态处理）
    app.use('/hexopro/api/desktop/status', (req, res) => {
      const hasProject = !!this.hexoInstance;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        status: hasProject ? 'running' : 'static-server',
        projectPath: this.projectPath || null,
        port: this.hexoPort,
        uptime: process.uptime(),
        hasProject: hasProject
      }));
    });

    // 桌面端认证检查
    app.use('/hexopro/api/desktop/auth-check', (req, res) => {
      // 检查是否需要登录
      const needsAuth = global.actualNeedLogin;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        needsAuth,
        isDesktop: true
      }));
    });

    // 桌面端保存token（处理前端登录成功）
    app.use('/hexopro/api/desktop/save-token', (req, res) => {
      console.log('[Desktop Server]: /hexopro/api/desktop/save-token 被调用');
      console.log('[Desktop Server]: 请求方法:', req.method);
      console.log('[Desktop Server]: 请求头:', req.headers);
      console.log('[Desktop Server]: 请求体:', req.body);
      
      if (req.method === 'POST') {
        try {
          const { token } = req.body;
          console.log('[Desktop Server]: 接收到保存token请求');
          console.log('[Desktop Server]: Token长度:', token ? token.length : '无token');
          console.log('[Desktop Server]: Token内容预览:', token ? token.substring(0, 20) + '...' : '无token');
          console.log('[Desktop Server]: 项目路径:', this.projectPath);
          console.log('[Desktop Server]: global.desktopAuthManager存在:', !!global.desktopAuthManager);
          
          if (!token) {
            console.error('[Desktop Server]: 请求中缺少token');
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, message: '缺少token' }));
            return;
          }
          
          // 验证token格式 - JWT应该是3个用.分隔的base64字符串
          const jwtPattern = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
          if (!jwtPattern.test(token)) {
            console.error('[Desktop Server]: Token格式无效，拒绝保存:', token.substring(0, 50) + '...');
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, message: 'Token格式无效，必须是标准JWT格式' }));
            return;
          }
          
          console.log('[Desktop Server]: Token格式验证通过');
          
          if (!this.projectPath) {
            console.error('[Desktop Server]: 当前项目路径未设置');
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, message: '当前项目路径未设置' }));
            return;
          }
          
          if (!global.desktopAuthManager) {
            console.error('[Desktop Server]: AuthManager实例不可用');
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, message: 'AuthManager不可用' }));
            return;
          }
          
          console.log('[Desktop Server]: 正在保存token到AuthManager...');
          
          // 异步保存token，避免阻塞响应
          global.desktopAuthManager.setToken(this.projectPath, token).then(() => {
            console.log('[Desktop Server]: Token保存操作完成');
            
            // 验证token是否真的被保存了
            setTimeout(() => {
              const savedToken = global.desktopAuthManager.getToken(this.projectPath);
              if (savedToken === token) {
                console.log('[Desktop Server]: Token验证成功，已正确保存到:', this.projectPath);
              } else {
                console.error('[Desktop Server]: Token验证失败，保存可能有问题');
                console.log('[Desktop Server]: 预期token长度:', token.length);
                console.log('[Desktop Server]: 实际token长度:', savedToken ? savedToken.length : '无token');
              }
            }, 100);
          }).catch((error) => {
            console.error('[Desktop Server]: 保存token时出错:', error);
          });
          
          console.log('[Desktop Server]: 立即响应成功（异步保存）');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, message: 'Token保存请求已接收' }));
          
        } catch (error) {
          console.error('[Desktop Server]: 保存token失败:', error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, message: '保存token失败: ' + error.message }));
        }
      } else {
        console.log('[Desktop Server]: 不支持的请求方法:', req.method);
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, message: '方法不允许，仅支持POST' }));
      }
    });

    // 获取项目信息
    app.use('/hexopro/api/desktop/project-info', (req, res) => {
      if (!this.hexoInstance) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: '项目未加载',
          message: '请先选择一个 Hexo 项目'
        }));
        return;
      }
      
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        projectPath: this.projectPath,
        projectName: path.basename(this.projectPath),
        hexoVersion: this.hexoInstance.version,
        configPath: path.join(this.projectPath, '_config.yml')
      }));
    });

    // 获取文件监听状态
    app.use('/hexopro/api/desktop/watch-status', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        isWatching: this.isWatching
      }));
    });
  }

  async initHexo() {
    // 动态引入 Hexo
    const Hexo = require('hexo');
    
    // 创建 Hexo 实例
    this.hexoInstance = new Hexo(this.projectPath, {
      debug: false,
      safe: false,
      silent: false,
      config: path.join(this.projectPath, '_config.yml')
    });

    // 初始化 Hexo
    await this.hexoInstance.init();
    
    // 加载插件和主题
    await this.hexoInstance.load();
    
    // 将 hexo 实例设为全局变量，供插件使用
    global.hexo = this.hexoInstance;
    
    // 立即初始化数据库管理器
    console.log('[Hexo Server]: 预初始化数据库管理器...');
    try {
      await databaseManager.initialize(this.hexoInstance);
      console.log('[Hexo Server]: 数据库管理器预初始化完成');
    } catch (error) {
      console.error('[Hexo Server]: 数据库管理器预初始化失败:', error);
      throw error;
    }
    
    // 构建索引文件（用于全局搜索）
    try {
      const hexoProCore = require('./hexo-pro-core/index');
      if (hexoProCore && hexoProCore.buildIndex) {
        console.log('[Hexo Server]: 构建搜索索引...');
        // 临时设置全局hexo变量供buildIndex使用
        const originalHexo = global.hexo;
        global.hexo = this.hexoInstance;
        hexoProCore.buildIndex();
        global.hexo = originalHexo;
        console.log('[Hexo Server]: 搜索索引构建完成');
      }
    } catch (error) {
      console.error('[Hexo Server]: 构建搜索索引失败:', error);
      // 如果构建索引失败，创建一个空的索引文件以避免读取错误
      const fs = require('fs');
      const indexPath = path.join(this.projectPath, 'blogInfoList.json');
      if (!fs.existsSync(indexPath)) {
        fs.writeFileSync(indexPath, JSON.stringify([]));
        console.log('[Hexo Server]: 创建了空的搜索索引文件');
      }
    }
    
    // 启动文件监听
    await this.startWatching();
  }

  async startWatching() {
    if (!this.hexoInstance || this.isWatching) {
      return;
    }

    try {
      console.log('[Hexo Server]: 设置文件监听事件...');
      this.isWatching = true;

      // 注意：不需要手动启动watch，因为Hexo内置服务器已经包含了watch功能
      // 只需要监听相关事件来获取状态更新

      // 监听特定的文件变化事件
      this.hexoInstance.on('generateAfter', () => {
        console.log('[Hexo Server]: 静态文件已重新生成');
      });

      this.hexoInstance.on('processBefore', () => {
        console.log('[Hexo Server]: 开始处理文件变化...');
      });

      this.hexoInstance.on('processAfter', () => {
        console.log('[Hexo Server]: 文件变化处理完成');
      });

      // 监听文件变化事件
      this.hexoInstance.on('ready', () => {
        console.log('[Hexo Server]: Hexo 已就绪');
      });

      // 监听更详细的文件变化
      if (this.hexoInstance.source) {
        this.hexoInstance.source.on('processAfter', (file) => {
          // console.log('[Hexo Server]: 文件已处理:', file.source);
        });
      }

      console.log('[Hexo Server]: 文件监听事件已设置');

    } catch (error) {
      console.error('[Hexo Server]: 设置文件监听事件失败:', error);
      this.isWatching = false;
    }
  }

  async stopWatching() {
    if (!this.isWatching || !this.hexoInstance) {
      return;
    }

    try {
      console.log('[Hexo Server]: 停止文件监听...');
      
      // 停止监听
      if (this.hexoInstance.unwatch) {
        await this.hexoInstance.unwatch();
      }
      
      this.isWatching = false;
      console.log('[Hexo Server]: 文件监听已停止');
    } catch (error) {
      console.error('[Hexo Server]: 停止文件监听失败:', error);
    }
  }

  async stop() {
    console.log('正在停止 Hexo Pro Server...');
    
    // 停止文件监听
    await this.stopWatching();
    
    // 停止 Hexo 内置服务器
    if (this.hexoServer) {
      try {
        console.log('[Hexo Server]: 停止 Hexo 内置服务器...');
        // Hexo server 的停止方法
        if (typeof this.hexoServer.close === 'function') {
          await this.hexoServer.close();
        }
        this.hexoServer = null;
        console.log('[Hexo Server]: Hexo 内置服务器已停止');
      } catch (error) {
        console.error('[Hexo Server]: 停止 Hexo 内置服务器时出错:', error);
      }
    }
    
    // 停止基本服务器（如果有）
    if (this.server) {
      try {
        this.server.close();
        this.server = null;
      } catch (error) {
        console.error('[Hexo Server]: 停止基本服务器时出错:', error);
      }
    }
    
    // 清理全局状态
    if (global.hexo) {
      delete global.hexo;
    }
    if (global.actualNeedLogin !== undefined) {
      global.actualNeedLogin = false;
    }
    if (global.jwtSecret) {
      delete global.jwtSecret;
    }
    
    // 清理数据库初始化标记，允许下次重新初始化
    if (global.hexoProDbInitialized) {
      delete global.hexoProDbInitialized;
    }
    
    // 重置数据库管理器状态
    console.log('[Hexo Server]: 重置数据库管理器状态');
    databaseManager.reset();
    
    // 重置端口为默认值
    this.hexoPort = 4000;
    
    console.log('Hexo Pro Server stopped');
  }

  // 强制停止服务器（用于错误恢复）
  async forceStop() {
    console.log('强制停止 Hexo Pro Server...');
    
    // 停止文件监听
    await this.stopWatching();
    
    // 强制停止 Hexo 内置服务器
    if (this.hexoServer) {
      try {
        console.log('[Hexo Server]: 强制停止 Hexo 内置服务器...');
        if (typeof this.hexoServer.close === 'function') {
          this.hexoServer.close();
        }
      } catch (error) {
        console.error('[Hexo Server]: 强制停止 Hexo 内置服务器时出错:', error);
      }
      this.hexoServer = null;
    }
    
    // 清理所有状态
    this.hexoInstance = null;
    this.isWatching = false;
    
    // 清理全局状态
    if (global.hexo) {
      delete global.hexo;
    }
    if (global.actualNeedLogin !== undefined) {
      global.actualNeedLogin = false;
    }
    if (global.jwtSecret) {
      delete global.jwtSecret;
    }
    
    // 清理数据库初始化标记
    if (global.hexoProDbInitialized) {
      delete global.hexoProDbInitialized;
    }
    
    // 重置数据库管理器状态
    console.log('[Hexo Server]: 强制重置数据库管理器状态');
    databaseManager.reset();
    
    // 重置端口
    this.hexoPort = 4000;
    
    console.log('服务器已强制停止');
  }

  async restart() {
    console.log('重启 Hexo Pro Server...');
    
    // 停止当前服务器
    await this.stop();
    
    // 重新初始化状态
    this.isWatching = false;
    
    // 重新初始化 Hexo
    if (this.hexoInstance) {
      // 清理当前实例
      delete global.hexo;
      this.hexoInstance = null;
    }
    
    // 重新启动
    await this.start();
  }

  getUrl() {
    return `http://localhost:${this.hexoPort}`;
  }

  getPort() {
    return this.hexoPort;
  }

  getProjectPath() {
    return this.projectPath;
  }

  getHexoInstance() {
    return this.hexoInstance;
  }

  // 获取博客配置
  async getBlogConfig() {
    const configPath = path.join(this.projectPath, '_config.yml');
    if (await fs.pathExists(configPath)) {
      const yaml = require('js-yaml');
      const content = await fs.readFile(configPath, 'utf8');
      return yaml.load(content);
    }
    return null;
  }

  // 保存博客配置
  async saveBlogConfig(config) {
    const configPath = path.join(this.projectPath, '_config.yml');
    const yaml = require('js-yaml');
    const content = yaml.dump(config);
    await fs.writeFile(configPath, content, 'utf8');
  }

  // 生成静态文件
  async generate() {
    if (this.hexoInstance) {
      await this.hexoInstance.call('generate');
    }
  }

  // 部署博客
  async deploy() {
    if (this.hexoInstance) {
      await this.hexoInstance.call('deploy');
    }
  }

  // 清理缓存
  async clean() {
    if (this.hexoInstance) {
      await this.hexoInstance.call('clean');
    }
  }

  async startStaticServer() {
    try {
      // 创建简单的静态服务器（用于当没有项目加载时）
      this.app = express();
      
      // 设置基本中间件
      this.setupBasicMiddleware();
      
      // 启动服务器
      await this.startBasicServer();
      
      console.log(`静态服务器已启动 at http://localhost:${this.hexoPort}`);
      
      return {
        url: `http://localhost:${this.hexoPort}`,
        port: this.hexoPort
      };
    } catch (error) {
      console.error('启动静态服务器失败:', error);
      throw error;
    }
  }

  setupBasicMiddleware() {
    // 静态文件服务
    this.app.use('/pro', serveStatic(path.join(__dirname, 'hexo-pro-core/www')));

    // 处理前端路由
    this.app.use('/pro', (req, res, next) => {
      // 检查是否为静态文件请求
      const isStaticFile = ['.html', '.css', '.js', '.jpg', '.png', '.gif', '.svg', '.ico'].some(
        extension => req.originalUrl.endsWith(extension)
      );
      
      if (!isStaticFile) {
        // 对于非静态文件请求，返回 index.html（用于前端路由）
        const indexPath = path.resolve(__dirname, 'hexo-pro-core/www/index.html');
        
        // 检查 sendFile 方法是否可用
        if (typeof res.sendFile === 'function') {
          res.sendFile(indexPath);
        } else if (res._originalSendFile && typeof res._originalSendFile === 'function') {
          // 使用保存的原始方法
          res._originalSendFile.call(res, indexPath);
        } else {
          // 降级方案：直接读取文件并发送
          const fs = require('fs');
          
          fs.readFile(indexPath, (err, data) => {
            if (err) {
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('File not found');
            } else {
              const contentType = mime.getType(indexPath) || 'text/html';
              res.writeHead(200, { 'Content-Type': contentType });
              res.end(data);
            }
          });
        }
      } else {
        next();
      }
    });

    // 基本API路由
    this.app.get('/hexopro/api/desktop/status', (req, res) => {
      res.json({
        status: 'static-server',
        projectPath: null,
        port: this.hexoPort,
        uptime: process.uptime(),
        hasProject: false
      });
    });

    // 处理其他 API 请求（项目未加载时的响应）
    this.app.use('/hexopro/api', (req, res) => {
      res.status(503).json({
        error: '项目未加载',
        message: '请先选择一个 Hexo 项目',
        code: 'NO_PROJECT_LOADED'
      });
    });
  }

  async startBasicServer() {
    return new Promise((resolve, reject) => {
      console.log(`尝试在端口 ${this.hexoPort} 启动基本服务器...`);
      
      const tryStart = (port) => {
        this.server = this.app.listen(port, (err) => {
          if (err) {
            if (err.code === 'EADDRINUSE' && port - this.hexoPort < 10) {
              console.log(`端口 ${port} 被占用，尝试端口 ${port + 1}`);
              tryStart(port + 1);
            } else {
              reject(err);
            }
          } else {
            this.hexoPort = port;
            console.log(`基本服务器成功启动在端口 ${port}`);
            resolve();
          }
        });
      };

      tryStart(this.hexoPort);
    });
  }
}

module.exports = HexoProServer; 