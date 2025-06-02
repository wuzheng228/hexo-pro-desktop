#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logHeader(message) {
  log('\n' + '='.repeat(50), 'cyan');
  log(message.toUpperCase(), 'cyan');
  log('='.repeat(50), 'cyan');
}

function logStep(step, message) {
  log(`\n[${step}] ${message}`, 'blue');
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

async function checkEnvironment() {
  logStep('1', '检查环境要求');
  
  // 检查 Node.js 版本
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  
  if (majorVersion >= 16) {
    logSuccess(`Node.js 版本: ${nodeVersion}`);
  } else {
    logError(`Node.js 版本过低: ${nodeVersion}，需要 16.0 或更高版本`);
    process.exit(1);
  }

  // 检查 Yarn 是否安装
  try {
    const yarnCheck = spawn('yarn', ['--version'], { stdio: 'pipe', shell: true });
    await new Promise((resolve, reject) => {
      let yarnVersion = '';
      yarnCheck.stdout.on('data', (data) => {
        yarnVersion += data.toString();
      });
      yarnCheck.on('close', (code) => {
        if (code === 0) {
          logSuccess(`Yarn 版本: ${yarnVersion.trim()}`);
          resolve();
        } else {
          reject(new Error('Yarn 未安装'));
        }
      });
      yarnCheck.on('error', reject);
    });
  } catch (error) {
    logError('Yarn 未安装，请先安装 Yarn: npm install -g yarn');
    process.exit(1);
  }

  // 检查项目结构
  const requiredDirs = [
    '../hexo-pro',
    '../hexo-pro-client'
  ];

  for (const dir of requiredDirs) {
    const dirPath = path.resolve(__dirname, dir);
    if (await fs.pathExists(dirPath)) {
      logSuccess(`找到项目: ${dir}`);
    } else {
      logWarning(`未找到项目: ${dir}`);
      log(`  请确保项目结构正确: workspace/hexo-pro, workspace/hexo-pro-client, workspace/hexo-pro-desktop`);
    }
  }
}

async function checkDependencies() {
  logStep('2', '检查项目依赖');
  
  const packageJsonPath = path.join(__dirname, 'package.json');
  const nodeModulesPath = path.join(__dirname, 'node_modules');
  
  if (await fs.pathExists(nodeModulesPath)) {
    logSuccess('依赖已安装');
  } else {
    logWarning('依赖未安装，正在安装...');
    await runCommand('yarn', ['install']);
    logSuccess('依赖安装完成');
  }
}

async function checkCoreFiles() {
  logStep('3', '检查核心文件');
  
  const coreDir = path.join(__dirname, 'src/main/hexo-pro-core');
  
  if (await fs.pathExists(coreDir)) {
    logSuccess('核心文件已复制');
  } else {
    logWarning('核心文件未找到，正在复制...');
    await runCommand('yarn', ['copy-core']);
    logSuccess('核心文件复制完成');
  }
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      ...options
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`命令执行失败: ${command} ${args.join(' ')}`));
      }
    });

    process.on('error', reject);
  });
}

async function startApplication() {
  logStep('4', '启动应用');
  
  const args = process.argv.slice(2);
  const mode = args[0] || 'dev';

  switch (mode) {
    case 'dev':
    case 'development':
      log('启动开发环境...', 'green');
      await runCommand('yarn', ['dev']);
      break;
    
    case 'build':
      log('构建生产版本...', 'green');
      await runCommand('yarn', ['build']);
      break;
    
    case 'dist':
      log('创建分发包...', 'green');
      await runCommand('yarn', ['dist']);
      break;
    
    case 'start':
      log('启动生产版本...', 'green');
      await runCommand('yarn', ['start']);
      break;
    
    default:
      logError(`未知模式: ${mode}`);
      log('可用模式: dev, build, dist, start');
      process.exit(1);
  }
}

async function showHelp() {
  logHeader('Hexo Pro Desktop 启动器');
  
  log('\n使用方法:');
  log('  node start.js [mode]', 'cyan');
  
  log('\n可用模式:');
  log('  dev          启动开发环境 (默认)', 'yellow');
  log('  build        构建生产版本', 'yellow');
  log('  dist         创建分发包', 'yellow');
  log('  start        启动生产版本', 'yellow');
  log('  help         显示帮助信息', 'yellow');
  
  log('\n环境要求:');
  log('  - Node.js 16.0+');
  log('  - Yarn 1.x+');
  log('  - 项目结构: hexo-pro/, hexo-pro-client/, hexo-pro-desktop/');
  
  log('\n示例:');
  log('  node start.js dev      # 开发环境');
  log('  node start.js build    # 构建应用');
  log('  node start.js dist     # 创建安装包');
}

async function main() {
  try {
    const args = process.argv.slice(2);
    
    if (args.includes('help') || args.includes('-h') || args.includes('--help')) {
      await showHelp();
      return;
    }

    logHeader('Hexo Pro Desktop 初始化');
    
    await checkEnvironment();
    await checkDependencies();
    await checkCoreFiles();
    await startApplication();
    
    logSuccess('\n🎉 操作完成！');
    
  } catch (error) {
    logError(`\n操作失败: ${error.message}`);
    log('\n请检查错误信息并重试，或运行 "node start.js help" 查看帮助。');
    process.exit(1);
  }
}

// 处理 Ctrl+C
process.on('SIGINT', () => {
  log('\n\n操作已取消。', 'yellow');
  process.exit(0);
});

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  logError(`未捕获的异常: ${error.message}`);
  process.exit(1);
});

if (require.main === module) {
  main();
} 