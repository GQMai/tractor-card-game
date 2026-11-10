const { app, BrowserWindow, Menu, screen, session, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const { registerVoiceIpc } = require('./voice-host.js');

// Windows 7 上部分老显卡驱动对 GPU 合成支持不佳，禁用硬件加速更稳
app.disableHardwareAcceleration();

let voice = null;

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
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
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
  if (voice) voice.attach(win);
}

app.whenReady().then(function () {
  // 语音陪聊需要麦克风：只对 media / audioCapture 放行，其余保持默认拒绝
  const allowMedia = function (permission) {
    return permission === 'media' || permission === 'audioCapture';
  };
  session.defaultSession.setPermissionRequestHandler(function (wc, permission, callback) {
    callback(allowMedia(permission));
  });
  session.defaultSession.setPermissionCheckHandler(function (wc, permission) {
    return allowMedia(permission);
  });

  voice = registerVoiceIpc(ipcMain, {
    WebSocket: WebSocket,
    configPath: process.env.TRACTOR_VOICE_CONFIG
  });

  createWindow();
});

app.on('window-all-closed', function () {
  app.quit();
});

app.on('before-quit', function () {
  if (voice) voice.host.stop();
});
