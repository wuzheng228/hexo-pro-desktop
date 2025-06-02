const fs = require('fs');
const path = require('path');

// 创建一个简单的32x32蓝色PNG图标
function createSimplePNG() {
  // 创建一个32x32的蓝色正方形PNG
  const width = 32;
  const height = 32;
  
  // PNG文件头
  const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  
  // IHDR chunk (图像头)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);    // width
  ihdrData.writeUInt32BE(height, 4);   // height
  ihdrData.writeUInt8(8, 8);           // bit depth
  ihdrData.writeUInt8(2, 9);           // color type (RGB)
  ihdrData.writeUInt8(0, 10);          // compression
  ihdrData.writeUInt8(0, 11);          // filter
  ihdrData.writeUInt8(0, 12);          // interlace
  
  const ihdrChunk = createChunk('IHDR', ihdrData);
  
  // 创建简单的蓝色像素数据
  const bytesPerPixel = 3; // RGB
  const rowSize = width * bytesPerPixel + 1; // +1 for filter byte
  const pixelData = Buffer.alloc(height * rowSize);
  
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    pixelData[rowStart] = 0; // filter method (None)
    
    for (let x = 0; x < width; x++) {
      const pixelStart = rowStart + 1 + x * bytesPerPixel;
      
      // 创建一个简单的图标设计
      const isCenter = (x >= 8 && x < 24 && y >= 8 && y < 24);
      const isBorder = (x === 0 || x === 31 || y === 0 || y === 31);
      
      if (isCenter) {
        // 中心区域 - 亮蓝色
        pixelData[pixelStart] = 100;     // R
        pixelData[pixelStart + 1] = 150; // G  
        pixelData[pixelStart + 2] = 255; // B
      } else if (isBorder) {
        // 边框 - 深蓝色
        pixelData[pixelStart] = 0;       // R
        pixelData[pixelStart + 1] = 80;  // G
        pixelData[pixelStart + 2] = 180; // B
      } else {
        // 背景 - 中等蓝色
        pixelData[pixelStart] = 50;      // R
        pixelData[pixelStart + 1] = 120; // G
        pixelData[pixelStart + 2] = 220; // B
      }
    }
  }
  
  // 压缩像素数据 (这里我们使用未压缩的数据块)
  const zlib = require('zlib');
  const compressedData = zlib.deflateSync(pixelData);
  const idatChunk = createChunk('IDAT', compressedData);
  
  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));
  
  // 组合PNG文件
  return Buffer.concat([pngSignature, ihdrChunk, idatChunk, iendChunk]);
}

// 创建PNG chunk
function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = calculateCRC(Buffer.concat([typeBuffer, data]));
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);
  
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

// CRC计算
function calculateCRC(data) {
  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
  }
  
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 创建基础的ICO文件
function createSimpleICO() {
  // ICO文件头 (6字节)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // Reserved
  header.writeUInt16LE(1, 2);      // Type (1 = ICO)
  header.writeUInt16LE(1, 4);      // Number of images
  
  // 图像目录条目 (16字节)
  const dirEntry = Buffer.alloc(16);
  dirEntry.writeUInt8(32, 0);      // Width (32)
  dirEntry.writeUInt8(32, 1);      // Height (32)
  dirEntry.writeUInt8(0, 2);       // Color count (0 = more than 256)
  dirEntry.writeUInt8(0, 3);       // Reserved
  dirEntry.writeUInt16LE(1, 4);    // Planes
  dirEntry.writeUInt16LE(32, 6);   // Bits per pixel
  
  const pngData = createSimplePNG();
  dirEntry.writeUInt32LE(pngData.length, 8);  // Image size
  dirEntry.writeUInt32LE(22, 12);             // Offset to image data
  
  return Buffer.concat([header, dirEntry, pngData]);
}

// 创建基础的ICNS文件 (简化版)
function createSimpleICNS() {
  // ICNS文件头
  const header = Buffer.from('icns', 'ascii');
  const pngData = createSimplePNG();
  
  // ic05 代表32x32的PNG数据
  const iconHeader = Buffer.from('ic05', 'ascii');
  const iconSize = Buffer.alloc(4);
  iconSize.writeUInt32BE(pngData.length + 8, 0);
  
  const totalSize = Buffer.alloc(4);
  totalSize.writeUInt32BE(pngData.length + 16, 0);
  
  return Buffer.concat([header, totalSize, iconHeader, iconSize, pngData]);
}

async function createWorkingIcons() {
  const assetsDir = path.join(__dirname, '../assets');
  
  console.log('🔧 创建可用的图标文件...');
  
  try {
    // 创建PNG图标
    const pngPath = path.join(assetsDir, 'icon.png');
    const pngData = createSimplePNG();
    fs.writeFileSync(pngPath, pngData);
    console.log('✅ 创建了32x32 PNG图标');
    
    // 创建ICO图标
    const icoPath = path.join(assetsDir, 'icon.ico');
    const icoData = createSimpleICO();
    fs.writeFileSync(icoPath, icoData);
    console.log('✅ 创建了ICO图标');
    
    // 创建ICNS图标
    const icnsPath = path.join(assetsDir, 'icon.icns');
    const icnsData = createSimpleICNS();
    fs.writeFileSync(icnsPath, icnsData);
    console.log('✅ 创建了ICNS图标');
    
    console.log('');
    console.log('🎯 所有图标文件已创建完成！');
    console.log('');
    console.log('📋 文件列表:');
    console.log(`- ${pngPath} (${pngData.length} bytes)`);
    console.log(`- ${icoPath} (${icoData.length} bytes)`);
    console.log(`- ${icnsPath} (${icnsData.length} bytes)`);
    console.log('');
    console.log('🚀 现在运行 yarn dev 应该能看到图标了！');
    
  } catch (error) {
    console.error('❌ 创建图标失败:', error);
    throw error;
  }
}

if (require.main === module) {
  createWorkingIcons().catch(console.error);
}

module.exports = { createWorkingIcons }; 