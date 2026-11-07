const { app, screen, dialog, BrowserWindow, Tray, Menu, shell, session, nativeImage, desktopCapturer, ipcMain } = require('electron');
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
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch (_) { return {}; }
}
function writeSettings(patch) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch })); } catch (_) {}
}
function setQuality(q) {
  quality = q;
  writeSettings({ quality: q });
}
// Tamaño/posición de la ventana: se guarda al cerrar y se restaura al abrir (si sigue cabiendo en alguna pantalla).
function loadWindowState() {
  const b = readSettings().window;
  if (b && b.maximized && !(b.width > 200)) return { maximized: true };
  if (!b || !(b.width > 200) || !(b.height > 200)) return null;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y < a.y + a.height - 50 && b.y + b.height > a.y;
  });
  return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
}
function qualityMenuItems() {
  return Object.entries(QUALITIES).map(([id, q]) => ({
    label: q.label, type: 'radio', checked: quality === id, click: () => setQuality(id),
  }));
}
// ---- Carpeta compartida: la app web (BonaChat) la expone a los demás a través del servidor ----
function shareRoot() { return readSettings().shareFolder || null; }
function splitPath(rel) { return String(rel || '').split('/').filter(Boolean); }
function inShare(rel) {
  const root = shareRoot();
  if (!root) throw new Error('No hay carpeta compartida');
  const parts = splitPath(rel);
  if (parts.some((p) => p === '..' || p === '.' || p.includes('\\'))) throw new Error('ruta inválida');
  const abs = path.resolve(root, ...parts);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('ruta inválida');
  // los enlaces simbólicos no pueden sacar de la carpeta
  try {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('ruta inválida');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return abs;
}
const uploads = new Map();
// Un nombre de archivo nunca es una ruta: sin separadores, sin puntos al inicio (no se crean ocultos ni se sale de la carpeta).
function safeName(n) {
  const s = path.basename(String(n || '')).replace(/[\\/\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim();
  if (!s) throw new Error('nombre inválido');
  return s.slice(0, 200);
}
// Las rutas pedidas por otros no pueden apuntar a archivos ocultos (.git, .env, .ssh…).
function visiblePath(rel) {
  if (splitPath(rel).some((p) => p.startsWith('.'))) throw new Error('ruta inválida');
  return inShare(rel);
}
async function abortAllUploads() {
  for (const [id, u] of [...uploads]) { uploads.delete(id); await u.fh.close().catch(() => {}); await fs.promises.rm(u.file, { force: true }).catch(() => {}); }
}
ipcMain.handle('bonafs:current', () => { const r = shareRoot(); return r ? path.basename(r) : null; });
ipcMain.handle('bonafs:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Elegí la carpeta a compartir' });
  if (r.canceled || !r.filePaths[0]) return null;
  writeSettings({ shareFolder: r.filePaths[0] });
  return path.basename(r.filePaths[0]);
});
ipcMain.handle('bonafs:clear', () => { writeSettings({ shareFolder: null }); });
ipcMain.handle('bonafs:list', async (_e, rel) => {
  const dir = visiblePath(rel);
  const out = [];
  for (const d of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const st = await fs.promises.stat(path.join(dir, d.name)).catch(() => null);
    if (st) out.push({ name: d.name, dir: d.isDirectory(), size: st.size, mtime: st.mtimeMs });
  }
  return out;
});
ipcMain.handle('bonafs:stat', async (_e, rel) => { const st = await fs.promises.stat(visiblePath(rel)); return { dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; });
ipcMain.handle('bonafs:read', async (_e, rel, offset, length) => {
  const fh = await fs.promises.open(visiblePath(rel), 'r');
  try { const buf = Buffer.alloc(length); const { bytesRead } = await fh.read(buf, 0, length, offset); return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead); }
  finally { await fh.close(); }
});
ipcMain.handle('bonafs:write', async (_e, rel, name, uploadId, offset, data, last) => {
  let u = uploads.get(uploadId);
  if (!u) {
    const dir = visiblePath(rel);
    name = safeName(name);
    const ext = path.extname(name); const base = name.slice(0, name.length - ext.length);
    let finalName = name;
    for (let i = 1; fs.existsSync(path.join(dir, finalName)); i++) finalName = `${base} (${i})${ext}`;
    u = { fh: await fs.promises.open(path.join(dir, finalName), 'wx'), name: finalName, file: path.join(dir, finalName) };
    uploads.set(uploadId, u);
  }
  await u.fh.write(Buffer.from(data), 0, data.length, offset);
  if (last) { await u.fh.close(); uploads.delete(uploadId); return u.name; }
  return undefined;
});
ipcMain.handle('bonafs:abortAll', () => abortAllUploads());
ipcMain.handle('bonafs:abortWrite', async (_e, uploadId) => {
  const u = uploads.get(uploadId); if (!u) return;
  uploads.delete(uploadId); await u.fh.close().catch(() => {}); await fs.promises.rm(u.file, { force: true });
});
ipcMain.handle('bonafs:mkdir', async (_e, rel, name) => { await fs.promises.mkdir(path.join(visiblePath(rel), safeName(name)), { recursive: true }); });
ipcMain.handle('bonafs:rename', async (_e, rel, newName) => {
  const abs = visiblePath(rel);
  if (abs === fs.realpathSync(shareRoot())) throw new Error('no se puede renombrar la carpeta raíz');
  const dest = path.join(path.dirname(abs), safeName(newName));
  if (fs.existsSync(dest)) throw new Error('ya existe ese nombre');
  await fs.promises.rename(abs, dest);
});
ipcMain.handle('bonafs:remove', async (_e, rel) => { const abs = visiblePath(rel); if (abs === fs.realpathSync(shareRoot())) throw new Error('no se puede borrar la carpeta raíz'); await fs.promises.rm(abs, { recursive: true }); });

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
  const saved = loadWindowState();
  win = new BrowserWindow({
    width: 1280, height: 820, ...(saved && saved.width ? { width: saved.width, height: saved.height } : {}),
    ...(saved && saved.x !== undefined ? { x: saved.x, y: saved.y } : {}), backgroundColor: '#11111b', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js'), nodeIntegrationInSubFrames: true },
  });
  if (saved && saved.maximized) win.maximize();
  const saveWindowState = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const maximized = win.isMaximized();
    // Maximizada: se conserva el último tamaño normal en vez del de pantalla completa.
    const bounds = maximized ? (readSettings().window || {}) : win.getBounds();
    writeSettings({ window: { ...bounds, maximized } });
  };
  let saveTimer = null;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 500); };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('maximize', saveSoon);
  win.on('unmaximize', saveSoon);
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
