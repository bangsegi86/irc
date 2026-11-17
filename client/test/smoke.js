// 클라이언트 자동 점검: 실제 서버에 붙어서 화면을 조작해 본다.
// 실행: (서버를 PORT=7171 로 켠 뒤)  npx electron test/smoke.js
const { app, dialog, BrowserWindow, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const WebSocket = require('../../server/node_modules/ws');

const URL = process.env.SB_URL || 'ws://127.0.0.1:7171';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-'));
app.setPath('userData', path.join(tmp, 'user'));
app.setPath('downloads', path.join(tmp, 'downloads'));
process.env.SARANGBANG_DATA = path.join(tmp, 'data'); // 점검 중 만든 이미지가 실제 프로그램 폴더에 쌓이지 않게
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
  let myNick = `나${suffix}`;
  const peerNick = `상대${suffix}`, roomName = `점검방${suffix}`;
  const bigFile = path.join(tmp, '보고서.bin');
  const bigContent = require('node:crypto').randomBytes(700_000);
  fs.writeFileSync(bigFile, bigContent);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [bigFile] });
  const openedUrls = [];
  shell.openExternal = async (u) => { openedUrls.push(u); }; // 점검 중에는 실제 브라우저를 열지 않는다

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

  // 4-3. 한 메시지에 서식 글자 + 코드 블록: 코드 블록은 항상 맨 위, 글은 그 아래
  step('4-3');
  assert.equal(await js(win, `document.getElementById('toolbar').firstElementChild === btnAttach`), true, '파일 첨부 버튼은 서식 줄 맨 왼쪽(굵게 앞)에 있어야 함');
  await js(win, `(() => {
    input.focus();
    document.querySelector('[data-cmd="bold"]').click();
    document.execCommand('insertText', false, '확인 부탁');
    document.querySelector('[data-cmd="bold"]').click();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'SELECT name, age\\nFROM users\\nWHERE age > 20 -- 성인만');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await until(() => js(win, `(() => { const p = input.querySelector('pre'); return !!p && input.firstChild === p && p.dataset.lang === 'sql' && !codeLang.hidden && codeLang.value === 'sql' && btnCode.textContent === '코드 밖으로' && /코드 블록 안/.test(composeHint.textContent); })()`), '코드 블록이 맨 위에 삽입 + 언어 인식 + 도구 줄 전환');
  await js(win, `(() => { btnCode.click(); document.execCommand('insertText', false, ' 결과 알려 주세요'); })()`);
  await until(() => js(win, `codeLang.hidden && btnCode.textContent.includes('코드') && composeHint.textContent === ''`), '블록 밖으로 나오면 서식 도구 줄로 복귀');
  await js(win, `composer.requestSubmit()`);
  const code = (await b.next('msg', (e) => e.msg.rich?.some((n) => n.t === 'code'))).msg;
  assert.deepEqual(code.rich, [
    { t: 'code', lang: 'sql', text: 'SELECT name, age\nFROM users\nWHERE age > 20 -- 성인만' },
    { s: '확인 부탁 결과 알려 주세요', b: 1 }, // 블록 밖으로 나오면 글의 맨 끝에서 이어 쓴다(직전 글의 서식을 잇는다)
  ]);
  assert.equal(code.text, 'SELECT name, age\nFROM users\nWHERE age > 20 -- 성인만\n확인 부탁 결과 알려 주세요');
  await until(() => js(win, `(() => { const m = [...document.querySelectorAll('.msg')].pop(); const c = m.querySelector('.code'); return !!c && !!m.querySelector('.f-b') && m.querySelector('.text').firstElementChild === c && m.querySelector('.text').textContent.includes('결과 알려 주세요') && c.querySelector('.codeHead span').textContent === 'SQL' && c.querySelectorAll('.tok-kw').length >= 3 && !!c.querySelector('.tok-com') && !input.querySelector('pre'); })()`), '코드 블록(위)과 서식 글자(아래)가 한 메시지에 표시');

  // 4-3b. 코드 블록은 하나만: 글 중간에서 눌러도 맨 위에 생기고, 다시 눌러도 늘지 않는다. 블록 안 Enter는 줄바꿈
  step('4-3b');
  const sentBefore = await js(win, `document.querySelectorAll('#messages .msg').length`);
  const typed = await js(win, `(() => {
    const key = (k, more = {}) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...more }));
    input.focus();
    document.execCommand('insertText', false, '앞글 뒷글');
    const t = input.firstChild; getSelection().collapse(t, 3);           // 글 중간에 커서
    btnCode.click();                                                       // → 블록은 맨 위에
    document.execCommand('insertText', false, 'def f(x):');
    key('Enter'); key('Tab');
    document.execCommand('insertText', false, 'return x');
    codeLang.value = 'python'; codeLang.dispatchEvent(new Event('change'));
    const first = Editor.getContent();
    btnCode.click();                                                       // 밖으로
    btnCode.click();                                                       // 다시 누르면 같은 블록으로 들어간다
    const inSame = !!input.querySelector('pre').contains(getSelection().anchorNode);
    Editor.insertCode('두 번째 블록 시도');
    btnCode.click();                                                       // 밖으로 나와서 여러 줄 코드를 붙여도 블록은 늘지 않는다
    const dt = new DataTransfer(); dt.setData('text/plain', 'SELECT 1\\nFROM dual');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    // 블록 앞에 글을 쳐도 블록이 맨 위를 지킨다
    getSelection().collapse(input, 0);
    document.execCommand('insertText', false, '맨앞');
    return { first, inSame, pres: input.querySelectorAll('pre').length, top: input.firstChild.nodeName, text: Editor.getContent().rich.filter((n) => !n.t).map((n) => n.s).join(''), code: Editor.getContent().rich.find((n) => n.t).text, order: Editor.getContent().rich.map((n) => n.t || 'text').join(',') };
  })()`);
  assert.deepEqual(typed.first, { rich: [{ t: 'code', lang: 'python', text: 'def f(x):\n  return x' }, { s: '앞글 뒷글' }] });
  assert.deepEqual([typed.inSame, typed.pres, typed.top], [true, 1, 'PRE'], '코드 블록은 하나만, 맨 위에 있어야 함');
  assert.equal(typed.order, 'code,text', '보낼 내용도 코드 → 글 순서여야 함');
  assert.ok(typed.text.includes('앞글 뒷글') && typed.text.includes('SELECT 1'), `블록 밖의 글은 블록 아래에 남아야 함: ${typed.text}`);
  assert.ok((typed.code + typed.text).includes('맨앞') && typed.code.startsWith('def f(x):') === !typed.code.startsWith('맨앞'), `맨 앞에서 친 글은 블록 위에 따로 놓이지 않아야 함: ${JSON.stringify(typed)}`);
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

  // 4-6. 서버 주소 변경: 틀린 주소면 안내 후 원래 연결 유지, 맞는 주소면 로그인 유지한 채 옮겨 붙음
  step('4-6');
  assert.deepEqual(await js(win, `['192.168.0.10', '192.168.0.10:8080', 'ws://host.example:7070/', ' WS://10.0.0.1 '].map(normalizeUrl)`),
    ['ws://192.168.0.10:7070', 'ws://192.168.0.10:8080', 'ws://host.example:7070', 'ws://10.0.0.1:7070']);
  await js(win, `btnServer.click()`);
  assert.equal(await js(win, `!modal.hidden && document.querySelector('#modalBody input').value`), URL);
  await js(win, `document.querySelector('#modalBody input').value = '127.0.0.1:1'; modalOk.click()`);
  await until(() => js(win, `/연결할 수 없습니다/.test(modalError.textContent)`), '틀린 주소 안내');
  assert.equal((await js(win, `request('users.list').then((r) => r.users.length > 0)`)), true, '틀린 주소를 넣어도 기존 연결은 유지되어야 함');
  const altUrl = URL.replace('127.0.0.1', 'localhost');
  await js(win, `document.querySelector('#modalBody input').value = ${JSON.stringify(altUrl.replace('ws://', ''))}; modalOk.click()`);
  await until(() => js(win, `modal.hidden && localStorage.getItem('sb.url') === ${JSON.stringify(altUrl)} && banner.hidden && state.ws.url.startsWith(${JSON.stringify(altUrl)})`), '새 주소로 옮겨 붙음');
  await until(() => js(win, `chatTitle.textContent === ${JSON.stringify(roomName)} && document.querySelectorAll('#messages .msg').length >= 5`), '옮긴 뒤에도 같은 방과 대화가 보임');
  assert.equal(await js(win, `state.me.nick`), myNick, '로그인이 유지되어야 함');

  // 4-7. 웹 주소는 누를 수 있는 링크로 보이고, 누르면 기본 브라우저로 연다
  step('4-7');
  await b.req('msg.send', { roomId: room.id, text: '자료는 https://example.com/docs?page=2 와 www.test.co.kr. 에 있어요 (javascript:alert(1) 은 링크 아님)' });
  await until(() => js(win, `[...document.querySelectorAll('.msg')].pop().querySelectorAll('.text a').length === 2`), '링크 2개 표시');
  assert.deepEqual(await js(win, `[...[...document.querySelectorAll('.msg')].pop().querySelectorAll('.text a')].map((a) => [a.textContent, a.getAttribute('href')])`),
    [['https://example.com/docs?page=2', 'https://example.com/docs?page=2'], ['www.test.co.kr', 'https://www.test.co.kr']]);
  await js(win, `[...document.querySelectorAll('.msg')].pop().querySelector('.text a').click()`);
  await until(() => openedUrls.length === 1, '링크를 누르면 브라우저로 열기 요청');
  assert.deepEqual(openedUrls, ['https://example.com/docs?page=2']);
  assert.ok((await js(win, `location.href`)).includes('index.html'), '프로그램 창 자체는 다른 곳으로 이동하지 않아야 함');

  // 4-8. @ 를 치면 방 구성원이 뜨고, 방향키로 고른 뒤 Enter 하면 닉네임이 들어간다(전송은 안 됨)
  step('4-8');
  const beforeMention = await js(win, `document.querySelectorAll('#messages .msg').length`);
  await js(win, `(() => { input.focus(); document.execCommand('insertText', false, '잠깐 @'); })()`);
  await until(() => js(win, `!mentionBox.hidden && document.querySelectorAll('#mentionBox .mItem').length === 1 && document.querySelector('#mentionBox .mItem.on .name').textContent === ${JSON.stringify(peerNick)}`), '호출 목록 표시(나는 빠짐)');
  await shot(win, 'mention.png');
  await js(win, `(() => { const key = (k) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); key('ArrowDown'); key('ArrowUp'); key('Enter'); })()`);
  await until(() => js(win, `mentionBox.hidden && input.textContent === ${JSON.stringify(`잠깐 @${peerNick} `)}`), '고른 닉네임이 입력됨');
  assert.equal(await js(win, `document.querySelectorAll('#messages .msg').length`), beforeMention, '목록에서 Enter는 전송이 아니라 선택이어야 함');
  await js(win, `(() => { document.execCommand('insertText', false, '@없는'); })()`);
  await until(() => js(win, `mentionBox.hidden`), '맞는 사람이 없으면 목록이 닫힘');
  await js(win, `(() => { for (let i = 0; i < 3; i++) document.execCommand('delete'); document.execCommand('insertText', false, '봐 주세요'); composer.requestSubmit(); })()`);
  assert.equal((await b.next('msg', (e) => e.msg.text.endsWith('봐 주세요'))).msg.text, `잠깐 @${peerNick} 봐 주세요`);
  assert.equal((await b.next('notice')).notice.kind, 'mention', '자동 완성으로 넣은 호출도 상대에게 알림이 가야 함');

  // 4-9. 닉네임 변경: 내 화면·상대 화면·지난 메시지에 새 이름으로 보인다
  step('4-9');
  const newNick = `새${suffix}`;
  await js(win, `btnRename.click()`);
  assert.equal(await js(win, `!modal.hidden && document.querySelector('#modalBody input').value`), myNick);
  await js(win, `document.querySelector('#modalBody input').value = ${JSON.stringify(peerNick)}; modalOk.click()`);
  await until(() => js(win, `/이미 사용 중/.test(modalError.textContent)`), '겹치는 닉네임 안내');
  await js(win, `document.querySelector('#modalBody input').value = ${JSON.stringify(newNick)}; modalOk.click()`);
  await until(() => js(win, `modal.hidden && meNick.textContent === ${JSON.stringify(newNick)} && localStorage.getItem('sb.nick') === ${JSON.stringify(newNick)}`), '내 닉네임 표시 변경');
  assert.equal((await b.next('user.update')).user.nick, newNick);
  await until(() => js(win, `[...document.querySelectorAll('#memberList li.member .name')].some((n) => n.textContent.startsWith(${JSON.stringify(newNick)})) && ![...document.querySelectorAll('.msg .nick')].some((n) => n.textContent === ${JSON.stringify(myNick)})`), '구성원 목록과 지난 메시지의 이름 변경');
  myNick = newNick;

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

  // 5-3. 이미지 붙여넣기: 입력란 위 미리보기 → 취소 → 다시 붙여넣기 → 전송(파일 전송으로 나감)
  step('5-3');
  const pasteImage = `(async () => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 80;
    const g = c.getContext('2d'); g.fillStyle = '#2a7f63'; g.fillRect(0, 0, 120, 80); g.fillStyle = '#fff'; g.fillRect(20, 20, 40, 40);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    input.focus();
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return blob.size;
  })()`;
  const beforePaste = await js(win, `document.querySelectorAll('#messages .msg').length`);
  await js(win, pasteImage);
  await until(() => js(win, `!pasteBar.hidden && document.querySelectorAll('#pasteThumbs .thumb img').length === 1 && pasteLabel.textContent.includes('1장') && !input.querySelector('img')`), '미리보기 표시(입력란에는 들어가지 않음)');
  await sleep(300);
  await shot(win, 'paste.png');
  await js(win, `btnPasteCancel.click()`);
  await until(() => js(win, `pasteBar.hidden && document.querySelectorAll('#pasteThumbs .thumb').length === 0`), '취소하면 미리보기 사라짐');
  assert.equal(await js(win, `document.querySelectorAll('#messages .msg').length`), beforePaste, '취소하면 아무것도 보내지 않아야 함');
  const pastedSize = await js(win, pasteImage);
  await until(() => js(win, `!pasteBar.hidden`), '다시 붙여넣기');
  await js(win, `btnPasteSend.click()`);
  const pastedMsg = (await b.next('msg', (e) => e.msg.file?.mime === 'image/png')).msg;
  assert.match(pastedMsg.file.name, /^붙여넣은 이미지 \d{4}-\d{2}-\d{2} \d{6}\.png$/);
  assert.equal(pastedMsg.file.size, pastedSize);
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'pasted', pastedMsg.file.name)), '붙여넣은 이미지는 프로그램 data\\pasted 폴더에 저장되어야 함');
  await until(() => js(win, `pasteBar.hidden && [...document.querySelectorAll('.file img')].some((i) => i.naturalWidth === 120)`), '보낸 이미지가 대화창에 표시, 미리보기 닫힘');
  got.length = 0;
  b.events.splice(0, b.events.length, ...b.events.filter((e) => e.t !== 'file.end')); // 앞 단계의 완료 알림 비우기
  await b.req('file.request', { msgId: pastedMsg.id });
  await b.next('file.end');
  assert.equal(Buffer.concat(got).length, pastedSize, '상대가 받은 이미지 크기가 같아야 함');
  assert.deepEqual([...Buffer.concat(got).subarray(1, 4)], [0x50, 0x4e, 0x47], 'PNG 파일이어야 함');

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
  await until(() => js(win, `[...document.querySelectorAll('.file img')].some((i) => i.naturalWidth === 300)`), '받은 이미지 표시');
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
  assert.equal(await js(win, `document.querySelectorAll('#messages .msg').length`), 10, '1:1 메시지는 방에 나타나지 않아야 함');
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
