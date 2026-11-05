// BonaChat: aplica la calidad elegida (resolución / fps) a la captura de pantalla de las llamadas.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('__bonaShare', {
  quality: () => ipcRenderer.sendSync('bona:share-quality'),
});

// Carpeta compartida (ver main.js). Solo las usa la app web de BonaChat.
const call = (name) => (...args) => ipcRenderer.invoke('bonafs:' + name, ...args);
contextBridge.exposeInMainWorld('bonaFS', {
  current: call('current'), pick: call('pick'), clear: call('clear'),
  list: call('list'), stat: call('stat'), read: call('read'), write: call('write'), abortWrite: call('abortWrite'),
  mkdir: call('mkdir'), rename: call('rename'), remove: call('remove'),
});

webFrame.executeJavaScript(`(() => {
  const md = navigator.mediaDevices;
  if (!md || !md.getDisplayMedia || md.__bonaPatched) return;
  const orig = md.getDisplayMedia.bind(md);
  md.__bonaPatched = true;
  md.getDisplayMedia = (c) => {
    let q = null;
    try { q = window.__bonaShare && window.__bonaShare.quality(); } catch (e) {}
    const cons = c && typeof c === 'object' ? { ...c } : {};
    // Audio del sistema sin el de la propia app: así los demás no se escuchan a sí mismos por la pantalla compartida.
    if (cons.audio) cons.audio = { ...(typeof cons.audio === 'object' ? cons.audio : {}), restrictOwnAudio: true, suppressLocalAudioPlayback: true };
    if (q) {
      const v = cons.video && typeof cons.video === 'object' ? cons.video : {};
      cons.video = { ...v, width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps } };
    } else if (!cons.video) {
      cons.video = true;
    }
    return orig(cons);
  };
})();`);
