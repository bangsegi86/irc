// 클라이언트 자동 점검: 실제 서버에 붙어서 화면을 조작해 본다.
// 실행: (서버를 PORT=7171 로 켠 뒤)  npx electron test/smoke.js
const { app, dialog, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const WebSocket = require('../../server/node_modules/ws');

const URL = process.env.SB_URL || 'ws://127.0.0.1:7171';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-'));
app.setPath('userData', path.join(tmp, 'user'));
app.setPath('downloads', path.join(tmp, 'downloads'));
const shots = process.env.SB_SHOTS || tmp;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; }
  throw new Error(`시간 초과: ${what}`);
}

// 상대 역할을 하는 간이 클라이언트
function peer() {
  const ws = new WebSocket(URL);
  let nextId = 1;
  const pending = new Map(), events = [];
  const p = {
    ws, events, binary: [], onBinary: null,
    opened: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    req: (t, body = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ t, id, ...body })); }),
    emit: (t, body = {}) => ws.send(JSON.stringify({ t, ...body })),
    next: (t, pred = () => true) => until(() => { const i = events.findIndex((e) => e.t === t && pred(e)); return i >= 0 && events.splice(i, 1)[0]; }, `상대가 '${t}' 수신`),
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) return p.onBinary?.(data);
    const m = JSON.parse(data.toString());
    if ((m.t === 'ok' || m.t === 'err') && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id); return m.t === 'ok' ? q.res(m) : q.rej(new Error(m.message)); }
    events.push(m);
  });
  return p;
}

async function run() {
  const suffix = Date.now() % 100000;
  const myNick = `나${suffix}`, peerNick = `상대${suffix}`, roomName = `점검방${suffix}`;
  const bigFile = path.join(tmp, '보고서.bin');
  const bigContent = require('node:crypto').randomBytes(700_000);
  fs.writeFileSync(bigFile, bigContent);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [bigFile] });

  require('../main.js');
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0], '주 창 생성');
  const js = (w, code) => w.webContents.executeJavaScript(code, true);
  const shot = async (w, name) => fs.writeFileSync(path.join(shots, name), (await w.capturePage()).toPNG());
  await until(() => js(win, `!document.getElementById('login').hidden`), '로그인 화면');

  const b = peer();
  await b.opened;
  b.me = (await b.req('register', { nick: peerNick, password: 'pass1234' })).user;

  // 1. 가입
  await js(win, `fUrl.value=${JSON.stringify(URL)}; fNick.value=${JSON.stringify(myNick)}; fPass.value='pass1234'; btnRegister.click()`);
  await until(() => js(win, `!document.getElementById('app').hidden`), '가입 후 채팅 화면');

  // 2. 방 만들기
  await js(win, `btnCreate.click(); document.querySelector('#modalBody input').value=${JSON.stringify(roomName)}; modalOk.click()`);
  await until(() => js(win, `chatTitle.textContent === ${JSON.stringify(roomName)}`), '방 생성');

  // 3. 초대 → 상대 수락
  await js(win, `btnInvite.click(); document.querySelector('#modalBody input').value=${JSON.stringify(peerNick)}; modalOk.click()`);
  const { invite } = await b.next('invite');
  const { room } = await b.req('invite.accept', { inviteId: invite.id });
  await until(() => js(win, `document.querySelectorAll('#memberList li').length === 2`), '구성원 2명 표시');

  // 4. 상대의 메시지(@호출 포함) → 답글
  await b.req('msg.send', { roomId: room.id, text: `안녕하세요 @${myNick} 잘 보이나요?` });
  await until(() => js(win, `!!document.querySelector('.msg .mention')`), '호출 강조 표시');
  await js(win, `document.querySelector('.msg .replyBtn').click(); input.value='네, 잘 보입니다'; composer.requestSubmit()`);
  const reply = await b.next('msg', (e) => e.msg.text === '네, 잘 보입니다');
  assert.equal(reply.msg.replyTo.nick, peerNick);
  await until(() => js(win, `!!document.querySelector('.msg .quote')`), '답글 인용 표시');

  // 5. 파일 보내기(클라이언트 → 상대)
  await js(win, `btnAttach.click()`);
  const fileMsg = (await b.next('msg', (e) => e.msg.file)).msg;
  assert.equal(fileMsg.file.name, '보고서.bin');
  const got = [];
  b.onBinary = (data) => { got.push(data.subarray(4)); b.emit('file.ack', { transferId: data.readUInt32BE(0) }); };
  await b.req('file.request', { msgId: fileMsg.id });
  await b.next('file.end');
  assert.ok(Buffer.concat(got).equals(bigContent), '상대가 받은 파일이 원본과 같아야 함');

  // 5-2. 상대가 직접 전송(P2P)을 요청했지만 연결이 안 되는 경우 → 서버 경유로 자동 전환
  got.length = 0;
  await b.req('file.request', { msgId: fileMsg.id, p2p: true });
  await b.next('file.signal', (e) => e.data.sdp);
  await until(() => b.events.some((e) => e.t === 'file.end'), '직접 연결 실패 후 서버 경유 전송', 20000);
  assert.ok(b.events.some((e) => e.t === 'file.signal' && e.data.fallback), '전환 알림이 와야 함');
  assert.ok(Buffer.concat(got).equals(bigContent), '서버 경유로 받은 파일이 원본과 같아야 함');

  // 6. 이미지 받기(상대 → 클라이언트, 자동 수신)
  const png = nativeImage.createFromBitmap(Buffer.alloc(300 * 160 * 4, 0x90), { width: 300, height: 160 }).toPNG();
  await b.req('msg.send', { roomId: room.id, text: '사진 보냅니다', file: { fileId: `p${suffix}`, name: '풍경.png', size: png.length, mime: 'image/png' } });
  const offer = await b.next('file.offer');
  await b.req('file.accept', { transferId: offer.transferId });
  await b.next('file.go');
  const head = Buffer.alloc(4); head.writeUInt32BE(offer.transferId);
  b.ws.send(Buffer.concat([head, png]));
  await b.next('file.ack');
  b.emit('file.end', { transferId: offer.transferId });
  await until(() => js(win, `(() => { const i = document.querySelector('.file img'); return !!i && i.naturalWidth === 300; })()`), '받은 이미지 표시');
  assert.ok(fs.readFileSync(path.join(tmp, 'downloads', 'Sarangbang', '풍경.png')).equals(png), '저장된 이미지가 원본과 같아야 함');
  await shot(win, 'main.png');

  // 7. 1:1 창
  await js(win, `document.querySelector('#userList li').click()`);
  const dm = await until(() => BrowserWindow.getAllWindows().find((w) => w !== win), '1:1 창 열림');
  await until(() => js(dm, `!document.getElementById('composer').hidden`), '1:1 창 준비');
  await b.req('msg.send', { toUserId: (await b.req('users.list')).users.find((u) => u.nick === myNick).id, text: '1:1로 따로 이야기해요' });
  await until(() => js(dm, `document.querySelectorAll('.msg').length === 1`), '1:1 메시지 표시');
  await js(dm, `input.value='좋아요'; composer.requestSubmit()`);
  assert.equal((await b.next('msg', (e) => e.msg.dm && e.msg.text === '좋아요')).msg.from.nick, myNick);
  assert.equal(await js(win, `document.querySelectorAll('#messages .msg').length`), 4, '1:1 메시지는 방에 나타나지 않아야 함');
  await shot(dm, 'dm.png');

  console.log(`SMOKE_OK shots=${shots}`);
}

run().then(() => app.exit(0), (e) => { console.error('SMOKE_FAIL', e); app.exit(1); });
