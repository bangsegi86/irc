// 사랑방 서버 화면(GUI): 시작/중지, 설정, 접속 주소, 접속자, 실시간 기록을 창으로 보여 준다.
// 서버 본체(src/server.js)를 이 프로그램 안에서 그대로 돌린다.
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, shell, clipboard } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = { port: 7070, serverPassword: '', retentionDays: 0, log: true, logDays: 14, autoStart: true, launchAtLogin: false, theme: 'system' };
const KEEP_RECENT = 3000;
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;

let win = null, tray = null, quitting = false;
let server = null;
let state = { running: false, error: null, startedAt: null, port: null };
let settings = { ...DEFAULTS };
const recent = []; // 화면을 다시 열어도 보이도록 최근 기록을 메모리에 둔다

// 데이터 폴더: 소스로 실행하면 server\data (검은 창 서버와 같은 곳), 실행 파일이면 그 옆 data
function dataDir() {
  const wanted = process.env.DATA_DIR || path.join(app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(here, '..'), 'data');
  try { fs.mkdirSync(wanted, { recursive: true }); fs.accessSync(wanted, fs.constants.W_OK); return wanted; } catch {
    const fallback = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}
const logsDir = () => path.join(dataDir(), 'logs');
const settingsPath = () => path.join(dataDir(), 'server-settings.json');

function cleanSettings(input) {
  const s = { ...DEFAULTS, ...(input && typeof input === 'object' ? input : {}) };
  const int = (v, min, max, fallback) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : fallback);
  return {
    port: int(s.port, 1, 65535, DEFAULTS.port),
    serverPassword: String(s.serverPassword || '').slice(0, 100),
    retentionDays: int(s.retentionDays, 0, 36500, 0),
    log: !!s.log,
    logDays: int(s.logDays, 0, 36500, DEFAULTS.logDays),
    autoStart: !!s.autoStart,
    launchAtLogin: !!s.launchAtLogin,
    theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : 'system',
  };
}
function loadSettings() { try { settings = cleanSettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))); } catch { settings = cleanSettings({}); } }
function saveSettings() { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); }

function addresses() {
  const list = [];
  for (const group of Object.values(os.networkInterfaces())) for (const ni of group || []) if (ni.family === 'IPv4' && !ni.internal) list.push(ni.address);
  return list;
}

function publicState() {
  return {
    ...state, settings, addresses: addresses(), dataDir: dataDir(), logsDir: logsDir(),
    version: VERSION, uptimeFrom: state.startedAt,
  };
}
const push = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const pushState = () => { push('state', publicState()); refreshTray(); };

function onLog(entry) {
  recent.push(entry);
  if (recent.length > KEEP_RECENT) recent.splice(0, recent.length - KEEP_RECENT);
  push('log', entry);
}
// 기록이 꺼져 있어도 서버 시작/중지·오류는 화면에 보여 준다
const note = (kind, fields = {}) => onLog({ ts: Date.now(), kind, fields, local: true });

async function startSrv() {
  if (server) return;
  state = { running: false, error: null, startedAt: null, port: settings.port };
  let s = null;
  try {
    s = startServer({
      port: settings.port, dbPath: path.join(dataDir(), 'sarangbang.db'), serverPassword: settings.serverPassword, retentionDays: settings.retentionDays,
      log: { enabled: settings.log, dir: logsDir(), days: settings.logDays, echo: false, sink: onLog },
    });
    await s.ready;
    server = s;
    state = { running: true, error: null, startedAt: Date.now(), port: s.port };
    if (!settings.log) note('서버 시작', { 포트: s.port, 참고: '기록 꺼짐' });
  } catch (e) {
    try { await s?.close(); } catch { /* 이미 닫힘 */ }
    state.error = e.code === 'EADDRINUSE' ? `포트 ${settings.port}를 다른 프로그램이 쓰고 있습니다. 설정에서 포트를 바꿔 주세요.` : `서버를 시작하지 못했습니다: ${e.message}`;
    note('서버 시작 실패', { 포트: settings.port, 사유: e.code || e.message });
  }
  pushState();
}

async function stopSrv() {
  if (!server) return;
  const s = server;
  server = null;
  await s.close();
  state = { running: false, error: null, startedAt: null, port: settings.port };
  if (!settings.log) note('서버 중지', {});
  pushState();
}

// ---------- 지난 기록 파일 읽기 ----------
function parseLine(line) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})  \[([^\]]+)\]  ?(.*)$/.exec(line);
  if (!m) return null;
  const fields = {};
  for (const part of m[8].split('  ')) { const i = part.indexOf('='); if (i > 0) fields[part.slice(0, i)] = part.slice(i + 1); }
  return { ts: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), kind: m[7], fields };
}
function logDates() {
  try { return fs.readdirSync(logsDir()).map((n) => /^(\d{4}-\d{2}-\d{2})\.log$/.exec(n)?.[1]).filter(Boolean).sort().reverse(); } catch { return []; }
}
function readLog(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return [];
  try { return fs.readFileSync(path.join(logsDir(), `${date}.log`), 'utf8').split('\n').map(parseLine).filter(Boolean); } catch { return []; }
}

// ---------- 창·트레이 ----------
function icon(color = [0xf5, 0x9c, 0x5b]) {
  const size = 32, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inside = Math.abs(x - 15.5) <= 12 && Math.abs(y - 15.5) <= 12; // 네모: 클라이언트(원)와 구분
    if (inside) buf.set([...color, 0xff], (y * size + x) * 4);
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`사랑방 서버 — ${state.running ? `실행 중 (포트 ${state.port})` : '중지됨'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '서버 화면 열기', click: showWin },
    state.running ? { label: '서버 중지', click: stopSrv } : { label: '서버 시작', click: startSrv },
    { type: 'separator' },
    { label: '종료 (서버도 꺼짐)', click: () => { quitting = true; app.quit(); } },
  ]));
}

async function setup() {
  loadSettings();
  nativeTheme.themeSource = settings.theme;
  try { tray = new Tray(icon()); tray.on('click', showWin); tray.on('double-click', showWin); } catch (e) { console.error('트레이 아이콘을 만들지 못했습니다.', e); }

  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 760, minHeight: 520, title: '사랑방 서버', autoHideMenuBar: true, icon: icon(),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(here, 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // 창을 닫아도 서버는 계속 돈다(트레이). 완전히 끄려면 트레이 메뉴의 종료.
  win.on('close', (e) => { if (quitting || !tray) return; e.preventDefault(); win.hide(); });
  win.on('closed', () => { win = null; app.quit(); });

  ipcMain.handle('state:get', () => publicState());
  ipcMain.handle('status:get', () => (server ? server.status() : null));
  ipcMain.handle('server:start', async () => { await startSrv(); return publicState(); });
  ipcMain.handle('server:stop', async () => { await stopSrv(); return publicState(); });
  ipcMain.handle('settings:save', async (_e, input) => {
    const before = settings;
    settings = cleanSettings(input);
    saveSettings();
    nativeTheme.themeSource = settings.theme;
    try { app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin }); } catch { /* 지원하지 않는 환경 */ }
    const needRestart = ['port', 'serverPassword', 'retentionDays', 'log', 'logDays'].some((k) => before[k] !== settings[k]);
    const wasRunning = !!server;
    if (wasRunning && needRestart) { await stopSrv(); await startSrv(); }
    pushState();
    return { state: publicState(), restarted: wasRunning && needRestart };
  });
  ipcMain.handle('log:recent', () => recent);
  ipcMain.handle('log:dates', () => logDates());
  ipcMain.handle('log:read', (_e, date) => readLog(date));
  ipcMain.handle('open:data', () => shell.openPath(dataDir()));
  ipcMain.handle('open:logs', () => { fs.mkdirSync(logsDir(), { recursive: true }); return shell.openPath(logsDir()); });
  ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text)));

  // 오늘 이미 쌓인 기록을 화면에 먼저 채운다(프로그램을 껐다 켠 경우)
  const d = new Date(), two = (n) => String(n).padStart(2, '0');
  recent.push(...readLog(`${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`).slice(-KEEP_RECENT));

  if (settings.autoStart) await startSrv(); else pushState();
  refreshTray();
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', showWin);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* 트레이에서 계속 실행 */ });
  app.on('will-quit', () => { try { server?.close(); } catch { /* 종료 중 */ } });
  app.whenReady().then(setup);
} else {
  app.quit();
}
