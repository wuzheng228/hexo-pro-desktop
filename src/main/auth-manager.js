const { app, safeStorage } = require('electron');
const axios = require('axios');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const LEGACY_KEYS = ['tokens', 'credentials', 'tokensUpdatedAt'];

class AuthManager {
  constructor(store = null, options = {}) {
    this.userDataPath = options.userDataPath || app.getPath('userData');
    this.safeStorage = options.safeStorage || safeStorage;
    this.store = store;
    this.tokens = new Map();
    this.credentials = {};
  }

  setStore(store) {
    this.store = store;
  }

  async initializeStore() {
    if (!this.store) {
      const { default: Store } = await import('electron-store');
      this.store = new Store();
    }
  }

  requireSecureStorage() {
    // Electron's Linux basic_text backend does not protect secrets.
    if (!this.safeStorage?.isEncryptionAvailable() ||
        this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('系统安全存储不可用，无法记住登录信息，请解锁系统钥匙串后重试');
    }
    if (!this.store) throw new Error('登录信息存储尚未就绪');
  }

  removeLegacyData() {
    if (this.store) {
      for (const key of LEGACY_KEYS) this.store.delete(key);
    }
  }

  persist(tokens = this.tokens, credentials = this.credentials) {
    this.requireSecureStorage();
    const encrypted = this.safeStorage.encryptString(JSON.stringify({
      tokens: Object.fromEntries(tokens), credentials
    }));
    this.store.set('secureAuth', { version: 1, ciphertext: encrypted.toString('base64') });
    this.removeLegacyData();
  }

  async loadAuthData() {
    this.tokens = new Map();
    this.credentials = {};
    if (!this.store) return false;
    try {
      const encrypted = this.store.get('secureAuth');
      const legacyTokens = this.store.get('tokens', {});
      const legacyCredentials = this.store.get('credentials', {});
      let data;
      if (encrypted) {
        this.requireSecureStorage();
        if (encrypted.version !== 1 || typeof encrypted.ciphertext !== 'string') {
          throw new Error('Unsupported credential format');
        }
        data = JSON.parse(this.safeStorage.decryptString(Buffer.from(encrypted.ciphertext, 'base64')));
      } else {
        data = { tokens: legacyTokens, credentials: {} };
        for (const [projectPath, entry] of Object.entries(legacyCredentials || {})) {
          if (!entry || typeof entry.username !== 'string') continue;
          data.credentials[projectPath] = {
            username: entry.username,
            password: entry.rememberPassword && typeof entry.password === 'string'
              ? this.decodeLegacyPassword(entry.password) : null,
            rememberPassword: entry.rememberPassword === true,
            updatedAt: entry.updatedAt
          };
        }
      }
      const tokens = new Map(Object.entries(data.tokens || {})
        .filter(([, token]) => typeof token === 'string' && TOKEN_PATTERN.test(token)));
      const credentials = data.credentials && typeof data.credentials === 'object' ? data.credentials : {};
      // Migrate before exposing any old secret. Failure never writes plaintext.
      if (!encrypted && (tokens.size || Object.keys(credentials).length)) this.persist(tokens, credentials);
      this.tokens = tokens;
      this.credentials = credentials;
      return true;
    } catch (_) {
      // Do not log caught errors: decryption/parsing errors can contain secrets.
      console.warn('[Auth Manager]: 无法读取安全保存的登录信息，请解锁系统钥匙串或重新登录');
      return false;
    } finally {
      // Old versions stored tokens in plaintext and passwords with reversible XOR.
      // Even if the keyring is unavailable, those insecure copies must not survive.
      this.removeLegacyData();
    }
  }

  async saveAuthData() {
    this.persist();
  }

  getToken(projectPath) {
    return this.tokens.get(projectPath) || null;
  }

  async setToken(projectPath, token) {
    if (typeof projectPath !== 'string' || !projectPath || typeof token !== 'string' ||
        token.length > 16384 || !TOKEN_PATTERN.test(token)) {
      throw new Error('登录令牌格式无效');
    }
    const next = new Map(this.tokens);
    next.set(projectPath, token);
    this.persist(next);
    this.tokens = next;
  }

  async removeToken(projectPath) {
    const next = new Map(this.tokens);
    next.delete(projectPath);
    if (next.size === 0 && Object.keys(this.credentials).length === 0) {
      this.store?.delete('secureAuth');
      this.removeLegacyData();
    } else {
      try {
        this.persist(next);
      } catch (_) {
        // A locked keyring must not make a logged-out token reappear on restart.
        // Without encryption we cannot rewrite the shared envelope safely, so
        // discard saved sessions instead of retaining the revoked entry.
        await this.clearAll();
        return;
      }
    }
    this.tokens = next;
  }

  async clearToken(projectPath) {
    await this.removeToken(projectPath);
  }

  async validateToken(serverUrl, token) {
    try {
      const response = await axios.get(`${serverUrl}/hexopro/api/auth/validate`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10000
      });
      return response.status === 200 && response.data?.valid === true;
    } catch (_) {
      return false;
    }
  }

  async attemptAutoLogin(serverUrl, projectPath, username, password) {
    try {
      const response = await axios.post(`${serverUrl}/hexopro/api/login`, { username, password }, { timeout: 10000 });
      if (response.data?.token) {
        await this.setToken(projectPath, response.data.token);
        return response.data.token;
      }
    } catch (_) {
      console.warn('[Auth Manager]: 自动登录失败，请重新登录');
    }
    return null;
  }

  async getStoredCredentials(projectPath) {
    const entry = this.credentials[projectPath];
    return entry ? { ...entry } : null;
  }

  async saveCredentials(projectPath, username, password, rememberPassword = false) {
    if (typeof projectPath !== 'string' || !projectPath || typeof username !== 'string' ||
        (rememberPassword && typeof password !== 'string')) throw new Error('登录信息格式无效');
    const next = {
      ...this.credentials,
      [projectPath]: {
        username, password: rememberPassword ? password : null,
        rememberPassword: rememberPassword === true, updatedAt: new Date().toISOString()
      }
    };
    this.persist(this.tokens, next);
    this.credentials = next;
  }

  // Read-only compatibility for migrating old installations. Never used to save.
  decodeLegacyPassword(encrypted) {
    const key = Buffer.from(this.userDataPath).toString('base64');
    const text = Buffer.from(encrypted, 'base64').toString();
    let result = '';
    for (let index = 0; index < text.length; index++) {
      result += String.fromCharCode(text.charCodeAt(index) ^ key.charCodeAt(index % key.length));
    }
    return result;
  }

  async clearAll() {
    this.store?.delete('secureAuth');
    this.removeLegacyData();
    this.tokens.clear();
    this.credentials = {};
  }
}

module.exports = AuthManager;
