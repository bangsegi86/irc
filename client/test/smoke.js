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

const step = (name) => { if (process.env.SB_VERBOSE) console.log(`STEP ${name}`); };
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
  step('1');
  await js(win, `fUrl.value=${JSON.stringify(URL)}; fNick.value=${JSON.stringify(myNick)}; fPass.value='pass1234'; btnRegister.click()`);
  await until(() => js(win, `!document.getElementById('app').hidden`), '가입 후 채팅 화면');

  // 2. 방 만들기
  step('2');
  await js(win, `btnCreate.click(); document.querySelector('#modalBody input').value=${JSON.stringify(roomName)}; modalOk.click()`);
  await until(() => js(win, `chatTitle.textContent === ${JSON.stringify(roomName)}`), '방 생성');

  // 3. 초대 → 상대 수락
  step('3');
  await js(win, `btnInvite.click(); document.querySelector('#modalBody input').value=${JSON.stringify(peerNick)}; modalOk.click()`);
  const { invite } = await b.next('invite');
  const { room } = await b.req('invite.accept', { inviteId: invite.id });
  await until(() => js(win, `document.querySelectorAll('#memberList li.member').length === 2`), '구성원 2명 표시');

  // 4. 상대의 메시지(@호출 포함) → 답글
  step('4');
  await b.req('msg.send', { roomId: room.id, text: `안녕하세요 @${myNick} 잘 보이나요?` });
  await until(() => js(win, `!!document.querySelector('.msg .mention')`), '호출 강조 표시');
  await until(() => js(win, `document.querySelectorAll('#noticeList .notice').length === 1`), '알림 내역에 호출 표시');
  await js(win, `document.querySelector('.msg .replyBtn').click(); input.textContent='네, 잘 보입니다'; composer.requestSubmit()`);
  const reply = await b.next('msg', (e) => e.msg.text === '네, 잘 보입니다');
  assert.equal(reply.msg.replyTo.nick, peerNick);
  await until(() => js(win, `!!document.querySelector('.msg .quote')`), '답글 인용 표시');

  // 4-2. 서식: 굵게 + 배경색 + 크기를 입혀 보내면 상대가 서식 조각으로 받는다
  step('4-2');
  await js(win, `(() => {
    input.focus();
    document.execCommand('insertText', false, '보통 ');
    document.querySelector('[data-cmd="bold"]').click();
    document.execCommand('insertText', false, '굵게');
    document.querySelector('[data-cmd="bold"]').click();
    document.execCommand('insertText', false, ' 색칠');
    const sel = getSelection(); sel.modify('extend', 'backward', 'word');
    document.querySelector('[data-bg="yellow"]').click();
    document.querySelector('[data-size="s"]').click();
    document.querySelector('[data-size="s"]').click(); // 같은 크기를 다시 누르면 보통으로
    document.querySelector('[data-size="l"]').click();
    document.querySelector('[data-cmd="strikeThrough"]').click();
    document.querySelector('[data-cmd="underline"]').click();
    composer.requestSubmit();
  })()`);
  const fancy = (await b.next('msg', (e) => e.msg.rich)).msg;
  assert.equal(fancy.text, '보통 굵게 색칠');
  assert.deepEqual(fancy.rich.find((r) => r.s === '굵게'), { s: '굵게', b: 1 });
  assert.deepEqual(fancy.rich.find((r) => r.s.includes('색칠')), { s: '색칠', bg: 'yellow', sz: 'l', x: 1, u: 1 });
  await until(() => js(win, `!!document.querySelector('.msg .f-b') && !!document.querySelector('.msg .bg-yellow.sz-l.f-x.f-u') && input.textContent === ''`), '보낸 서식 메시지 표시, 입력란 비워짐');

  // 4-3. 한 메시지에 서식 글자 + 코드 블록: 굵은 글자 → 여러 줄 쿼리 붙여넣기(코드 블록 자동 삽입, SQL 인식) → 블록 밖에서 글 이어 쓰기
  step('4-3');
  await js(win, `(() => {
    input.focus();
    document.querySelector('[data-cmd="bold"]').click();
    document.execCommand('insertText', false, '확인 부탁');
    document.querySelector('[data-cmd="bold"]').click();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'SELECT name, age\\nFROM users\\nWHERE age > 20 -- 성인만');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await until(() => js(win, `(() => { const p = input.querySelector('pre'); return !!p && p.dataset.lang === 'sql' && !codeLang.hidden && codeLang.value === 'sql' && btnCode.textContent === '코드 밖으로' && /코드 블록 안/.test(composeHint.textContent); })()`), '코드 블록 삽입 + 언어 인식 + 도구 줄 전환');
  await js(win, `(() => { btnCode.click(); document.execCommand('insertText', false, '결과 알려 주세요'); })()`);
  await until(() => js(win, `codeLang.hidden && btnCode.textContent.includes('코드') && composeHint.textContent === ''`), '블록 밖으로 나오면 서식 도구 줄로 복귀');
  await js(win, `composer.requestSubmit()`);
  const code = (await b.next('msg', (e) => e.msg.rich?.some((n) => n.t === 'code'))).msg;
  assert.deepEqual(code.rich, [
    { s: '확인 부탁', b: 1 },
    { t: 'code', lang: 'sql', text: 'SELECT name, age\nFROM users\nWHERE age > 20 -- 성인만' },
    { s: '결과 알려 주세요' },
  ]);
  assert.equal(code.text, '확인 부탁\nSELECT name, age\nFROM users\nWHERE age > 20 -- 성인만\n결과 알려 주세요');
  await until(() => js(win, `(() => { const m = [...document.querySelectorAll('.msg')].pop(); const c = m.querySelector('.code'); return !!c && !!m.querySelector('.f-b') && m.querySelector('.text').textContent.includes('결과 알려 주세요') && c.querySelector('.codeHead span').textContent === 'SQL' && c.querySelectorAll('.tok-kw').length >= 3 && !!c.querySelector('.tok-com') && !input.querySelector('pre'); })()`), '서식 글자와 코드 블록이 한 메시지에 표시');

  // 4-3b. 코드 블록 안에서 Enter는 줄바꿈(전송 안 됨), Tab은 들여쓰기, 언어 직접 선택, 글 중간에 블록 넣기
  step('4-3b');
  const sentBefore = await js(win, `document.querySelectorAll('#messages .msg').length`);
  const typed = await js(win, `(() => {
    const key = (k, more = {}) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...more }));
    input.focus();
    document.execCommand('insertText', false, '앞글 뒷글');
    const t = input.firstChild; getSelection().collapse(t, 3);           // '앞글 ' 뒤에 커서
    document.querySelector('#btnCode').click();                            // 글 중간에 블록
    document.execCommand('insertText', false, 'def f(x):');
    key('Enter'); key('Tab');
    document.execCommand('insertText', false, 'return x');
    codeLang.value = 'python'; codeLang.dispatchEvent(new Event('change'));
    return Editor.getContent();
  })()`);
  assert.deepEqual(typed, { rich: [{ s: '앞글 ' }, { t: 'code', lang: 'python', text: 'def f(x):\n  return x' }, { s: '뒷글' }] });
  assert.equal(await js(win, `document.querySelectorAll('#messages .msg').length`), sentBefore, '코드 블록 안의 Enter는 전송하지 않아야 함');
  await shot(win, 'rich-edit.png');
  // 빈 블록에서 Backspace → 블록 삭제, 서식 없는 글만 남으면 일반 메시지
  assert.deepEqual(await js(win, `(() => {
    Editor.clear(); input.focus();
    document.execCommand('insertText', false, '글만 남김');
    Editor.insertCode();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    const r = [!!input.querySelector('pre'), Editor.getContent()];
    Editor.clear();
    return r;
  })()`), [false, { text: '글만 남김' }]);

  // 4-4. 상대가 보낸 서식은 글자로만 표시된다(태그가 실행되지 않음)
  step('4-4');
  await b.req('msg.send', { roomId: room.id, rich: [{ s: '<img src=x onerror=window.hacked=1> 위험해 보이는 글자', b: 1 }, { t: 'code', lang: 'json', text: '{"a": 1, "ok": true}' }] });
  await until(() => js(win, `[...document.querySelectorAll('.msg .f-b')].some((n) => n.textContent.startsWith('<img'))`), '태그가 글자로 표시');
  assert.equal(await js(win, `document.querySelectorAll('#messages img').length + (window.hacked ? 100 : 0)`), 0, '태그가 실행되면 안 됨');
  await until(() => js(win, `!!document.querySelector('.msg .code .tok-key')`), 'JSON 색 입힘');
  assert.equal(await js(win, `document.querySelectorAll('#toolbar [data-size].on').length`), 0, '빈 입력란에서는 크기 버튼이 눌린 상태가 아니어야 함');
  // 4-5. 화면 밝기: 어둡게/밝게 전환이 모든 창에 적용되고, 다시 켜도 유지되도록 저장된다
  step('4-5');
  for (const [theme, bg] of [['dark', 'rgb(39, 42, 49)'], ['light', 'rgb(255, 255, 255)']]) {
    assert.equal(await js(win, `window.api.setTheme('${theme}')`), theme);
    await until(() => js(win, `getComputedStyle(document.body).backgroundColor === '${bg}'`), `${theme} 모드 색 적용`);
    await sleep(150);
    await shot(win, `theme-${theme}.png`);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'user', 'settings.json'), 'utf8')).theme, 'light');
  await js(win, `btnTheme.click()`);
  await until(() => js(win, `btnTheme.textContent === '어둡게'`), '밝기 버튼으로 전환');
  await shot(win, 'rich.png');

  // 5. 파일 보내기(클라이언트 → 상대)
  step('5');
  await js(win, `btnAttach.click()`);
  const fileMsg = (await b.next('msg', (e) => e.msg.file)).msg;
  assert.equal(fileMsg.file.name, '보고서.bin');
  const got = [];
  b.onBinary = (data) => { got.push(data.subarray(4)); b.emit('file.ack', { transferId: data.readUInt32BE(0) }); };
  await b.req('file.request', { msgId: fileMsg.id });
  await b.next('file.end');
  assert.ok(Buffer.concat(got).equals(bigContent), '상대가 받은 파일이 원본과 같아야 함');

  // 5-2. 상대가 직접 전송(P2P)을 요청했지만 연결이 안 되는 경우 → 서버 경유로 자동 전환
  step('5-2');
  got.length = 0;
  await b.req('file.request', { msgId: fileMsg.id, p2p: true });
  await b.next('file.signal', (e) => e.data.sdp);
  await until(() => b.events.some((e) => e.t === 'file.end'), '직접 연결 실패 후 서버 경유 전송', 20000);
  assert.ok(b.events.some((e) => e.t === 'file.signal' && e.data.fallback), '전환 알림이 와야 함');
  assert.ok(Buffer.concat(got).equals(bigContent), '서버 경유로 받은 파일이 원본과 같아야 함');

  // 6. 이미지 받기(상대 → 클라이언트, 자동 수신)
  step('6');
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
  step('7');
  await js(win, `document.querySelector('#userList li').click()`);
  const dm = await until(() => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('dm=')), '1:1 창 열림');
  await until(() => js(dm, `!document.getElementById('composer').hidden`), '1:1 창 준비');
  await b.req('msg.send', { toUserId: (await b.req('users.list')).users.find((u) => u.nick === myNick).id, text: '1:1로 따로 이야기해요' });
  await until(() => js(dm, `document.querySelectorAll('.msg').length === 1`), '1:1 메시지 표시');
  await js(dm, `input.textContent='좋아요'; composer.requestSubmit()`);
  assert.equal((await b.next('msg', (e) => e.msg.dm && e.msg.text === '좋아요')).msg.from.nick, myNick);
  assert.equal(await js(win, `document.querySelectorAll('#messages .msg').length`), 7, '1:1 메시지는 방에 나타나지 않아야 함');
  await shot(dm, 'dm.png');

  // 8. 창 닫기 → 트레이, 호출 → 우측 하단 팝업 → 팝업을 누르면 해당 방으로 이동
  step('8');
  dm.destroy();
  await js(win, `(() => { state.current = null; showNoRoom(); })()`); // 다른 화면을 보던 상황
  win.close();
  await until(() => !win.isDestroyed() && !win.isVisible(), '닫으면 숨겨짐(종료되지 않음)');
  await sleep(300);
  await b.req('msg.send', { roomId: room.id, text: `@${myNick} 자리에 계신가요? 급한 일입니다` });
  const findToast = (text) => BrowserWindow.getAllWindows().find((w) => { const u = decodeURIComponent(w.webContents.getURL()).replace(/\+/g, ' '); return u.includes('toast.html') && u.includes(text); });
  const toast = await until(() => findToast('급한 일'), '알림 팝업');
  await until(() => js(toast, `document.getElementById('toast').classList.contains('in')`), '팝업 올라옴');
  assert.match(await js(toast, `document.getElementById('body').textContent`), /급한 일입니다/);
  const { workArea } = require('electron').screen.getPrimaryDisplay();
  const tb = toast.getBounds();
  assert.ok(tb.x + tb.width <= workArea.x + workArea.width && tb.y + tb.height === workArea.y + workArea.height, '팝업은 화면 우측 하단에 있어야 함');
  await sleep(450);
  await shot(toast, 'toast.png');
  js(toast, `document.getElementById('toast').click()`).catch(() => {}); // 누르면 팝업 창이 바로 닫히므로 결과를 기다리지 않는다
  await until(() => win.isVisible(), '팝업을 누르면 창이 다시 열림');
  await until(() => js(win, `chatTitle.textContent === ${JSON.stringify(roomName)}`), '호출된 방으로 이동');
  await until(() => js(win, `document.querySelectorAll('#noticeList .notice').length === 1`), '이동한 알림은 내역에서 빠짐(처음 호출 1건만 남음)');
  await until(() => js(win, `[...document.querySelectorAll('.msg .text')].some((n) => n.textContent.includes('급한 일'))`), '이동한 방에 호출 메시지 표시');
  await shot(win, 'main.png');

  // 9. 팝업은 5초 뒤 스스로 사라진다
  step('9');
  win.hide();
  await b.req('call', { userId: (await b.req('users.list')).users.find((u) => u.nick === myNick).id, roomId: room.id });
  const t0 = Date.now();
  const toast2 = await until(() => findToast('방에서 찾고'), '두 번째 팝업');
  await until(() => toast2.isDestroyed(), '팝업 자동 사라짐', 9000);
  const shown = Date.now() - t0;
  assert.ok(shown > 5000 && shown < 7500, `팝업 표시 시간이 5초 남짓이어야 함 (${shown}ms)`);
  win.show();
  await js(win, `document.querySelector('#noticeList .notice').click()`);
  await until(() => js(win, `document.querySelectorAll('#noticeList .notice').length === 1`), '알림을 누르면 내역에서 빠짐');
  await js(win, `btnNoticeClear.click()`);
  await until(() => js(win, `document.querySelector('#noticeList .none') && btnNoticeClear.hidden`), '모두 지우기');

  console.log(`SMOKE_OK shots=${shots}`);
}

run().then(() => app.exit(0), (e) => { console.error('SMOKE_FAIL', e); app.exit(1); });
