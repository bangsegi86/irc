// 서버 화면 자동 점검: 실제로 서버를 켜고, 접속·메시지를 일으켜 화면에 제대로 보이는지 확인한다.
// 실행: npx electron gui-test/smoke.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-gui-'));
const shots = process.env.SB_SHOTS || tmp;
process.env.DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const PORT = 7281, PORT2 = 7282;
fs.writeFileSync(path.join(process.env.DATA_DIR, 'server-settings.json'), JSON.stringify({ port: PORT, theme: 'dark' }));
app.setPath('userData', path.join(tmp, 'user'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; }
  throw new Error(`시간 초과: ${what}`);
}
function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let id = 1; const wait = new Map();
    ws.on('message', (d, bin) => { if (bin) return; const m = JSON.parse(d.toString()); wait.get(m.id)?.(m); });
    ws.once('open', () => resolve({ ws, req: (t, body = {}) => new Promise((res) => { const n = id++; wait.set(n, res); ws.send(JSON.stringify({ t, id: n, ...body })); }) }));
    ws.once('error', reject);
  });
}

async function run() {
  await import('../gui/main.js');
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0], '창 생성');
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { await sleep(250); fs.writeFileSync(path.join(shots, name), (await win.capturePage()).toPNG()); };

  // 1. 켜자마자 서버가 실행되고 주소가 보인다
  await until(() => js(`statusTitle.textContent === '서버 실행 중' && navStatusText.textContent.includes('${PORT}')`), '서버 실행 표시');
  assert.ok(await js(`[...document.querySelectorAll('.addr b')].every((b) => b.textContent.endsWith(':${PORT}'))`));

  // 2. 접속·가입·방·메시지·실패를 일으킨다
  const a = await client(PORT), b = await client(PORT);
  await a.req('login', { nick: '없는사람', password: 'x' });
  await a.req('register', { nick: '세기', password: 'pass1234' });
  const bob = await b.req('register', { nick: '민수', password: 'pass1234' });
  const { room } = await a.req('room.create', { name: '주말 모임', isPublic: false });
  await a.req('room.invite', { roomId: room.id, nick: '민수' });
  await a.req('msg.send', { roomId: room.id, text: '비밀내용ABC' });
  await a.req('msg.send', { toUserId: bob.user.id, rich: [{ s: '귓속말', b: 1 }] });
  await b.req('room.join', { roomId: room.id });
  await a.req('call', { userId: bob.user.id });

  // 3. 현황: 접속자 표와 숫자
  await until(() => js(`connTable.tBodies[0].rows.length === 2 && stOnline.textContent === '2명' && stUsers.textContent === '2명' && stRooms.textContent === '1개' && stMessages.textContent === '2건'`), '현황 숫자와 접속자 표', 6000);
  assert.deepEqual(await js(`[...connTable.tBodies[0].rows].map((r) => [r.cells[0].textContent, r.cells[1].textContent])`), [['민수', '127.0.0.1'], ['세기', '127.0.0.1']]);
  await until(() => js(`recentProblems.querySelectorAll('.logRow.problem').length === 2 && navProblems.textContent === '2'`), '최근 문제 2건');
  await shot('server-home.png');

  // 4. 기록: 읽기 쉬운 문장, 종류별 개수, 걸러 보기, 내용 미포함
  await js(`document.querySelector('[data-view="log"]').click()`);
  await until(() => js(`document.querySelectorAll('#logList .logRow').length >= 12`), '기록 줄 표시');
  const text = await js(`logList.innerText`);
  for (const expected of ['서버를 시작했습니다', '로그인 실패 — 닉네임 또는 비밀번호가 틀림', '새로 가입했습니다', "방 '주말 모임(#1)' 을 만들었습니다", "민수 님을 방 '주말 모임(#1)' 에 초대했습니다",
    "방 '주말 모임(#1)' 에 메시지를 보냈습니다", '7자', '민수 님에게 1:1 메시지를 보냈습니다', '서식 있음', '방 입장 실패 — 비공개 방(초대 필요)', '민수 님을 호출했습니다', '127.0.0.1']) {
    assert.ok(text.includes(expected), `기록 화면에 있어야 함: ${expected}\n${text}`);
  }
  assert.ok(!text.includes('비밀내용ABC') && !text.includes('귓속말'), '메시지 내용이 보이면 안 됨');
  await shot('server-log.png');
  await js(`[...document.querySelectorAll('#cats button')].find((b) => b.textContent.startsWith('문제')).click()`);
  assert.deepEqual(await js(`[...document.querySelectorAll('#logList .logRow .kind')].map((n) => n.textContent)`), ['로그인 실패', '요청 실패']);
  await js(`[...document.querySelectorAll('#cats button')].find((b) => b.textContent.startsWith('전체')).click()`);
  await js(`[...document.querySelectorAll('#logList button.who')].find((n) => n.textContent === '민수').click()`); // 이름을 누르면 그 사람만
  await until(() => js(`logSearch.value === '민수' && [...document.querySelectorAll('#logList .logRow')].every((r) => r.textContent.includes('민수'))`), '이름으로 걸러 보기');
  await js(`btnLogCopy.click()`);
  await sleep(150);
  const copied = await (await import('electron')).clipboard.readText();
  assert.match(copied, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  가입  민수  127\.0\.0\.1  새로 가입했습니다/);
  await js(`logSearch.value = ''; logSearch.dispatchEvent(new Event('input'))`);

  // 5. 실시간: 화면을 보는 중에 새 기록이 추가된다
  const before = await js(`document.querySelectorAll('#logList .logRow').length`);
  await b.req('msg.send', { toUserId: bob.user.id, text: '혼잣말' });
  await until(() => js(`document.querySelectorAll('#logList .logRow').length === ${before + 1}`), '새 기록 실시간 추가');

  // 6. 설정: 포트를 바꿔 저장하면 서버가 새 포트로 다시 시작되고 파일에 저장된다
  await js(`document.querySelector('[data-view="settings"]').click()`);
  assert.equal(await js(`sPort.value`), String(PORT));
  await js(`sPort.value = '${PORT2}'; sPassword.value = '우리끼리'; sTheme.value = 'light'; settingsForm.requestSubmit()`);
  await until(() => js(`/다시 시작했습니다/.test(settingsMsg.textContent) && navStatusText.textContent.includes('${PORT2}')`), '새 포트로 다시 시작');
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'server-settings.json'), 'utf8'));
  assert.deepEqual([saved.port, saved.serverPassword, saved.theme], [PORT2, '우리끼리', 'light']);
  await assert.rejects(client(PORT), '옛 포트는 닫혀 있어야 함');
  const c = await client(PORT2);
  assert.equal((await c.req('register', { nick: '암호없이', password: 'pass1234' })).code, 'bad_server_password');
  assert.equal((await c.req('register', { nick: '새사람', password: 'pass1234', serverPassword: '우리끼리' })).t, 'ok');
  assert.equal((await c.req('login', { nick: '세기', password: 'pass1234' })).t, 'ok', '다시 시작해도 계정이 남아 있어야 함');
  await shot('server-settings.png');

  // 7. 기록 끄기: 저장하면 더 이상 쌓이지 않고 안내가 보인다
  await js(`sLog.checked = false; settingsForm.requestSubmit()`);
  await until(() => js(`/다시 시작했습니다/.test(settingsMsg.textContent) && !logOff.hidden`), '기록 꺼짐 안내');
  const logFile = path.join(process.env.DATA_DIR, 'logs', fs.readdirSync(path.join(process.env.DATA_DIR, 'logs'))[0]);
  const sizeBefore = fs.statSync(logFile).size;
  const d = await client(PORT2);
  await d.req('login', { nick: '세기', password: 'pass1234' });
  await sleep(300);
  assert.equal(fs.statSync(logFile).size, sizeBefore, '기록을 끄면 파일에 더 쌓이지 않아야 함');
  assert.ok(!fs.readFileSync(logFile, 'utf8').includes('비밀내용ABC'), '기록 파일에 메시지 내용이 없어야 함');

  // 8. 중지/시작 버튼, 그리고 포트가 이미 쓰이는 경우의 안내
  await js(`document.querySelector('[data-view="home"]').click(); btnToggle.click()`);
  await until(() => js(`statusTitle.textContent === '서버 중지됨' && btnToggle.textContent === '서버 시작'`), '중지');
  await assert.rejects(client(PORT2), '중지하면 접속할 수 없어야 함');
  const { WebSocketServer } = await import('ws');
  const blocker = new WebSocketServer({ port: PORT2 });
  await new Promise((r) => blocker.once('listening', r));
  await js(`btnToggle.click()`);
  await until(() => js(`!errorBox.hidden && errorBox.textContent.includes('다른 프로그램이 쓰고 있습니다')`), '포트 충돌 안내');
  await shot('server-error.png');
  await new Promise((r) => blocker.close(r));
  await js(`btnToggle.click()`);
  await until(() => js(`statusTitle.textContent === '서버 실행 중' && errorBox.hidden`), '다시 시작');

  // 9. 창을 닫아도 서버는 계속 돈다
  win.close();
  await until(() => !win.isDestroyed() && !win.isVisible(), '닫으면 숨겨짐');
  assert.equal((await (await client(PORT2)).req('login', { nick: '세기', password: 'pass1234' })).t, 'ok', '창을 닫아도 접속되어야 함');

  console.log(`GUI_OK shots=${shots}`);
}

run().then(() => app.exit(0), (e) => { console.error('GUI_FAIL', e); app.exit(1); });
