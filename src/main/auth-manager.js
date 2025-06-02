const { app } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

class AuthManager {
  constructor(store = null) {
    this.userDataPath = app.getPath('userData');
    this.authFilePath = path.join(this.userDataPath, 'auth.json');
    this.tokens = new Map(); // projectPath -> token
    this.store = store; // 接收外部传入的store实例
  }

  /**
   * 设置store实例（由主进程调用）
   */
  setStore(store) {
    this.store = store;
  }

  /**
   * 初始化electron-store（应该在主进程中调用）
   */
  async initializeStore() {
    // 如果已经有store实例，就不需要再初始化了
    if (this.store) {
      console.log('[Auth Manager]: 使用传入的store实例');
      return;
    }

    try {
      const electronStore = await import('electron-store');
      const Store = electronStore.default;
      this.store = new Store();
      console.log('[Auth Manager]: electron-store 初始化成功');
    } catch (error) {
      console.error('[Auth Manager]: 初始化 electron-store 失败:', error);
      // 提供一个简单的内存存储作为后备
      this.store = {
        get: () => null,
        set: () => {},
        delete: () => {},
        clear: () => {}
      };
    }
  }

  /**
   * 加载存储的认证信息
   */
  async loadAuthData() {
    try {
      console.log('[Auth Manager]: 尝试从electron-store加载认证数据');
      console.log('[Auth Manager]: 用户数据路径:', this.userDataPath);
      console.log('[Auth Manager]: store实例存在:', !!this.store);
      
      if (this.store && this.store.path) {
        console.log('[Auth Manager]: store路径:', this.store.path);
      }
      
      if (this.store) {
        const tokensData = this.store.get('tokens', {});
        console.log('[Auth Manager]: 从store获取的数据:', JSON.stringify(tokensData, null, 2));
        
        this.tokens = new Map(Object.entries(tokensData));
        console.log('[Auth Manager]: 已加载认证数据，token数量:', this.tokens.size);
        
        // 显示加载的所有token（隐藏实际内容）
        for (const [path, token] of this.tokens) {
          console.log('[Auth Manager]: 加载token - 路径:', path, '长度:', token ? token.length : '0');
        }
      } else {
        console.log('[Auth Manager]: store未初始化，使用空的token存储');
        this.tokens = new Map();
      }
    } catch (error) {
      console.error('[Auth Manager]: 加载认证数据失败:', error);
      this.tokens = new Map(); // 确保初始化
    }
  }

  /**
   * 保存认证信息
   */
  async saveAuthData() {
    try {
      console.log('[Auth Manager]: 准备保存认证数据');
      console.log('[Auth Manager]: store实例存在:', !!this.store);
      
      if (!this.store) {
        console.error('[Auth Manager]: store未初始化，无法保存数据');
        return;
      }

      const tokensData = Object.fromEntries(this.tokens);
      console.log('[Auth Manager]: 准备保存的数据:', JSON.stringify(tokensData, null, 2));
      
      if (this.store.path) {
        console.log('[Auth Manager]: 保存到路径:', this.store.path);
      }
      
      this.store.set('tokens', tokensData);
      this.store.set('tokensUpdatedAt', new Date().toISOString());
      
      console.log('[Auth Manager]: 认证数据已保存到electron-store');
      
      // 验证保存是否成功
      const savedData = this.store.get('tokens', {});
      console.log('[Auth Manager]: 验证保存结果:', JSON.stringify(savedData, null, 2));
      
    } catch (error) {
      console.error('[Auth Manager]: 保存认证数据失败:', error);
    }
  }

  /**
   * 获取项目的token
   */
  getToken(projectPath) {
    console.log('[Auth Manager]: 尝试获取token，项目路径:', projectPath);
    console.log('[Auth Manager]: 当前存储的token数量:', this.tokens.size);
    const token = this.tokens.get(projectPath);
    
    if (token) {
      // 验证token格式 - JWT应该是3个用.分隔的base64字符串
      const jwtPattern = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
      if (!jwtPattern.test(token)) {
        console.error('[Auth Manager]: 发现格式无效的token，自动清理:', token.substring(0, 50) + '...');
        this.tokens.delete(projectPath);
        this.saveAuthData(); // 异步保存，不等待
        console.log('[Auth Manager]: 无效token已清理');
        return null;
      }
      
      console.log('[Auth Manager]: 获取结果: 找到有效token(长度:' + token.length + ')');
      return token;
    } else {
      console.log('[Auth Manager]: 获取结果: 未找到token');
      return null;
    }
  }

  /**
   * 设置项目的token
   */
  async setToken(projectPath, token) {
    console.log('[Auth Manager]: 保存token，项目路径:', projectPath);
    console.log('[Auth Manager]: Token长度:', token ? token.length : '无token');
    
    if (token) {
      // 验证token格式 - JWT应该是3个用.分隔的base64字符串
      const jwtPattern = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
      if (!jwtPattern.test(token)) {
        console.error('[Auth Manager]: 拒绝保存格式无效的token:', token.substring(0, 50) + '...');
        console.error('[Auth Manager]: Token必须是标准JWT格式（3个用.分隔的base64字符串）');
        return;
      }
    }
    
    this.tokens.set(projectPath, token);
    await this.saveAuthData();
    console.log('[Auth Manager]: Token保存完成');
  }

  /**
   * 移除项目的token
   */
  async removeToken(projectPath) {
    this.tokens.delete(projectPath);
    await this.saveAuthData();
  }

  /**
   * 清除项目的token（removeToken的别名）
   */
  async clearToken(projectPath) {
    console.log('[Auth Manager]: 清除token，项目路径:', projectPath);
    await this.removeToken(projectPath);
    console.log('[Auth Manager]: Token已清除');
  }

  /**
   * 验证token是否有效
   */
  async validateToken(serverUrl, token) {
    try {
      console.log('[Auth Manager]: 验证token有效性...');
      
      const response = await axios.get(`${serverUrl}/hexopro/api/auth/validate`, {
        headers: {
          'Authorization': `Bearer ${token}`
        },
        timeout: 10000
      });
      
      if (response.status === 200 && response.data && response.data.valid) {
        console.log('[Auth Manager]: Token验证成功');
        return true;
      } else {
        console.log('[Auth Manager]: Token验证失败 - 响应数据:', response.data);
        return false;
      }
    } catch (error) {
      if (error.response) {
        console.log('[Auth Manager]: Token验证失败 - 响应错误:', error.response.status, error.response.data);
        
        // 如果是401错误，说明token无效
        if (error.response.status === 401) {
          return false;
        }
        
        // 如果是其他错误，可能是服务器问题，暂时认为token有效
        console.log('[Auth Manager]: 服务器错误，暂时认为token有效');
        return true;
      } else {
        console.log('[Auth Manager]: Token验证失败 - 网络错误:', error.message);
        // 网络错误时，暂时认为token有效，避免重复登录
        return true;
      }
    }
  }

  /**
   * 尝试自动登录
   */
  async attemptAutoLogin(serverUrl, projectPath, username, password) {
    try {
      console.log('[Auth Manager]: 尝试自动登录...');
      
      const response = await axios.post(`${serverUrl}/hexopro/api/login`, {
        username,
        password
      }, {
        timeout: 10000
      });

      if (response.data && response.data.token) {
        console.log('[Auth Manager]: 自动登录成功');
        await this.setToken(projectPath, response.data.token);
        return response.data.token;
      } else {
        console.error('[Auth Manager]: 登录响应中没有token');
        return null;
      }
    } catch (error) {
      console.error('[Auth Manager]: 自动登录失败:', error.response?.data || error.message);
      return null;
    }
  }

  /**
   * 获取用户设置的登录信息
   */
  async getStoredCredentials(projectPath) {
    try {
      if (this.store) {
        const credentialsData = this.store.get('credentials', {});
        const credentials = credentialsData[projectPath];
        return credentials || null;
      }
    } catch (error) {
      console.error('[Auth Manager]: 获取存储的登录信息失败:', error);
    }
    return null;
  }

  /**
   * 保存用户的登录信息（加密存储）
   */
  async saveCredentials(projectPath, username, password, rememberPassword = false) {
    try {
      if (!this.store) {
        console.error('[Auth Manager]: store未初始化，无法保存登录信息');
        return;
      }

      const credentialsData = this.store.get('credentials', {});
      
      credentialsData[projectPath] = {
        username,
        password: rememberPassword ? this.simpleEncrypt(password) : null,
        rememberPassword,
        updatedAt: new Date().toISOString()
      };
      
      this.store.set('credentials', credentialsData);
      console.log('[Auth Manager]: 登录信息已保存');
    } catch (error) {
      console.error('[Auth Manager]: 保存登录信息失败:', error);
    }
  }

  /**
   * 简单的密码加密（基于用户数据路径的简单异或）
   */
  simpleEncrypt(text) {
    const key = Buffer.from(this.userDataPath).toString('base64');
    let result = '';
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return Buffer.from(result).toString('base64');
  }

  /**
   * 简单的密码解密
   */
  simpleDecrypt(encrypted) {
    try {
      const key = Buffer.from(this.userDataPath).toString('base64');
      const text = Buffer.from(encrypted, 'base64').toString();
      let result = '';
      for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
      }
      return result;
    } catch (error) {
      console.error('[Auth Manager]: 密码解密失败:', error);
      return null;
    }
  }

  /**
   * 清理所有认证数据
   */
  async clearAll() {
    this.tokens.clear();
    try {
      if (this.store) {
        this.store.delete('tokens');
        this.store.delete('credentials');
        this.store.delete('tokensUpdatedAt');
        console.log('[Auth Manager]: 已清理所有认证数据');
      } else {
        console.log('[Auth Manager]: store未初始化，无法清理数据');
      }
    } catch (error) {
      console.error('[Auth Manager]: 清理认证数据失败:', error);
    }
  }
}

module.exports = AuthManager; 