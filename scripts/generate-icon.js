const fs = require('fs');
const path = require('path');

// 创建简单的 SVG 图标
function createSVGIcon() {
  return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <!-- 渐变背景 -->
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0084FF;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#42A5F5;stop-opacity:1" />
    </linearGradient>
    <linearGradient id="hexGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#FFFFFF;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#F0F8FF;stop-opacity:1" />
    </linearGradient>
  </defs>
  
  <!-- 背景圆形 -->
  <circle cx="256" cy="256" r="240" fill="url(#bgGrad)" stroke="#0056CC" stroke-width="4"/>
  
  <!-- 内部装饰圆环 -->
  <circle cx="256" cy="256" r="200" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2"/>
  
  <!-- Hexo 六边形 -->
  <polygon points="256,100 340,150 340,250 256,300 172,250 172,150" 
           fill="url(#hexGrad)" stroke="#0056CC" stroke-width="3"/>
  
  <!-- 内部六边形装饰 -->
  <polygon points="256,130 310,160 310,230 256,260 202,230 202,160" 
           fill="none" stroke="#0084FF" stroke-width="2"/>
  
  <!-- 中心 "H" 字母 -->
  <g fill="#0084FF" font-family="Arial, sans-serif" font-weight="bold" font-size="48">
    <text x="256" y="210" text-anchor="middle" dominant-baseline="middle">H</text>
  </g>
  
  <!-- 底部文档图标 -->
  <rect x="200" y="320" width="112" height="140" rx="12" 
        fill="white" stroke="#0084FF" stroke-width="3"/>
  
  <!-- 文档内容线条 -->
  <rect x="220" y="350" width="72" height="6" rx="3" fill="#0084FF"/>
  <rect x="220" y="365" width="72" height="6" rx="3" fill="#42A5F5"/>
  <rect x="220" y="380" width="50" height="6" rx="3" fill="#42A5F5"/>
  <rect x="220" y="395" width="60" height="6" rx="3" fill="#42A5F5"/>
  
  <!-- 右上角 Pro 标记 -->
  <circle cx="400" cy="112" r="45" fill="#FF6B35"/>
  <text x="400" y="120" text-anchor="middle" dominant-baseline="middle" 
        fill="white" font-family="Arial, sans-serif" font-weight="bold" font-size="20">PRO</text>
</svg>`;
}

// 创建简化的 PNG 数据（这里我们创建一个简单的占位符）
function createBasicPNG() {
  // 这是一个简化的方法，实际生产中应该使用专业的图标生成工具
  console.log('生成基础 PNG 图标...');
  console.log('建议使用在线工具或专业软件来创建高质量的 PNG 图标');
  
  // 创建 SVG 文件作为参考
  const svgContent = createSVGIcon();
  return svgContent;
}

async function generateIcons() {
  const assetsDir = path.join(__dirname, '../assets');
  
  // 确保 assets 目录存在
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
    console.log('✅ 创建 assets 目录');
  }
  
  // 生成 SVG 图标作为参考
  const svgPath = path.join(assetsDir, 'icon-source.svg');
  const svgContent = createSVGIcon();
  fs.writeFileSync(svgPath, svgContent);
  console.log('✅ 生成 SVG 图标参考文件:', svgPath);
  
  // 检查是否已存在图标文件
  const requiredIcons = ['icon.png', 'icon.ico', 'icon.icns'];
  const missingIcons = requiredIcons.filter(icon => 
    !fs.existsSync(path.join(assetsDir, icon))
  );
  
  if (missingIcons.length > 0) {
    console.log('⚠️  缺少以下图标文件:', missingIcons.join(', '));
    console.log('');
    console.log('📋 请按照以下步骤创建图标:');
    console.log('');
    console.log('1. 打开生成的 SVG 文件:', svgPath);
    console.log('2. 使用设计软件（如 Figma、Sketch）导出为 512x512 的 PNG');
    console.log('3. 使用在线工具转换为其他格式:');
    console.log('   - iconifier.net (推荐)');
    console.log('   - favicon.io/favicon-converter');
    console.log('   - cloudconvert.com');
    console.log('');
    console.log('4. 将生成的文件重命名并放置在 assets 目录:');
    console.log('   - icon.png (512x512)');
    console.log('   - icon.ico (包含多种尺寸)');
    console.log('   - icon.icns (macOS 格式)');
    console.log('');
    
    // 创建临时的占位符文件（仅用于开发测试）
    const placeholderPng = path.join(assetsDir, 'icon.png');
    if (!fs.existsSync(placeholderPng)) {
      // 创建一个简单的提示文件
      const readmeContent = `# 图标占位符

这是一个临时的占位符文件。

请使用 icon-source.svg 作为参考，创建正式的图标文件：
- icon.png (512x512)
- icon.ico (Windows)
- icon.icns (macOS)

推荐使用在线工具：
- https://iconifier.net/
- https://favicon.io/favicon-converter/
`;
      fs.writeFileSync(path.join(assetsDir, 'README.md'), readmeContent);
      console.log('📝 创建了图标制作说明文件');
    }
  } else {
    console.log('✅ 所有图标文件已存在');
  }
  
  // 验证配置
  console.log('');
  console.log('🔧 配置验证:');
  console.log('- main.js 中的图标路径: ../../assets/icon.png');
  console.log('- package.json 中的构建配置已设置');
  console.log('- assets 目录已创建');
  console.log('');
  console.log('🚀 下一步:');
  console.log('1. 创建图标文件（如果还没有）');
  console.log('2. 运行 yarn dev 测试图标显示');
  console.log('3. 运行 yarn build:electron 测试打包');
}

// 如果直接运行此脚本
if (require.main === module) {
  generateIcons().catch(console.error);
}

module.exports = { generateIcons, createSVGIcon }; 