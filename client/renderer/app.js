// 사랑방 클라이언트 화면. 주 창과 1:1 창이 같은 코드를 쓴다(?dm=상대ID 이면 1:1 창).
'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DM_MODE = params.has('dm');
const CHUNK = 256 * 1024;
const AUTO_IMAGE_MAX = 20 * 1024 * 1024; // 이 크기 이하 이미지는 자동으로 받는다
const PAGE = 50;
const DC_CHUNK = 64 * 1024;          // 직접 전송 한 조각
const DC_HIGH = 4 * 1024 * 1024;     // 이만큼 쌓이면 잠시 멈춘다
const P2P_TIMEOUT = 8000;            // 이 시간 안에 직접 연결이 안 되면 서버 경유로 바꾼다
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const state = {
  me: null, ws: null, nextId: 1, pending: new Map(),
  rooms: new Map(), users: new Map(), invites: [],
  notices: [],              // 나를 호출한 내역(최신순). 서버에 저장되어 꺼져 있던 동안의 호출도 보인다
  current: null,            // { type: 'room' | 'dm', id, nick? }
  unread: new Map(),        // 'room:1' | 'dm:2' -> 개수
  replyTo: null, oldestId: null,
  pasted: [],               // 붙여넣고 아직 보내지 않은 이미지: { file, url }
  incoming: new Map(),      // 받는 중인 전송
  outgoing: new Map(),      // 보내는 중인 전송
  fileBoxes: new Map(),     // 메시지 ID -> 파일 표시 상자
  reconnectTimer: null, loggedIn: false,
  stats: { p2p: 0, relay: 0 },  // 받은 파일 수(전송 방식별)
};

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}
// 선으로 그린 아이콘(고정된 그림만 넣는다 — 사용자 입력은 여기로 오지 않는다)
const ICONS = {
  hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>',
  reply: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5.5-5 4 3.5 2.5-2L20 18"/>',
};
function icon(name, size = 18) {
  const span = el('span', { className: 'ic' });
  span.innerHTML = `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}
// 이름 첫 글자를 넣은 동그란 프로필. 색은 사용자마다 고정
const AVATAR_COLORS = ['#3b6fb5', '#a8562b', '#7a56b8', '#2a7f63', '#a8437a', '#74661c'];
function avatar(user, size = 38) {
  const node = el('div', { className: 'av' }, [...user.nick][0] || '?');
  node.setAttribute('aria-hidden', 'true');
  Object.assign(node.style, { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, background: AVATAR_COLORS[user.id % AVATAR_COLORS.length] });
  return node;
}
const fmtClock = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmtTime = (ts) => new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const keyOf = (c) => `${c.type}:${c.id}`;
const peerOf = (msg) => (msg.dm[0] === state.me.id ? msg.dm[1] : msg.dm[0]);

// ---------------- 서버 연결 ----------------
function connect(url) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); } catch { return reject(new Error('서버 주소 형식이 올바르지 않습니다. 예: ws://192.168.0.10:7070')); }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { state.ws = ws; resolve(); };
    ws.onerror = () => reject(new Error('서버에 연결할 수 없습니다. 주소와 서버 실행 여부를 확인해 주세요.'));
    ws.onmessage = (e) => (typeof e.data === 'string' ? onJson(JSON.parse(e.data)) : onBinary(e.data));
    ws.onclose = () => { if (state.ws === ws) onDisconnect(); };
  });
}

function request(t, body = {}) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== 1) return reject(new Error('서버와 연결되어 있지 않습니다.'));
    const id = state.nextId++;
    state.pending.set(id, { resolve, reject });
    state.ws.send(JSON.stringify({ t, id, ...body }));
  });
}
const emit = (t, body = {}) => { if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ t, ...body })); };

function onDisconnect() {
  for (const p of state.pending.values()) p.reject(new Error('서버와 연결이 끊어졌습니다.'));
  state.pending.clear();
  for (const [id, tr] of state.incoming) failIncoming(id, '연결이 끊어졌습니다.');
  for (const out of state.outgoing.values()) abortOutgoing(out);
  state.outgoing.clear();
  if (!state.loggedIn) return;
  $('banner').hidden = false;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(reconnect, 3000);
}

async function reconnect() {
  if (!state.loggedIn) return;
  try {
    await connect(localStorage.getItem('sb.url'));
    await enter(await request('login', { token: localStorage.getItem('sb.token') }));
  } catch (e) {
    if (e.code === 'bad_token') return logout();
    state.reconnectTimer = setTimeout(reconnect, 3000);
  }
}

// ---------------- 로그인 ----------------
async function doLogin(kind) {
  $('loginError').textContent = '';
  const url = $('fUrl').value.trim();
  try {
    await connect(url);
    const body = { nick: $('fNick').value.trim(), password: $('fPass').value, serverPassword: $('fServerPass').value };
    const session = await request(kind, body);
    localStorage.setItem('sb.url', url);
    localStorage.setItem('sb.token', session.token);
    localStorage.setItem('sb.nick', session.user.nick);
    await enter(session);
  } catch (e) {
    $('loginError').textContent = e.message;
    state.ws?.close();
  }
}

function logout() {
  state.loggedIn = false;
  clearTimeout(state.reconnectTimer);
  localStorage.removeItem('sb.token');
  state.ws?.close();
  if (DM_MODE) return window.close();
  $('app').hidden = true;
  $('login').hidden = false;
}

async function enter(session) {
  state.loggedIn = true;
  state.me = session.user;
  state.rooms = new Map(session.rooms.map((r) => [r.id, r]));
  state.invites = session.invites;
  state.notices = session.notices || [];
  const { users } = await request('users.list');
  state.users = new Map(users.map((u) => [u.id, u]));
  $('login').hidden = true;
  $('app').hidden = false;
  $('banner').hidden = true;
  $('meNick').textContent = state.me.nick;

  if (DM_MODE) {
    await openView({ type: 'dm', id: Number(params.get('dm')), nick: params.get('nick') });
  } else {
    renderSidebar();
    const cur = state.current && state.rooms.has(state.current.id) ? state.current : null;
    if (cur) await openView(cur);
    else if (state.rooms.size) await openView({ type: 'room', id: state.rooms.keys().next().value });
    else showNoRoom();
  }
}

// ---------------- 서버에서 오는 알림 ----------------
function onJson(m) {
  if (m.t === 'ok' || m.t === 'err') {
    const p = state.pending.get(m.id);
    if (!p) return;
    state.pending.delete(m.id);
    return m.t === 'ok' ? p.resolve(m) : p.reject(Object.assign(new Error(m.message), { code: m.code }));
  }
  if (!state.me) return;
  switch (m.t) {
    case 'msg': return onMessage(m.msg);
    case 'presence': {
      const u = state.users.get(m.userId) || { id: m.userId, nick: m.nick };
      u.online = m.online;
      state.users.set(u.id, u);
      for (const r of state.rooms.values()) for (const mem of r.members) if (mem.id === u.id) mem.online = m.online;
      if (!DM_MODE) { renderSidebar(); renderMembers(); }
      return;
    }
    case 'file.offer': return onFileOffer(m);
    case 'file.go': return m.p2p && window.RTCPeerConnection ? sendFileP2P(m.transferId) : sendFile(m.transferId);
    case 'file.signal': return onFileSignal(m);
    case 'file.ack': return state.outgoing.get(m.transferId)?.onAck?.();
    case 'file.end': return finishIncoming(m.transferId);
    case 'file.fail': {
      const out = state.outgoing.get(m.transferId);
      if (out) { abortOutgoing(out); state.outgoing.delete(m.transferId); }
      return failIncoming(m.transferId, m.reason);
    }
  }
  if (DM_MODE) return; // 아래는 주 창에서만 처리
  switch (m.t) {
    case 'room.update':
      state.rooms.set(m.room.id, m.room);
      renderSidebar();
      if (state.current?.type === 'room' && state.current.id === m.room.id) renderMembers();
      else if (!state.current) openView({ type: 'room', id: m.room.id });
      return;
    case 'room.left':
      state.rooms.delete(m.roomId);
      if (state.current?.type === 'room' && state.current.id === m.roomId) showNoRoom();
      return renderSidebar();
    case 'invite':
      if (!state.invites.some((i) => i.id === m.invite.id)) state.invites.push(m.invite);
      window.api.notify('채팅방 초대', `${m.invite.from} 님이 '${m.invite.roomName}' 방에 초대했습니다.`);
      return renderSidebar();
    case 'notice': { // 누군가 나를 호출함
      const n = m.notice;
      state.notices.unshift(n);
      renderSidebar();
      window.api.notify(`${n.from.nick} 님이 호출했습니다${n.roomName ? ` · ${n.roomName}` : ''}`, noticeText(n), { onlyIfAway: true, noticeId: n.id });
      if (n.msgId && state.current?.type === 'room' && state.current.id === n.roomId) flashMessage(n.msgId);
      return;
    }
  }
}

function onMessage(msg) {
  const mine = msg.from.id === state.me.id;
  const view = msg.roomId != null ? { type: 'room', id: msg.roomId } : { type: 'dm', id: peerOf(msg) };
  const visible = state.current && keyOf(state.current) === keyOf(view);
  if (visible) { appendMessage(msg); scrollToBottom(); }
  if (DM_MODE || mine) return;
  if (view.type === 'dm') {
    const preview = msg.text || `[파일] ${msg.file?.name}`;
    window.api.dmIncoming(view.id, msg.from.nick, preview.slice(0, 100)).then((opened) => {
      if (!opened) { bump(view); renderSidebar(); }
    });
  } else if (!visible) { bump(view); renderSidebar(); }
}
const bump = (view) => state.unread.set(keyOf(view), (state.unread.get(keyOf(view)) || 0) + 1);

// ---------------- 옆 목록 ----------------
const noticeText = (n) => (n.kind === 'mention' ? n.text : n.roomName ? '방에서 찾고 있어요.' : '1:1 대화에서 찾고 있어요.');

// 알림을 누르면 해당 방(또는 1:1 창)으로 이동하고 그 알림은 내역에서 지운다
async function gotoNotice(n) {
  state.notices = state.notices.filter((x) => x.id !== n.id);
  request('notice.clear', { noticeId: n.id }).catch(() => {});
  renderSidebar();
  if (n.roomId == null) return openDm(n.from);
  if (!state.rooms.has(n.roomId)) return window.api.notify('이동할 수 없습니다', '이미 나간 방의 알림입니다.');
  await openView({ type: 'room', id: n.roomId });
  if (n.msgId) flashMessage(n.msgId);
}

function clearNotices() {
  state.notices = [];
  request('notice.clear').catch(() => {});
  renderSidebar();
}

function renderSidebar() {
  $('meAvatar').replaceChildren(avatar(state.me, 32));
  $('noticeCount').hidden = $('btnNoticeClear').hidden = !state.notices.length;
  $('noticeCount').textContent = String(state.notices.length);
  $('noticeList').replaceChildren(...(state.notices.length ? state.notices.map((n) => el('li', { className: 'notice', title: '눌러서 이동', onclick: () => gotoNotice(n) },
    el('span', { className: 'nIcon' }, icon('bell')),
    el('div', { className: 'nBody' },
      el('div', { className: 'who' }, `${n.from.nick}${n.roomName ? ` · ${n.roomName}` : ''}`),
      el('div', { className: 'what' }, noticeText(n)),
      el('div', { className: 'when' }, fmtTime(n.ts))))) : [el('li', { className: 'none' }, '새 알림이 없습니다.')]));

  $('invites').replaceChildren(...state.invites.map((inv) => el('div', { className: 'invite' },
    el('div', {}, `${inv.from} 님이 '${inv.roomName}' 방에 초대했습니다.`),
    el('div', { className: 'row' },
      el('button', { className: 'primary', onclick: () => answerInvite(inv, true) }, '들어가기'),
      el('button', { onclick: () => answerInvite(inv, false) }, '거절')))));

  $('roomList').replaceChildren(...[...state.rooms.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((r) => {
    const n = state.unread.get(`room:${r.id}`);
    const active = state.current?.type === 'room' && state.current.id === r.id;
    return el('li', { className: `${active ? 'active' : ''} ${n ? 'unread' : ''}`, title: r.isPublic ? '공개 방' : '비공개 방', onclick: () => openView({ type: 'room', id: r.id }) },
      icon(r.isPublic ? 'hash' : 'lock'), el('span', { className: 'name' }, r.name), n ? el('span', { className: 'badge' }, String(n)) : null);
  }));

  const others = [...state.users.values()].filter((u) => u.id !== state.me.id)
    .sort((a, b) => (b.online - a.online) || a.nick.localeCompare(b.nick, 'ko'));
  $('userList').replaceChildren(...others.map((u) => {
    const n = state.unread.get(`dm:${u.id}`);
    return el('li', { className: `${u.online ? 'online' : ''} ${n ? 'unread' : ''}`, onclick: () => openDm(u) },
      avatar(u, 28), el('span', { className: 'name' }, u.nick), n ? el('span', { className: 'badge' }, String(n)) : null, el('span', { className: `dot ${u.online ? 'on' : ''}`, title: u.online ? '접속 중' : '자리 비움' }));
  }));
}

function openDm(u) {
  state.unread.delete(`dm:${u.id}`);
  renderSidebar();
  window.api.openDm(u.id, u.nick);
}

async function answerInvite(inv, accept) {
  try {
    const r = await request(accept ? 'invite.accept' : 'invite.decline', { inviteId: inv.id });
    if (accept) { state.rooms.set(r.room.id, r.room); openView({ type: 'room', id: r.room.id }); }
  } catch (e) { window.api.notify('초대 처리 실패', e.message); }
  state.invites = state.invites.filter((i) => i.id !== inv.id);
  renderSidebar();
}

function renderMembers() {
  const room = state.current?.type === 'room' ? state.rooms.get(state.current.id) : null;
  $('members').hidden = !room;
  if (!room) return;
  $('chatSub').textContent = `구성원 ${room.members.length}명`;
  const row = (m) => el('li', { className: `member ${m.online ? 'online' : ''}` },
    avatar(m, 30),
    el('span', { className: 'name' }, m.nick, m.id === room.ownerId ? el('small', {}, ' 방장') : null),
    m.id !== state.me.id ? el('button', { className: 'ghost iconBtn', title: '호출', ariaLabel: `${m.nick} 호출`, onclick: () => callUser(m, room) }, icon('bell', 16)) : null,
    m.id !== state.me.id ? el('button', { className: 'ghost iconBtn', title: '1:1 대화', ariaLabel: `${m.nick} 님과 1:1 대화`, onclick: () => openDm(m) }, icon('chat', 16)) : null);
  const on = room.members.filter((m) => m.online), off = room.members.filter((m) => !m.online);
  $('memberList').replaceChildren(
    ...(on.length ? [el('li', { className: 'group' }, `접속 중 — ${on.length}`), ...on.map(row)] : []),
    ...(off.length ? [el('li', { className: 'group' }, `자리 비움 — ${off.length}`), ...off.map(row)] : []));
}

async function callUser(m, room) {
  try {
    const { online } = await request('call', { userId: m.id, roomId: room.id });
    window.api.notify(`${m.nick} 님을 호출했습니다`, online ? '상대 화면에 알림이 떴습니다.' : '지금은 접속 중이 아닙니다. 다음에 접속하면 알림 내역에 나타납니다.');
  } catch (e) { window.api.notify('호출 실패', e.message); }
}

// ---------------- 대화 화면 ----------------
function showNoRoom() {
  state.current = null;
  $('chatTitle').textContent = '방을 선택하세요';
  $('chatSub').textContent = '';
  $('chatIcon').replaceChildren();
  $('btnInvite').hidden = $('btnLeave').hidden = $('composer').hidden = true;
  $('members').hidden = true;
  $('messages').replaceChildren(el('p', { className: 'empty' }, "참여 중인 방이 없습니다. 왼쪽의 '＋'로 방을 만들거나 '찾기'로 공개 방에 들어가 보세요."));
}

async function openView(view) {
  state.current = view;
  state.unread.delete(keyOf(view));
  state.fileBoxes.clear();
  setReply(null);
  clearPasted(); // 다른 방으로 잘못 보내지 않도록 비운다
  const isRoom = view.type === 'room';
  $('chatTitle').textContent = isRoom ? state.rooms.get(view.id)?.name ?? '' : `${view.nick} 님과 1:1 대화`;
  $('chatSub').textContent = '';
  $('chatIcon').replaceChildren(icon(isRoom ? (state.rooms.get(view.id)?.isPublic ? 'hash' : 'lock') : 'user'));
  if (DM_MODE) document.title = `${view.nick} — 1:1 대화`;
  $('btnInvite').hidden = $('btnLeave').hidden = !isRoom;
  $('composer').hidden = false;
  if (!DM_MODE) { renderSidebar(); renderMembers(); }
  $('messages').replaceChildren();
  state.oldestId = null;
  await loadHistory();
  scrollToBottom();
  Editor.focus();
}

async function loadHistory() {
  const view = state.current;
  const body = view.type === 'room' ? { roomId: view.id } : { peerId: view.id };
  let res;
  try { res = await request('history', { ...body, limit: PAGE, before: state.oldestId || undefined }); }
  catch { return; }
  if (state.current !== view) return;
  const box = $('messages');
  box.querySelector('.more')?.remove();
  const before = box.scrollHeight;
  box.prepend(...res.messages.map(buildMessage));
  if (res.messages.length) state.oldestId = res.messages[0].id;
  if (res.messages.length === PAGE) {
    box.prepend(el('p', { className: 'empty more' }, el('button', { onclick: loadHistory }, '이전 대화 더 보기')));
  }
  fixDays();
  box.scrollTop += box.scrollHeight - before;
}

const scrollToBottom = () => { $('messages').scrollTop = $('messages').scrollHeight; };
const appendMessage = (msg) => { $('messages').append(buildMessage(msg)); fixDays(); };

// 날짜가 바뀌는 자리에 날짜 구분선을 다시 놓는다
function fixDays() {
  const box = $('messages');
  box.querySelectorAll('.day').forEach((n) => n.remove());
  let last = null;
  for (const m of box.querySelectorAll('.msg')) {
    const d = new Date(Number(m.dataset.ts));
    if (d.toDateString() !== last) {
      last = d.toDateString();
      m.before(el('div', { className: 'day' }, d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })));
    }
  }
}

function flashMessage(id) {
  const node = document.querySelector(`[data-msg="${id}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1500);
}

function textNodes(text) {
  // @닉네임을 강조한다. 사용자 입력은 항상 글자로만 넣는다(HTML로 해석하지 않음).
  return text.split(/(@[^\s@]{2,20})/gu).map((part) => (part.startsWith('@') && part.length > 2 ? el('span', { className: 'mention' }, part) : part));
}

function buildMessage(msg) {
  const mine = msg.from.id === state.me.id;
  const called = !mine && (msg.text || '').toLowerCase().split(/[\s]+/).some((w) => w.startsWith(`@${state.me.nick.toLowerCase()}`));
  const node = el('div', { className: `msg ${mine ? 'mine' : ''} ${called ? 'called' : ''}` });
  node.dataset.msg = msg.id;
  node.dataset.ts = msg.ts;
  const body = el('div', { className: 'body' });
  body.append(el('div', { className: 'head' }, el('span', { className: 'nick' }, msg.from.nick), el('span', { className: 'time', title: fmtTime(msg.ts) }, fmtClock(msg.ts))));
  if (msg.replyTo) {
    body.append(el('div', { className: 'quote', title: '원문으로 이동', onclick: () => flashMessage(msg.replyTo.id) }, icon('reply', 14), el('span', { className: 'qt' }, el('b', {}, msg.replyTo.nick), ` ${msg.replyTo.text}`)));
  }
  if (msg.rich) body.append(Editor.renderRich(msg.rich, textNodes));
  else if (msg.text) body.append(el('div', { className: 'text' }, ...textNodes(msg.text)));
  if (msg.file) {
    const box = el('div', { className: 'file' });
    state.fileBoxes.set(msg.id, box);
    body.append(box);
    renderFile(msg, box, true);
  }
  node.append(avatar(msg.from), body, el('button', { className: 'replyBtn', onclick: () => setReply(msg) }, '답글'));
  return node;
}

function setReply(msg) {
  state.replyTo = msg;
  $('replyBar').hidden = !msg;
  if (msg) {
    $('replyText').textContent = `↪ ${msg.from.nick} 님에게 답글: ${(msg.text || `[파일] ${msg.file?.name}`).slice(0, 80)}`;
    Editor.focus();
  }
}

async function sendText() {
  if (state.pasted.length) await sendPasted(); // 미리보기 중인 이미지가 있으면 함께 보낸다
  const content = Editor.getContent(); // { text } 또는 { rich }
  if (!content || !state.current) return;
  try {
    await sendMessage(content);
    Editor.clear();
    Editor.focus();
  } catch (e) { window.api.notify('전송 실패', e.message); }
}

async function sendMessage(body) {
  const view = state.current;
  const target = view.type === 'room' ? { roomId: view.id } : { toUserId: view.id };
  await request('msg.send', { ...target, ...body, replyTo: state.replyTo?.id });
  setReply(null);
}

async function sendFiles(files) {
  for (const file of files) {
    if (!file) continue;
    try { await sendMessage({ file }); }
    catch (e) { window.api.notify('파일 전송 실패', e.message); }
  }
}

// ---------------- 붙여넣은 이미지: 입력란 위 미리보기 → 전송 / 취소 ----------------
function addPasted(files) {
  for (const file of files) state.pasted.push({ file, url: URL.createObjectURL(file) });
  renderPasted();
  Editor.focus();
}

function removePasted(item) {
  URL.revokeObjectURL(item.url);
  state.pasted = state.pasted.filter((p) => p !== item);
  renderPasted();
}

function clearPasted() {
  for (const p of state.pasted) URL.revokeObjectURL(p.url);
  state.pasted = [];
  renderPasted();
}

function renderPasted() {
  $('pasteBar').hidden = !state.pasted.length;
  $('pasteLabel').textContent = `이미지 ${state.pasted.length}장을 보낼까요?`;
  $('pasteThumbs').replaceChildren(...state.pasted.map((p) => el('div', { className: 'thumb' },
    el('img', { src: p.url, alt: '붙여넣은 이미지 미리보기' }),
    el('button', { type: 'button', title: '이 이미지 빼기', ariaLabel: '이 이미지 빼기', onclick: () => removePasted(p) }, '✕'))));
}

async function sendPasted() {
  const items = state.pasted;
  state.pasted = []; // 두 번 눌러도 한 번만 보낸다
  renderPasted();
  for (const { file, url } of items) {
    try {
      // 탐색기에서 복사한 파일은 그 파일을 그대로, 캡처 화면처럼 파일이 없는 이미지는 이 PC에 저장한 뒤 보낸다
      const meta = window.api.pathOf(file) ? await window.api.registerDropped(file) : await window.api.savePasted(new Uint8Array(await file.arrayBuffer()), file.type);
      if (!meta) throw new Error('이미지를 저장하지 못했습니다. (지원 형식: PNG, JPG, GIF, WEBP, BMP · 50MB 이하)');
      await sendMessage({ file: meta });
    } catch (e) { window.api.notify('이미지 전송 실패', e.message); }
    URL.revokeObjectURL(url);
  }
  Editor.focus();
}

// ---------------- 파일: 표시 ----------------
async function renderFile(msg, box, allowAuto) {
  const f = msg.file;
  const mine = msg.from.id === state.me.id;
  const isImage = f.mime.startsWith('image/');
  const local = await window.api.localFile(f.fileId);
  const label = el('div', { className: 'fname' }, icon(isImage ? 'image' : 'file', 20), el('span', {}, f.name), el('small', {}, fmtSize(f.size)));
  const status = el('div', { className: 'status' });

  if (local) {
    const open = () => window.api.openFile(f.fileId);
    box.replaceChildren(label);
    if (isImage) box.append(el('img', { src: local.url, alt: f.name, title: '눌러서 열기', onclick: open, onload: keepBottom }));
    box.append(el('div', { className: 'row' }, el('button', { onclick: open }, '열기'), el('button', { onclick: () => window.api.showFile(f.fileId) }, '폴더 보기')));
    return;
  }
  if (mine) {
    status.textContent = '이 PC에 원본 파일이 없어 다른 사람이 받을 수 없습니다.';
    box.replaceChildren(label, status);
    return;
  }
  box.replaceChildren(label, status, el('div', { className: 'row' }, el('button', { onclick: () => download(msg, box) }, '받기')));
  if (allowAuto && isImage && f.size <= AUTO_IMAGE_MAX && state.users.get(msg.from.id)?.online) download(msg, box, true);
}

function keepBottom() {
  const box = $('messages');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 400) scrollToBottom();
}

function setStatus(box, text, bad) {
  const s = box.querySelector('.status');
  if (s) { s.textContent = text; s.classList.toggle('bad', !!bad); }
}

// ---------------- 파일: 받기 ----------------
async function download(msg, box, quiet) {
  if ([...state.incoming.values()].some((t) => t.msg.id === msg.id)) return;
  box.querySelector('.row')?.remove();
  setStatus(box, '보낸 사람 PC에 요청하는 중…');
  const handle = await window.api.saveStart(msg.file.name);
  try {
    const { transferId } = await request('file.request', { msgId: msg.id, p2p: !!window.RTCPeerConnection });
    state.incoming.set(transferId, { msg, handle, received: 0, chain: Promise.resolve(), sig: Promise.resolve(), pc: null, direct: false });
  } catch (e) {
    await window.api.saveAbort(handle);
    await renderFile(msg, state.fileBoxes.get(msg.id) || box, false);
    if (!quiet) setStatus(state.fileBoxes.get(msg.id) || box, e.message, true);
  }
}

function onBinary(buffer) { // 서버 경유로 온 조각
  const transferId = new DataView(buffer).getUint32(0);
  const tr = state.incoming.get(transferId);
  if (!tr) return;
  closePeer(tr); // 서버 경유로 오기 시작했으면 직접 연결 시도는 접는다
  writeChunk(transferId, tr, new Uint8Array(buffer, 4), false);
}

function writeChunk(transferId, tr, chunk, direct) {
  tr.chain = tr.chain.then(async () => {
    await window.api.saveChunk(tr.handle, chunk);
    tr.received += chunk.length;
    const box = state.fileBoxes.get(tr.msg.id);
    const pct = Math.floor((tr.received / Math.max(tr.msg.file.size, 1)) * 100);
    if (box) setStatus(box, `받는 중… ${fmtSize(tr.received)} / ${fmtSize(tr.msg.file.size)} (${pct}%) · ${direct ? '직접 전송' : '서버 경유'}`);
    if (!direct) emit('file.ack', { transferId }); // 받았다고 알려야 다음 조각이 온다
  }).catch(() => { emit('file.cancel', { transferId }); failIncoming(transferId, '파일을 저장하지 못했습니다.'); });
}

function finishIncoming(transferId, direct) {
  const tr = state.incoming.get(transferId);
  if (!tr) return;
  tr.chain.then(async () => {
    if (!state.incoming.delete(transferId)) return;
    await window.api.saveEnd(tr.handle, tr.msg.file.fileId);
    if (direct) emit('file.done', { transferId });
    closePeer(tr);
    state.stats[direct ? 'p2p' : 'relay']++;
    const box = state.fileBoxes.get(tr.msg.id);
    if (box) renderFile(tr.msg, box, false);
  });
}

function closePeer(tr) {
  const pc = tr.pc;
  tr.pc = null;
  try { pc?.close(); } catch { /* 이미 닫힘 */ }
}

// ---------------- 파일: P2P 직접 전송 ----------------
// 서버는 연결 정보(file.signal)만 전달하고, 파일 내용은 두 PC 사이를 직접 오간다.
function onFileSignal({ transferId, data }) {
  const tr = state.incoming.get(transferId);
  if (tr) { tr.sig = tr.sig.then(() => receiverSignal(transferId, tr, data)).catch(() => {}); return; }
  const out = state.outgoing.get(transferId);
  if (out?.pc) out.sig = out.sig.then(() => senderSignal(out, data)).catch(() => {});
}

async function receiverSignal(transferId, tr, data) {
  if (data.fallback) return closePeer(tr); // 보낸 쪽이 서버 경유로 바꿈
  if (data.sdp) {
    const pc = tr.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (e) => { if (e.candidate) emit('file.signal', { transferId, data: { candidate: e.candidate } }); };
    pc.ondatachannel = ({ channel }) => {
      channel.binaryType = 'arraybuffer';
      tr.direct = true;
      channel.onmessage = (e) => (typeof e.data === 'string' ? finishIncoming(transferId, true) : writeChunk(transferId, tr, new Uint8Array(e.data), true));
      channel.onclose = () => { // 다 받기 전에 직접 연결이 끊긴 경우
        if (state.incoming.get(transferId) === tr && tr.pc === pc) tr.chain.then(() => {
          if (state.incoming.get(transferId) !== tr) return;
          emit('file.cancel', { transferId });
          failIncoming(transferId, '직접 연결이 끊어졌습니다. 다시 받아 주세요.');
        });
      };
    };
    await pc.setRemoteDescription(data.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    emit('file.signal', { transferId, data: { sdp: pc.localDescription } });
  } else if (data.candidate && tr.pc) {
    await tr.pc.addIceCandidate(data.candidate);
  }
}

async function senderSignal(out, data) {
  if (data.sdp) await out.pc.setRemoteDescription(data.sdp);
  else if (data.candidate) await out.pc.addIceCandidate(data.candidate);
}

function abortOutgoing(out) {
  out.failed = true;
  out.onAck?.();
  out.wake?.();
  try { out.pc?.close(); } catch { /* 이미 닫힘 */ }
  out.pc = null;
}

async function sendFileP2P(transferId) {
  const out = state.outgoing.get(transferId);
  if (!out) return;
  let pc, ch;
  const opened = new Promise((resolve) => {
    out.wake = () => resolve(false);
    setTimeout(() => resolve(false), P2P_TIMEOUT);
    try {
      pc = out.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      ch = pc.createDataChannel('file');
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = DC_HIGH / 4;
      ch.onopen = () => resolve(true);
      pc.onicecandidate = (e) => { if (e.candidate) emit('file.signal', { transferId, data: { candidate: e.candidate } }); };
      pc.createOffer().then((o) => pc.setLocalDescription(o))
        .then(() => emit('file.signal', { transferId, data: { sdp: pc.localDescription } }))
        .catch(() => resolve(false));
    } catch { resolve(false); }
  });

  if (!(await opened)) {
    if (out.failed) return;
    try { pc?.close(); } catch { /* 이미 닫힘 */ }
    out.pc = null;
    emit('file.signal', { transferId, data: { fallback: true } });
    return sendFile(transferId); // 직접 연결 실패 → 서버 경유
  }

  let closed = false;
  ch.onclose = () => { closed = true; out.wake?.(); };
  ch.onbufferedamountlow = () => out.wake?.();
  try {
    for (let offset = 0; !out.failed && !closed;) {
      const block = await window.api.readFile(out.fileId, offset, CHUNK);
      for (let i = 0; i < block.length && !closed && !out.failed; i += DC_CHUNK) {
        if (ch.bufferedAmount > DC_HIGH) await new Promise((resolve) => { out.wake = resolve; }); // 밀리면 기다린다
        if (closed || out.failed) break;
        ch.send(block.subarray(i, i + DC_CHUNK));
      }
      offset += block.length;
      if (block.length < CHUNK) break;
    }
    if (out.failed) return;
    if (closed) throw new Error('closed');
    ch.send('end');
    ch.onbufferedamountlow = null; // 여기서부터는 연결이 닫힐 때만 깨어난다
    // 받는 쪽이 저장을 마치고 연결을 닫을 때까지 기다린다(최대 1분)
    await new Promise((resolve) => { out.wake = resolve; if (closed) resolve(); setTimeout(resolve, 60_000); });
  } catch {
    emit('file.cancel', { transferId });
  } finally {
    try { pc.close(); } catch { /* 이미 닫힘 */ }
    state.outgoing.delete(transferId);
  }
}

async function failIncoming(transferId, reason) {
  const tr = state.incoming.get(transferId);
  if (!tr) return;
  state.incoming.delete(transferId);
  closePeer(tr);
  await window.api.saveAbort(tr.handle);
  const box = state.fileBoxes.get(tr.msg.id);
  if (box) { await renderFile(tr.msg, box, false); setStatus(box, reason || '전송에 실패했습니다.', true); }
}

// ---------------- 파일: 보내기(상대가 받기를 눌렀을 때) ----------------
async function onFileOffer({ transferId, fileId }) {
  const local = await window.api.localFile(fileId);
  try {
    if (!local) return await request('file.reject', { transferId });
    state.outgoing.set(transferId, { fileId, failed: false, onAck: null, wake: null, pc: null, sig: Promise.resolve() });
    await request('file.accept', { transferId });
  } catch { state.outgoing.delete(transferId); } // 다른 창이 먼저 맡은 경우
}

async function sendFile(transferId) {
  const out = state.outgoing.get(transferId);
  if (!out) return;
  try {
    for (let offset = 0; !out.failed;) {
      const chunk = await window.api.readFile(out.fileId, offset, CHUNK);
      if (chunk.length === 0) break;
      const frame = new Uint8Array(4 + chunk.length);
      new DataView(frame.buffer).setUint32(0, transferId);
      frame.set(chunk, 4);
      const acked = new Promise((resolve) => { out.onAck = resolve; });
      state.ws.send(frame);
      await acked; // 한 번에 한 조각: 서버 메모리에 쌓이지 않게 한다
      offset += chunk.length;
      if (chunk.length < CHUNK) break;
    }
    if (!out.failed) emit('file.end', { transferId });
  } catch {
    emit('file.cancel', { transferId });
  } finally { state.outgoing.delete(transferId); }
}

// ---------------- 입력 창(모달) ----------------
function ask({ title, fields = [], body = null, okLabel = '확인', onSubmit }) {
  $('modalTitle').textContent = title;
  $('modalError').textContent = '';
  $('modalOk').textContent = okLabel;
  $('modalOk').hidden = !onSubmit;
  const inputs = {};
  $('modalBody').replaceChildren(...fields.map((f) => {
    const input = inputs[f.key] = el('input', { type: f.type || 'text', placeholder: f.placeholder || '' });
    return f.type === 'checkbox' ? el('label', { className: 'check' }, input, f.label) : el('label', {}, f.label, input);
  }), ...(body ? [body] : []));
  $('modal').hidden = false;
  Object.values(inputs)[0]?.focus();
  $('modalForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : i.value.trim()]));
    try { await onSubmit(values); closeModal(); } catch (err) { $('modalError').textContent = err.message; }
  };
}
const closeModal = () => { $('modal').hidden = true; };

function createRoom() {
  ask({
    title: '방 만들기', okLabel: '만들기',
    fields: [{ key: 'name', label: '방 이름', placeholder: '예: 주말 모임' }, { key: 'isPublic', type: 'checkbox', label: '공개 방 (누구나 찾아서 들어올 수 있음)' }],
    onSubmit: async (v) => {
      const { room } = await request('room.create', v);
      state.rooms.set(room.id, room);
      await openView({ type: 'room', id: room.id });
    },
  });
}

async function browseRooms() {
  const list = el('ul', { className: 'pick' });
  ask({ title: '공개 방 찾기', body: list });
  try {
    const { rooms } = await request('room.list');
    if (!rooms.length) list.append(el('li', {}, '아직 공개 방이 없습니다.'));
    for (const r of rooms) {
      list.append(el('li', {}, el('span', {}, `# ${r.name} `, el('small', {}, `${r.members}명`)),
        r.joined ? el('small', {}, '참여 중') : el('button', {
          onclick: async () => {
            try {
              const { room } = await request('room.join', { roomId: r.id });
              state.rooms.set(room.id, room);
              closeModal();
              await openView({ type: 'room', id: room.id });
            } catch (e) { $('modalError').textContent = e.message; }
          },
        }, '들어가기')));
    }
  } catch (e) { $('modalError').textContent = e.message; }
}

function inviteUser() {
  const room = state.rooms.get(state.current.id);
  ask({
    title: `'${room.name}' 방에 초대`, okLabel: '초대',
    fields: [{ key: 'nick', label: '초대할 사람의 닉네임' }],
    onSubmit: (v) => request('room.invite', { roomId: room.id, nick: v.nick }),
  });
}

function leaveRoom() {
  const room = state.rooms.get(state.current.id);
  ask({
    title: `'${room.name}' 방에서 나갈까요?`, okLabel: '나가기',
    body: el('p', {}, '마지막 사람이 나가면 방과 대화 기록이 삭제됩니다.'),
    onSubmit: () => request('room.leave', { roomId: room.id }),
  });
}

// ---------------- 화면 이벤트 ----------------
function wire() {
  $('loginForm').onsubmit = (e) => { e.preventDefault(); doLogin('login'); };
  $('btnRegister').onclick = () => { if ($('loginForm').reportValidity()) doLogin('register'); };
  $('btnLogout').onclick = logout;
  $('btnCreate').onclick = createRoom;
  $('btnBrowse').onclick = browseRooms;
  $('btnInvite').onclick = inviteUser;
  $('btnLeave').onclick = leaveRoom;
  $('btnReplyCancel').onclick = () => setReply(null);
  $('btnNoticeClear').onclick = clearNotices;
  $('btnPasteSend').onclick = sendPasted;
  $('btnPasteCancel').onclick = () => { clearPasted(); Editor.focus(); };
  document.addEventListener('paste', (e) => {
    const images = Editor.imagesIn(e);
    if (!images.length || !state.current || !$('modal').hidden) return;
    e.preventDefault();
    addPasted(images);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.pasted.length) { clearPasted(); Editor.focus(); } });
  // 화면 밝기: 시스템 설정 따르기 → 밝게 → 어둡게 순으로 바뀐다
  const THEMES = { system: '시스템', light: '밝게', dark: '어둡게' };
  const showTheme = (t) => { $('btnTheme').textContent = THEMES[t] || THEMES.system; };
  window.api.getTheme().then(showTheme);
  $('btnTheme').onclick = async () => { const order = Object.keys(THEMES); showTheme(await window.api.setTheme(order[(order.indexOf(await window.api.getTheme()) + 1) % order.length])); };
  if (!DM_MODE) window.api.onGoto(({ noticeId }) => { const n = state.notices.find((x) => x.id === noticeId); if (n) gotoNotice(n); });
  $('modalCancel').onclick = closeModal;
  $('btnAttach').onclick = async () => sendFiles(await window.api.pickFiles());
  $('composer').onsubmit = (e) => { e.preventDefault(); sendText(); };
  Editor.init({ onSend: sendText });

  // 파일을 끌어다 놓아 보내기
  const main = document.querySelector('main');
  main.ondragover = (e) => { e.preventDefault(); if (state.current) main.classList.add('dragging'); };
  main.ondragleave = () => main.classList.remove('dragging');
  main.ondrop = async (e) => {
    e.preventDefault();
    main.classList.remove('dragging');
    if (!state.current) return;
    sendFiles(await Promise.all([...e.dataTransfer.files].map((f) => window.api.registerDropped(f))));
  };
}

async function start() {
  wire();
  if (DM_MODE) document.body.classList.add('dm');
  const url = localStorage.getItem('sb.url');
  const token = localStorage.getItem('sb.token');
  $('fUrl').value = url || 'ws://localhost:7070';
  $('fNick').value = localStorage.getItem('sb.nick') || '';
  if (url && token) {
    try {
      await connect(url);
      return await enter(await request('login', { token }));
    } catch (e) {
      state.ws?.close();
      if (DM_MODE) return window.close();
      if (e.code !== 'bad_token') $('loginError').textContent = e.message;
    }
  }
  $('login').hidden = false;
}

start();
