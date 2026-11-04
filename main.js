const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Calidad de pantalla compartida (resolución máxima y fps). 'auto' = la que decida la app de llamadas.
const QUALITIES = {
  auto: { label: 'Automática', value: null },
  '720p30': { label: '720p · 30 fps', value: { width: 1280, height: 720, fps: 30 } },
  '1080p30': { label: '1080p · 30 fps', value: { width: 1920, height: 1080, fps: 30 } },
  '1080p60': { label: '1080p · 60 fps', value: { width: 1920, height: 1080, fps: 60 } },
  '1440p30': { label: '1440p · 30 fps', value: { width: 2560, height: 1440, fps: 30 } },
  '2160p30': { label: '4K · 30 fps', value: { width: 3840, height: 2160, fps: 30 } },
};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadQuality() {
  try { const q = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).quality; if (QUALITIES[q]) return q; } catch (_) {}
  return '1080p30';
}
let quality = null;
function setQuality(q) {
  quality = q;
  try { fs.writeFileSync(settingsFile(), JSON.stringify({ quality: q })); } catch (_) {}
}
function qualityMenuItems() {
  return Object.entries(QUALITIES).map(([id, q]) => ({
    label: q.label, type: 'radio', checked: quality === id, click: () => setQuality(id),
  }));
}
ipcMain.on('bona:share-quality', (e) => { e.returnValue = QUALITIES[quality || loadQuality()].value; });

const URL_BASE = 'https://cachyos-bona.tail92d31a.ts.net/';
const ORIGIN_BASE = new URL(URL_BASE).origin;
const isOwnUrl = (u) => { try { return new URL(u).origin === ORIGIN_BASE; } catch { return false; } };
let win, tray, quitting = false;

// Wayland: usar el portal de PipeWire para capturar pantalla/ventanas (sin esto la captura sale negra o falla).
// PulseaudioLoopbackForScreenShare: permite capturar el audio del sistema al compartir pantalla (Linux).
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,PulseaudioLoopbackForScreenShare');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
// Evita los errores de buffers GPU (gbm_pixmap_wayland) al renderizar video en Wayland.
app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, backgroundColor: '#11111b', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js'), nodeIntegrationInSubFrames: true },
  });
  win.loadURL(URL_BASE);
  // Links externos al navegador del sistema
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isOwnUrl(url)) { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  // La ventana nunca sale de nuestro origen: links/redirecciones externas van al navegador del sistema
  win.webContents.on('will-navigate', (e, url) => {
    if (isOwnUrl(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  // Si falla la carga (Tailscale caído), reintentar
  win.webContents.on('did-fail-load', (_e, code, desc, _u, isMain) => {
    if (!isMain || code === -3) return;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<body style="background:#11111b;color:#cdd6f4;font:16px sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
       <div><h2>No se pudo conectar a BonaChat</h2><p>${desc}</p><p>Revisá que Tailscale esté activo.</p><p>Reintentando…</p></div></body>`));
    setTimeout(() => win && win.loadURL(URL_BASE), 5000);
  });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

app.whenReady().then(() => {
  quality = loadQuality();
  // Cámara, micrófono, notificaciones y pantalla (llamadas)
  const PERMS = ['media', 'notifications', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'];
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) =>
    cb(PERMS.includes(perm) && isOwnUrl(wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) =>
    PERMS.includes(perm) && isOwnUrl(origin));
  // Compartir pantalla: en Wayland el portal del sistema ya muestra su propio selector (llega una sola fuente);
  // en X11 se arma un menú con las pantallas y ventanas disponibles.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!isOwnUrl(request.securityOrigin || '')) return callback({});
      let done = false;
      const finish = (r) => { if (!done) { done = true; callback(r); } };
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 160, height: 90 } });
      if (sources.length === 0) return finish({});
      if (sources.length === 1) return finish({ video: sources[0], audio: 'loopback' });
      const menu = Menu.buildFromTemplate([
        { label: 'Compartir…', enabled: false },
        { label: 'Calidad', submenu: qualityMenuItems() },
        { type: 'separator' },
        ...sources.map((src) => ({
          label: src.name.slice(0, 60),
          icon: src.thumbnail.isEmpty() ? undefined : src.thumbnail.resize({ width: 48 }),
          click: () => finish({ video: src, audio: 'loopback' }),
        })),
        { type: 'separator' },
        { label: 'Cancelar', click: () => finish({}) },
      ]);
      menu.once('menu-will-close', () => setTimeout(() => finish({}), 400)); // si cierra sin elegir
      menu.popup({ window: win });
    } catch (e) {
      callback({});
    }
  });
  createWindow();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build/tray.png')).resize({ width: 24, height: 24 }));
  tray.setToolTip('BonaChat');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir BonaChat', click: () => { win.show(); win.focus(); } },
    { label: 'Calidad de pantalla compartida', submenu: qualityMenuItems() },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win.isVisible() ? win.hide() : (win.show(), win.focus()); });
});
app.on('before-quit', () => { quitting = true; });
