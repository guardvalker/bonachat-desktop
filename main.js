const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, desktopCapturer } = require('electron');
const path = require('path');

const URL_BASE = 'https://cachyos-bona.tail92d31a.ts.net/';
let win, tray, quitting = false;

// Wayland: usar el portal de PipeWire para capturar pantalla/ventanas (sin esto la captura sale negra o falla).
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, backgroundColor: '#11111b', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(URL_BASE);
  // Links externos al navegador del sistema
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL_BASE)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
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
  // Cámara, micrófono, notificaciones y pantalla (llamadas)
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) =>
    cb(['media', 'notifications', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(perm)));
  // Compartir pantalla: en Wayland el portal del sistema ya muestra su propio selector (llega una sola fuente);
  // en X11 se arma un menú con las pantallas y ventanas disponibles.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      let done = false;
      const finish = (r) => { if (!done) { done = true; callback(r); } };
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 160, height: 90 } });
      if (sources.length === 0) return finish({});
      if (sources.length === 1) return finish({ video: sources[0] });
      const menu = Menu.buildFromTemplate([
        { label: 'Compartir…', enabled: false },
        ...sources.map((src) => ({
          label: src.name.slice(0, 60),
          icon: src.thumbnail.isEmpty() ? undefined : src.thumbnail.resize({ width: 48 }),
          click: () => finish({ video: src }),
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
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win.isVisible() ? win.hide() : (win.show(), win.focus()); });
});
app.on('before-quit', () => { quitting = true; });
