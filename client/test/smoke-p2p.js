// P2P 직접 전송 자동 점검: 클라이언트 두 개를 띄워 파일이 서버를 거치지 않고 전달되는지 확인한다.
// 실행(서버를 PORT=7171 로 켠 뒤):
//   SB_ROLE=send SB_ROOM=방이름 SB_FILE=보낼파일 npx electron test/smoke-p2p.js
//   SB_ROLE=recv SB_ROOM=방이름 SB_FILE=보낼파일 npx electron test/smoke-p2p.js
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const { SB_ROLE: role, SB_ROOM: roomName, SB_FILE: file } = process.env;
const URL = process.env.SB_URL || 'ws://127.0.0.1:7171';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `sb-p2p-${role}-`));
app.setPath('userData', path.join(tmp, 'user'));
app.setPath('downloads', path.join(tmp, 'downloads'));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) { const v = await fn(); if (v) return v; }
  throw new Error(`시간 초과(${role}): ${what}`);
}

let dump = async () => {};
async function run() {
  require('../main.js');
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0], '창 생성');
  const js = (code) => win.webContents.executeJavaScript(code, true);
  win.webContents.on('console-message', (_e, _level, message) => console.log(`[화면:${role}] ${message}`));
  dump = () => js(`document.getElementById('messages').innerText`).then((t) => console.log(`[대화:${role}] ${t}`), () => {});
  await until(() => js(`!document.getElementById('login').hidden`), '로그인 화면');
  await js(`fUrl.value=${JSON.stringify(URL)}; fNick.value=${JSON.stringify(`${role}${Date.now() % 100000}`)}; fPass.value='pass1234'; btnRegister.click()`);
  await until(() => js(`!document.getElementById('app').hidden`), '가입');

  if (role === 'send') {
    await js(`request('room.create', { name: ${JSON.stringify(roomName)}, isPublic: true })`);
    await until(() => js(`document.querySelectorAll('#memberList li').length === 2`), '받는 쪽 입장');
    await js(`btnAttach.click()`);
    await until(() => js(`[...document.querySelectorAll('.msg .text')].some((n) => n.textContent === '받았음')`), '받는 쪽의 완료 메시지', 40000);
  } else {
    const roomId = await until(() => js(`request('room.list').then((r) => r.rooms.find((x) => x.name === ${JSON.stringify(roomName)})?.id)`), '방 찾기');
    await js(`request('room.join', { roomId: ${roomId} }).then((r) => { state.rooms.set(r.room.id, r.room); return openView({ type: 'room', id: r.room.id }); })`);
    await until(() => js(`(() => { const b = document.querySelector('.file .row button'); if (b) b.click(); return !!b; })()`), '파일 메시지 도착');
    const saved = path.join(tmp, 'downloads', 'Sarangbang', path.basename(file));
    await until(() => js(`state.stats.p2p + state.stats.relay === 1`), '파일 수신 완료', 25000);
    const stats = await js(`state.stats`);
    assert.ok(fs.readFileSync(saved).equals(fs.readFileSync(file)), '받은 파일이 원본과 같아야 함');
    assert.deepEqual(stats, { p2p: 1, relay: 0 }, '서버 경유가 아니라 직접 전송이어야 함');
    await js(`input.textContent='받았음'; composer.requestSubmit()`);
    await sleep(500);
  }
  console.log(`P2P_OK ${role}`);
}

run().then(() => app.exit(0), async (e) => { console.error('P2P_FAIL', e.message); await dump(); app.exit(1); });
