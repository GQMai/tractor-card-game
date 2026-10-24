const { app, BrowserWindow, Menu, screen } = require('electron');
const path = require('path');

// Windows 7 上部分老显卡驱动对 GPU 合成支持不佳，禁用硬件加速更稳
app.disableHardwareAcceleration();

function createWindow() {
  // 依屏幕可用区域收敛窗口尺寸，避免高 DPI 下超出屏幕
  const display = screen.getPrimaryDisplay();
  const area = display.workAreaSize;
  const width = Math.min(1280, Math.max(960, area.width - 40));
  const height = Math.min(840, Math.max(620, area.height - 40));

  const win = new BrowserWindow({
    width: width,
    height: height,
    minWidth: 960,
    minHeight: 620,
    center: true,
    backgroundColor: '#071a14',
    title: '拖拉机 · 现代重制版',
    icon: path.join(__dirname, 'assets', 'tractor.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.webContents.on('console-message', function (event, level, message, line, sourceId) {
    if (level >= 2) console.log('[renderer]', message, '(' + sourceId + ':' + line + ')');
  });
  win.webContents.on('render-process-gone', function (event, details) {
    console.error('渲染进程退出:', details);
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', function () {
  app.quit();
});
