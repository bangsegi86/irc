// 사랑방 클라이언트 메인 프로세스: 창 관리, 파일 읽기/쓰기, 알림
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

let mainWindow = null;
const dmWindows = new Map(); // 상대 ID -> 창
const saves = new Map();     // 저장 중인 파일: 핸들 -> { fd, path }
let nextSave = 1;

// 파일ID -> 내 PC의 경로 (내가 보낸 원본 또는 내가 받은 사본). 서버에는 파일이 없으므로 이 표가 유일한 위치 정보다.
const mapPath = () => path.join(app.getPath('userData'), 'files.json');
let fileMap = {};
function loadFileMap() { try { fileMap = JSON.parse(fs.readFileSync(mapPath(), 'utf8')); } catch { fileMap = {}; } }
function saveFileMap() { fs.writeFileSync(mapPath(), JSON.stringify(fileMap)); }

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const mimeOf = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';

async function registerFile(filePath) {
  const st = await fsp.stat(filePath);
  if (!st.isFile()) return null;
  const fileId = randomUUID();
  fileMap[fileId] = filePath;
  saveFileMap();
  const name = path.basename(filePath);
  return { fileId, name, size: st.size, mime: mimeOf(name) };
}

function createWindow(query, opts) {
  const win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 420, minHeight: 400, autoHideMenuBar: true,
    ...opts,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('focus', () => win.flashFrame(false));
  return win;
}

function openDm(peerId, nick) {
  const existing = dmWindows.get(peerId);
  if (existing) { existing.show(); existing.focus(); return; }
  const win = createWindow({ dm: String(peerId), nick }, { width: 480, height: 620, title: `${nick} — 1:1 대화` });
  dmWindows.set(peerId, win);
  win.on('closed', () => dmWindows.delete(peerId));
}

function alertUser(win, title, body) {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body });
    n.on('click', () => { win?.show(); win?.focus(); });
    n.show();
  }
  if (win && !win.isFocused()) win.flashFrame(true);
}

app.whenReady().then(() => {
  loadFileMap();
  app.setAppUserModelId('kr.sarangbang.client');
  mainWindow = createWindow({}, { title: '사랑방' });
  mainWindow.on('closed', () => app.quit());

  ipcMain.handle('dm:open', (_e, peerId, nick) => openDm(Number(peerId), String(nick)));

  // 1:1 메시지가 왔을 때: 창이 열려 있으면 그 창을 깜빡이고 true, 없으면 알림만 띄우고 false
  ipcMain.handle('dm:incoming', (_e, peerId, nick, preview) => {
    const win = dmWindows.get(Number(peerId));
    alertUser(win || mainWindow, `${nick} 님의 1:1 메시지`, preview);
    return !!win;
  });

  ipcMain.handle('notify', (e, title, body) => alertUser(BrowserWindow.fromWebContents(e.sender), title, body));

  ipcMain.handle('file:pick', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    return (await Promise.all(r.filePaths.map(registerFile))).filter(Boolean);
  });
  ipcMain.handle('file:register', (_e, filePath) => registerFile(filePath).catch(() => null));

  ipcMain.handle('file:local', async (_e, fileId) => {
    const p = fileMap[fileId];
    if (!p) return null;
    try { await fsp.access(p); return { path: p, url: pathToFileURL(p).href }; } catch { return null; }
  });

  ipcMain.handle('file:read', async (_e, fileId, offset, length) => {
    const fh = await fsp.open(fileMap[fileId], 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally { await fh.close(); }
  });

  ipcMain.handle('file:saveStart', async (_e, name) => {
    const dir = path.join(app.getPath('downloads'), 'Sarangbang');
    await fsp.mkdir(dir, { recursive: true });
    const safe = path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
    const ext = path.extname(safe), base = path.basename(safe, ext);
    let target = path.join(dir, safe);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
    const handle = nextSave++;
    saves.set(handle, { fh: await fsp.open(target, 'wx'), path: target });
    return handle;
  });
  ipcMain.handle('file:saveChunk', async (_e, handle, chunk) => { await saves.get(handle).fh.write(Buffer.from(chunk)); });
  ipcMain.handle('file:saveEnd', async (_e, handle, fileId) => {
    const s = saves.get(handle); saves.delete(handle);
    await s.fh.close();
    fileMap[fileId] = s.path;
    saveFileMap();
    return { path: s.path, url: pathToFileURL(s.path).href };
  });
  ipcMain.handle('file:saveAbort', async (_e, handle) => {
    const s = saves.get(handle); if (!s) return;
    saves.delete(handle);
    await s.fh.close().catch(() => {});
    await fsp.unlink(s.path).catch(() => {});
  });

  ipcMain.handle('file:open', (_e, fileId) => fileMap[fileId] && shell.openPath(fileMap[fileId]));
  ipcMain.handle('file:show', (_e, fileId) => fileMap[fileId] && shell.showItemInFolder(fileMap[fileId]));
});

app.on('window-all-closed', () => app.quit());
