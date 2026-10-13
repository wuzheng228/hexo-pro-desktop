const { app, dialog } = require('electron');
const HexoProDesktop = require('./main');

// Electron's development launcher imports this entry, so require.main is not
// the application module. Keep startup explicit and main.js safe to import.
async function start() {
  const desktop = new HexoProDesktop();
  await desktop.initialize();
}

start().catch(error => {
  console.error('[Desktop]: 应用启动失败:', error);
  dialog.showErrorBox('Hexo Pro Desktop 启动失败', error.message || String(error));
  app.exit(1);
});
