const fs = require('fs');
const path = require('path');

// 创建简单的PNG数据（这是一个基础的PNG文件头，用于测试）
function createPlaceholderIcon() {
  // PNG 文件签名 + 基础头部信息
  // 这是一个非常简单的 32x32 蓝色图标的二进制数据
  const pngData = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG 签名
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x20, // 32x32 尺寸
    0x08, 0x02, 0x00, 0x00, 0x00, 0xFC, 0x18, 0xED, // 颜色类型等
    0xA3, 0x00, 0x00, 0x00, 0x09, 0x70, 0x48, 0x59, // 其他必要数据
    0x73, 0x00, 0x00, 0x0B, 0x13, 0x00, 0x00, 0x0B,
    0x13, 0x01, 0x00, 0x9A, 0x9C, 0x18, 0x00, 0x00,
    0x00, 0x1F, 0x49, 0x44, 0x41, 0x54, 0x48, 0x4B,
    0x63, 0x64, 0x00, 0x02, 0x96, 0x00, 0x51, 0x06,
    0x83, 0x41, 0x4C, 0x0C, 0x06, 0x41, 0x4C, 0x0C,
    0x06, 0x83, 0x58, 0x18, 0x0C, 0x62, 0x62, 0x30,
    0x88, 0x89, 0xC1, 0x20, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82  // IEND chunk
  ]);
  
  return pngData;
}

async function createTestIcons() {
  const assetsDir = path.join(__dirname, '../assets');
  
  // 确保assets目录存在
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
    console.log('✅ 创建 assets 目录');
  }
  
  // 创建基础 PNG 图标用于测试
  const iconPng = path.join(assetsDir, 'icon.png');
  if (!fs.existsSync(iconPng)) {
    try {
      const pngData = createPlaceholderIcon();
      fs.writeFileSync(iconPng, pngData);
      console.log('✅ 创建测试用 PNG 图标');
    } catch (error) {
      console.error('创建PNG图标失败:', error);
      // 创建空文件作为占位符
      fs.writeFileSync(iconPng, '');
      console.log('📝 创建了PNG占位符文件');
    }
  }
  
  // 创建基础 ICO 文件（Windows）
  const iconIco = path.join(assetsDir, 'icon.ico');
  if (!fs.existsSync(iconIco)) {
    // ICO 文件格式比较复杂，这里创建一个简单的占位符
    try {
      const icoData = createPlaceholderIcon(); // 使用相同数据作为临时解决方案
      fs.writeFileSync(iconIco, icoData);
      console.log('✅ 创建测试用 ICO 图标');
    } catch (error) {
      fs.writeFileSync(iconIco, '');
      console.log('📝 创建了ICO占位符文件');
    }
  }
  
  // 创建基础 ICNS 文件（macOS）
  const iconIcns = path.join(assetsDir, 'icon.icns');
  if (!fs.existsSync(iconIcns)) {
    try {
      const icnsData = createPlaceholderIcon(); // 使用相同数据作为临时解决方案
      fs.writeFileSync(iconIcns, icnsData);
      console.log('✅ 创建测试用 ICNS 图标');
    } catch (error) {
      fs.writeFileSync(iconIcns, '');
      console.log('📝 创建了ICNS占位符文件');
    }
  }
  
  console.log('');
  console.log('🎯 测试图标已创建！');
  console.log('');
  console.log('⚠️  注意：这些是用于测试的基础图标。');
  console.log('为了获得最佳效果，请使用以下步骤创建专业图标：');
  console.log('');
  console.log('1. 使用 assets/icon-source.svg 作为模板');
  console.log('2. 访问 https://convertico.com/svg-to-ico/ 或 https://cloudconvert.com/svg-to-ico');
  console.log('3. 上传 SVG 文件并下载高质量的 PNG, ICO, ICNS 文件');
  console.log('4. 替换 assets/ 目录中的文件');
  console.log('');
  console.log('🚀 现在你可以运行 yarn dev 测试应用了！');
}

if (require.main === module) {
  createTestIcons().catch(console.error);
}

module.exports = { createTestIcons }; 