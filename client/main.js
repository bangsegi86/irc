// 사랑방 클라이언트 메인 프로세스: 창·트레이·알림 팝업 관리, 파일 읽기/쓰기
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, screen, clipboard, nativeTheme } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

// P2P 직접 전송이 같은 공유기 안에서도 잘 연결되도록 내부 IP 숨김(mDNS)을 끈다
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const TOAST_MS = 5000;       // 알림 팝업이 떠 있는 시간
const TOAST_SLIDE_MS = 300;  // 올라오고 내려가는 시간

let mainWindow = null;
let tray = null;
let toastWindow = null;
let quitting = false;
const dmWindows = new Map(); // 상대 ID -> 창
const saves = new Map();     // 저장 중인 파일: 핸들 -> { fh, path }
let nextSave = 1;

// 파일ID -> 내 PC의 경로 (내가 보낸 원본 또는 내가 받은 사본). 서버에는 파일이 없으므로 이 표가 유일한 위치 정보다.
const mapPath = () => path.join(app.getPath('userData'), 'files.json');
let fileMap = {};
function loadFileMap() { try { fileMap = JSON.parse(fs.readFileSync(mapPath(), 'utf8')); } catch { fileMap = {}; } }
function saveFileMap() { fs.writeFileSync(mapPath(), JSON.stringify(fileMap)); }

// 화면 밝기 설정: system(윈도우 설정 따르기) | light | dark. 모든 창(주 창·1:1 창·알림 팝업)에 함께 적용된다
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function loadTheme() { try { const t = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).theme; return ['system', 'light', 'dark'].includes(t) ? t : 'system'; } catch { return 'system'; } }
function setTheme(theme) {
  const t = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  nativeTheme.themeSource = t;
  try { fs.writeFileSync(settingsPath(), JSON.stringify({ theme: t })); } catch { /* 저장 실패는 무시 */ }
  return t;
}

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

// 아이콘 파일 없이 쓰는 기본 아이콘(파란 원)
function appIcon() {
  const size = 32, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - 15.5, y - 15.5) <= 14) buf.set([0xf5, 0x9c, 0x5b, 0xff], (y * size + x) * 4); // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createWindow(query, opts) {
  const win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 420, minHeight: 400, autoHideMenuBar: true, icon: appIcon(),
    ...opts,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('focus', () => win.flashFrame(false));
  return win;
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openDm(peerId, nick) {
  const existing = dmWindows.get(peerId);
  if (existing) { existing.show(); existing.focus(); return; }
  const win = createWindow({ dm: String(peerId), nick }, { width: 480, height: 620, title: `${nick} — 1:1 대화` });
  dmWindows.set(peerId, win);
  win.on('closed', () => dmWindows.delete(peerId));
}

const isActive = (win) => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();

// 화면 우측 하단에서 올라왔다가 5초 뒤 내려가는 알림 팝업. target: 눌렀을 때 갈 곳
function showToast(title, body, target) {
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.destroy();
  const { workArea } = screen.getPrimaryDisplay();
  const width = 360, height = 104;
  const win = toastWindow = new BrowserWindow({
    width, height, x: workArea.x + workArea.width - width - 12, y: workArea.y + workArea.height - height,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.toastTarget = target || null;
  win.loadFile(path.join(__dirname, 'renderer', 'toast.html'), { query: { title: String(title), body: String(body || ''), ms: String(TOAST_MS), slide: String(TOAST_SLIDE_MS) } });
  win.once('ready-to-show', () => win.showInactive());
  setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, TOAST_MS + TOAST_SLIDE_MS * 2 + 200);
  win.on('closed', () => { if (toastWindow === win) toastWindow = null; });
}

function createTray() {
  try {
    tray = new Tray(appIcon());
    tray.setToolTip('사랑방');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '사랑방 열기', click: showMain },
      { type: 'separator' },
      { label: '종료', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showMain);
    tray.on('double-click', showMain);
  } catch (e) { console.error('트레이 아이콘을 만들지 못했습니다.', e); }
}

function setup() {
  loadFileMap();
  nativeTheme.themeSource = loadTheme();
  app.setAppUserModelId('kr.sarangbang.client');
  createTray();
  mainWindow = createWindow({}, { title: '사랑방' });

  // 창을 닫으면 종료하지 않고 트레이로 들어간다. 완전히 끄려면 트레이 메뉴의 '종료'.
  let hintShown = false;
  mainWindow.on('close', (e) => {
    if (quitting || !tray) return;
    e.preventDefault();
    mainWindow.hide();
    if (!hintShown) { hintShown = true; showToast('사랑방이 트레이에서 실행 중입니다', '호출이 오면 여기에 알려 드립니다. 끄려면 트레이 아이콘을 우클릭해 종료를 누르세요.'); }
  });
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });

  ipcMain.handle('dm:open', (_e, peerId, nick) => openDm(Number(peerId), String(nick)));

  // 1:1 메시지가 왔을 때: 그 창을 보고 있지 않으면 팝업. 1:1 창이 열려 있는지 돌려준다.
  ipcMain.handle('dm:incoming', (_e, peerId, nick, preview) => {
    const win = dmWindows.get(Number(peerId));
    if (!isActive(win)) {
      showToast(`${nick} 님의 1:1 메시지`, preview, { dm: Number(peerId), nick: String(nick) });
      win?.flashFrame(true);
    }
    return !!win;
  });

  // opts.onlyIfAway: 주 창을 보고 있지 않을 때(트레이·최소화·다른 프로그램 사용 중)만 팝업
  // opts.noticeId: 팝업을 누르면 해당 알림의 방으로 이동
  ipcMain.handle('notify', (e, title, body, opts = {}) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (opts.onlyIfAway && isActive(mainWindow)) return;
    showToast(title, body, opts.noticeId != null ? { noticeId: opts.noticeId } : null);
    if (sender && sender.isVisible() && !sender.isFocused()) sender.flashFrame(true);
  });

  ipcMain.handle('toast:click', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const target = win?.toastTarget;
    win?.destroy();
    if (target?.dm) return openDm(target.dm, target.nick);
    showMain();
    if (target?.noticeId != null) mainWindow?.webContents.send('goto', target);
  });

  ipcMain.handle('file:pick', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    return (await Promise.all(r.filePaths.map(registerFile))).filter(Boolean);
  });
  ipcMain.handle('file:register', (_e, filePath) => registerFile(filePath).catch(() => null));

  // 붙여넣은 이미지(캡처 화면 등)는 파일이 없으므로 이 PC에 저장해 두고 그 파일을 보낸다
  ipcMain.handle('file:savePasted', async (_e, bytes, mime) => {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }[mime];
    if (!ext || !bytes || bytes.length > 50 * 1024 * 1024) return null;
    const dir = path.join(app.getPath('userData'), 'pasted');
    await fsp.mkdir(dir, { recursive: true });
    const d = new Date(), two = (n) => String(n).padStart(2, '0');
    const base = `붙여넣은 이미지 ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    let target = path.join(dir, `${base}.${ext}`);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i}).${ext}`);
    await fsp.writeFile(target, Buffer.from(bytes));
    return registerFile(target);
  });

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

  ipcMain.handle('theme:get', () => nativeTheme.themeSource);
  ipcMain.handle('theme:set', (_e, theme) => setTheme(theme));
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('file:open', (_e, fileId) => fileMap[fileId] && shell.openPath(fileMap[fileId]));
  ipcMain.handle('file:show', (_e, fileId) => fileMap[fileId] && shell.showItemInFolder(fileMap[fileId]));
}

// 이미 실행 중이면(트레이에 있으면) 새로 띄우지 않고 기존 창을 보여 준다
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', showMain);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* 트레이에서 계속 실행 */ });
  app.whenReady().then(setup);
} else {
  app.quit();
}
