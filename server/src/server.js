// 사랑방 서버: WebSocket 프로토콜 처리
import { WebSocketServer } from 'ws';
import { openDb, hashPassword, verifyPassword, newToken, dmKey } from './db.js';
import { createLogger } from './logger.js';

const MAX_TEXT = 20000;
const RICH_LANGS = new Set(['text', 'sql', 'json', 'javascript', 'python', 'markdown']);
const RICH_BGS = new Set(['yellow', 'green', 'pink', 'blue']);
const RICH_SIZES = new Set(['s', 'l', 'xl']);

// 서식 있는 메시지를 허용된 모양으로만 다시 만든다(HTML은 주고받지 않는다).
// 조각: { s: 글자, b/i/u/x: 굵게/기울임/밑줄/취소선, bg: 배경색, sz: 크기 } 또는 { t: 'code', lang, text }
function cleanRich(input) {
  if (!Array.isArray(input) || input.length > 5000) return null;
  const nodes = [];
  let formatted = false;
  for (const n of input) {
    if (!n || typeof n !== 'object') continue;
    if (n.t === 'code') {
      if (typeof n.text !== 'string' || !n.text.trim()) continue;
      nodes.push({ t: 'code', lang: RICH_LANGS.has(n.lang) ? n.lang : 'text', text: n.text });
      formatted = true;
      continue;
    }
    if (typeof n.s !== 'string' || !n.s) continue;
    const run = { s: n.s };
    for (const k of ['b', 'i', 'u', 'x']) if (n[k]) { run[k] = 1; formatted = true; }
    if (RICH_BGS.has(n.bg)) { run.bg = n.bg; formatted = true; }
    if (RICH_SIZES.has(n.sz)) { run.sz = n.sz; formatted = true; }
    nodes.push(run);
  }
  const text = nodes.map((n) => (n.t === 'code' ? `\n${n.text}\n` : n.s)).join('').trim();
  return { text, rich: formatted ? JSON.stringify(nodes) : null };
}
const MAX_CHUNK = 512 * 1024; // 파일 조각 최대 크기
const OFFER_TIMEOUT_MS = 10_000;
const MAX_NOTICES = 100; // 사용자당 보관하는 알림 수

class ChatError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new ChatError(code, message); };

export function startServer({ port = 7070, host = '0.0.0.0', dbPath = ':memory:', serverPassword = '', retentionDays = 0, log = {} } = {}) {
  const db = openDb(dbPath);
  const logger = createLogger(log);
  const wss = new WebSocketServer({ port, host, maxPayload: MAX_CHUNK + 1024 });
  const online = new Map();    // userId -> Set<conn>
  const transfers = new Map(); // transferId -> { receiver, sender, offered, rejected, timer }
  let nextTransferId = 1;

  const q = (sql) => db.prepare(sql);
  const now = () => Date.now();

  // ---------- 조회 도우미 ----------
  const userById = (id) => q('SELECT id, nick FROM users WHERE id = ?').get(id);
  const userByNick = (nick) => q('SELECT id, nick, pass FROM users WHERE nick = ?').get(String(nick || ''));
  const isMember = (roomId, userId) => !!q('SELECT 1 FROM members WHERE room_id = ? AND user_id = ?').get(roomId, userId);
  const memberIds = (roomId) => q('SELECT user_id FROM members WHERE room_id = ?').all(roomId).map((r) => r.user_id);

  function roomView(roomId) {
    const r = q('SELECT id, name, is_public, owner_id FROM rooms WHERE id = ?').get(roomId);
    if (!r) return null;
    const members = q('SELECT u.id, u.nick FROM members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY u.nick')
      .all(roomId).map((u) => ({ id: u.id, nick: u.nick, online: online.has(u.id) }));
    return { id: r.id, name: r.name, isPublic: !!r.is_public, ownerId: r.owner_id, members };
  }

  function msgView(row) {
    const sender = userById(row.sender_id);
    const m = { id: row.id, from: { id: sender.id, nick: sender.nick }, text: row.text, ts: row.ts };
    if (row.room_id) m.roomId = row.room_id;
    else m.dm = row.dm_key.split(':').map(Number);
    if (row.file) m.file = JSON.parse(row.file);
    if (row.rich) m.rich = JSON.parse(row.rich);
    if (row.reply_to) {
      const o = q('SELECT id, sender_id, text, file FROM messages WHERE id = ?').get(row.reply_to);
      if (o) {
        const snippet = o.text ? o.text.slice(0, 80) : (o.file ? `[파일] ${JSON.parse(o.file).name}` : '');
        m.replyTo = { id: o.id, nick: userById(o.sender_id).nick, text: snippet };
      }
    }
    return m;
  }

  function invitesFor(userId) {
    return q(`SELECT i.id, i.room_id, r.name AS room_name, u.nick AS from_nick
              FROM invites i JOIN rooms r ON r.id = i.room_id JOIN users u ON u.id = i.from_id
              WHERE i.to_id = ?`).all(userId)
      .map((i) => ({ id: i.id, roomId: i.room_id, roomName: i.room_name, from: i.from_nick }));
  }

  // ---------- 알림 내역(호출): 상대가 꺼져 있어도 다음 접속 때 볼 수 있게 저장한다 ----------
  const NOTICE_SQL = `SELECT n.id, n.kind, n.room_id, r.name AS room_name, n.msg_id, n.from_id, u.nick AS from_nick, n.text, n.ts
                      FROM notices n JOIN users u ON u.id = n.from_id LEFT JOIN rooms r ON r.id = n.room_id`;
  const noticeView = (n) => ({ id: n.id, kind: n.kind, roomId: n.room_id, roomName: n.room_name, msgId: n.msg_id, from: { id: n.from_id, nick: n.from_nick }, text: n.text, ts: n.ts });
  const noticesFor = (userId) => q(`${NOTICE_SQL} WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ?`).all(userId, MAX_NOTICES).map(noticeView);

  function addNotice(userId, { kind, roomId = null, msgId = null, fromId, text = '' }) {
    const info = q('INSERT INTO notices (user_id, kind, room_id, msg_id, from_id, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, kind, roomId, msgId, fromId, text.slice(0, 200), now());
    q('DELETE FROM notices WHERE user_id = ? AND id <= (SELECT id FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(userId, userId, MAX_NOTICES);
    sendUser(userId, { t: 'notice', notice: noticeView(q(`${NOTICE_SQL} WHERE n.id = ?`).get(Number(info.lastInsertRowid))) });
  }

  // ---------- 전송 도우미 ----------
  const send = (conn, obj) => { if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj)); };
  const sendUser = (userId, obj) => { for (const c of online.get(userId) || []) send(c, obj); };
  const sendUsers = (ids, obj) => { for (const id of new Set(ids)) sendUser(id, obj); };
  const sendAll = (obj) => { for (const set of online.values()) for (const c of set) send(c, obj); };
  const pushRoom = (roomId) => { const room = roomView(roomId); if (room) sendUsers(room.members.map((m) => m.id), { t: 'room.update', room }); };

  function attach(conn, user) {
    conn.user = { id: user.id, nick: user.nick };
    const wasOffline = !online.has(user.id);
    if (wasOffline) online.set(user.id, new Set());
    online.get(user.id).add(conn);
    if (wasOffline) sendAll({ t: 'presence', userId: user.id, nick: user.nick, online: true });
  }

  function sessionPayload(user, token) {
    const rooms = q('SELECT room_id FROM members WHERE user_id = ?').all(user.id).map((r) => roomView(r.room_id));
    return { user: { id: user.id, nick: user.nick }, token, rooms, invites: invitesFor(user.id), notices: noticesFor(user.id) };
  }

  function endTransfer(id, notify, reason) {
    const tr = transfers.get(id);
    if (!tr) return;
    clearTimeout(tr.timer);
    transfers.delete(id);
    for (const c of notify) if (c) send(c, { t: 'file.fail', transferId: id, reason });
  }

  // ---------- 요청 처리 ----------
  const handlers = {
    register(conn, m) {
      if (serverPassword && m.serverPassword !== serverPassword) fail('bad_server_password', '서버 접속 암호가 틀렸습니다.');
      const nick = String(m.nick || '').trim();
      if (!/^[^\s@]{2,20}$/u.test(nick)) fail('bad_nick', '닉네임은 공백과 @ 없이 2~20자여야 합니다.');
      if (String(m.password || '').length < 4) fail('bad_password', '비밀번호는 4자 이상이어야 합니다.');
      if (userByNick(nick)) fail('nick_taken', '이미 사용 중인 닉네임입니다.');
      const info = q('INSERT INTO users (nick, pass, created) VALUES (?, ?, ?)').run(nick, hashPassword(String(m.password)), now());
      const user = { id: Number(info.lastInsertRowid), nick };
      const token = newToken();
      q('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').run(token, user.id, now());
      attach(conn, user);
      return sessionPayload(user, token);
    },

    login(conn, m) {
      let user, token = m.token;
      if (token) {
        const s = q('SELECT user_id FROM sessions WHERE token = ?').get(String(token));
        if (!s) fail('bad_token', '로그인이 만료되었습니다. 다시 로그인해 주세요.');
        user = userById(s.user_id);
      } else {
        const u = userByNick(m.nick);
        if (!u || !verifyPassword(String(m.password || ''), u.pass)) fail('bad_login', '닉네임 또는 비밀번호가 틀렸습니다.');
        user = u;
        token = newToken();
        q('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').run(token, user.id, now());
      }
      attach(conn, user);
      return sessionPayload(user, token);
    },

    // 닉네임 변경: 지난 메시지·방 구성원 목록·알림에도 새 이름으로 보인다(이름은 사용자 번호에 묶여 있다)
    'user.rename'(conn, m) {
      const nick = String(m.nick || '').trim();
      if (!/^[^\s@]{2,20}$/u.test(nick)) fail('bad_nick', '닉네임은 공백과 @ 없이 2~20자여야 합니다.');
      const before = conn.user.nick;
      if (nick === before) fail('same_nick', '지금 쓰는 닉네임과 같습니다.');
      const taken = userByNick(nick);
      if (taken && taken.id !== conn.user.id) fail('nick_taken', '이미 사용 중인 닉네임입니다.');
      q('UPDATE users SET nick = ? WHERE id = ?').run(nick, conn.user.id);
      for (const c of online.get(conn.user.id) || []) c.user.nick = nick;
      sendAll({ t: 'user.update', user: { id: conn.user.id, nick } });
      return { user: { id: conn.user.id, nick }, before };
    },

    'users.list'() {
      return { users: q('SELECT id, nick FROM users ORDER BY nick').all().map((u) => ({ ...u, online: online.has(u.id) })) };
    },

    'room.create'(conn, m) {
      const name = String(m.name || '').trim();
      if (name.length < 1 || name.length > 30) fail('bad_name', '방 이름은 1~30자여야 합니다.');
      if (q('SELECT 1 FROM rooms WHERE name = ?').get(name)) fail('name_taken', '같은 이름의 방이 이미 있습니다.');
      const info = q('INSERT INTO rooms (name, is_public, owner_id, created) VALUES (?, ?, ?, ?)').run(name, m.isPublic ? 1 : 0, conn.user.id, now());
      const roomId = Number(info.lastInsertRowid);
      q('INSERT INTO members (room_id, user_id, joined) VALUES (?, ?, ?)').run(roomId, conn.user.id, now());
      pushRoom(roomId);
      return { room: roomView(roomId) };
    },

    'room.list'(conn) {
      const rows = q(`SELECT r.id, r.name, r.is_public,
                        (SELECT COUNT(*) FROM members m WHERE m.room_id = r.id) AS n,
                        EXISTS(SELECT 1 FROM members m WHERE m.room_id = r.id AND m.user_id = ?) AS joined
                      FROM rooms r WHERE r.is_public = 1 ORDER BY r.name`).all(conn.user.id);
      return { rooms: rows.map((r) => ({ id: r.id, name: r.name, members: r.n, joined: !!r.joined })) };
    },

    'room.join'(conn, m) {
      const r = q('SELECT id, is_public FROM rooms WHERE id = ?').get(m.roomId);
      if (!r) fail('no_room', '없는 방입니다.');
      if (!r.is_public) fail('private_room', '비공개 방은 초대를 받아야 들어갈 수 있습니다.');
      q('INSERT OR IGNORE INTO members (room_id, user_id, joined) VALUES (?, ?, ?)').run(r.id, conn.user.id, now());
      q('DELETE FROM invites WHERE room_id = ? AND to_id = ?').run(r.id, conn.user.id);
      pushRoom(r.id);
      return { room: roomView(r.id) };
    },

    'room.leave'(conn, m) {
      if (!isMember(m.roomId, conn.user.id)) fail('not_member', '이 방의 구성원이 아닙니다.');
      q('DELETE FROM members WHERE room_id = ? AND user_id = ?').run(m.roomId, conn.user.id);
      sendUser(conn.user.id, { t: 'room.left', roomId: m.roomId });
      if (memberIds(m.roomId).length === 0) {
        q('DELETE FROM messages WHERE room_id = ?').run(m.roomId);
        q('DELETE FROM notices WHERE room_id = ?').run(m.roomId);
        q('DELETE FROM rooms WHERE id = ?').run(m.roomId); // 아무도 없으면 방 정리
      } else pushRoom(m.roomId);
      return {};
    },

    'room.invite'(conn, m) {
      if (!isMember(m.roomId, conn.user.id)) fail('not_member', '이 방의 구성원만 초대할 수 있습니다.');
      const target = userByNick(m.nick);
      if (!target) fail('no_user', '그런 닉네임의 사용자가 없습니다.');
      if (isMember(m.roomId, target.id)) fail('already_member', '이미 방에 있는 사용자입니다.');
      q('INSERT OR IGNORE INTO invites (room_id, from_id, to_id, created) VALUES (?, ?, ?, ?)').run(m.roomId, conn.user.id, target.id, now());
      const inv = invitesFor(target.id).find((i) => i.roomId === m.roomId);
      sendUser(target.id, { t: 'invite', invite: inv });
      return {};
    },

    'invite.accept'(conn, m) {
      const inv = q('SELECT id, room_id FROM invites WHERE id = ? AND to_id = ?').get(m.inviteId, conn.user.id);
      if (!inv) fail('no_invite', '초대를 찾을 수 없습니다.');
      q('DELETE FROM invites WHERE id = ?').run(inv.id);
      q('INSERT OR IGNORE INTO members (room_id, user_id, joined) VALUES (?, ?, ?)').run(inv.room_id, conn.user.id, now());
      pushRoom(inv.room_id);
      return { room: roomView(inv.room_id) };
    },

    'invite.decline'(conn, m) {
      q('DELETE FROM invites WHERE id = ? AND to_id = ?').run(m.inviteId, conn.user.id);
      return {};
    },

    'msg.send'(conn, m) {
      const cleaned = m.rich ? cleanRich(m.rich) : null;
      if (m.rich && !cleaned) fail('bad_rich', '메시지 서식이 올바르지 않습니다.');
      const text = cleaned ? cleaned.text : String(m.text || '');
      const rich = cleaned ? cleaned.rich : null;
      if (text.length > MAX_TEXT) fail('too_long', `메시지는 ${MAX_TEXT}자까지 보낼 수 있습니다.`);
      let file = null;
      if (m.file) {
        const size = Number(m.file.size);
        if (!m.file.fileId || !m.file.name || !Number.isFinite(size) || size < 0) fail('bad_file', '파일 정보가 올바르지 않습니다.');
        file = JSON.stringify({ fileId: String(m.file.fileId).slice(0, 64), name: String(m.file.name).slice(0, 255), size, mime: String(m.file.mime || '').slice(0, 100) });
      }
      if (!text.trim() && !file) fail('empty', '빈 메시지는 보낼 수 없습니다.');

      let roomId = null, key = null, targets;
      if (m.roomId != null) {
        if (!isMember(m.roomId, conn.user.id)) fail('not_member', '이 방의 구성원이 아닙니다.');
        roomId = m.roomId;
        targets = memberIds(roomId);
      } else {
        const peer = userById(m.toUserId);
        if (!peer) fail('no_user', '없는 사용자입니다.');
        key = dmKey(conn.user.id, peer.id);
        targets = [conn.user.id, peer.id];
      }
      let replyTo = null;
      if (m.replyTo != null) {
        const o = q('SELECT room_id, dm_key FROM messages WHERE id = ?').get(m.replyTo);
        if (!o || o.room_id !== roomId || o.dm_key !== key) fail('bad_reply', '답글 대상 메시지를 찾을 수 없습니다.');
        replyTo = m.replyTo;
      }
      const info = q('INSERT INTO messages (room_id, dm_key, sender_id, text, reply_to, file, ts, rich) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomId, key, conn.user.id, text, replyTo, file, now(), rich);
      const msg = msgView(q('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid)));
      sendUsers(targets, { t: 'msg', msg });

      // @닉네임 호출
      if (roomId) {
        const nicks = new Set([...text.matchAll(/@([^\s@]{2,20})/gu)].map((x) => x[1].toLowerCase()));
        if (nicks.size) {
          for (const mem of roomView(roomId).members) {
            if (mem.id !== conn.user.id && nicks.has(mem.nick.toLowerCase())) addNotice(mem.id, { kind: 'mention', roomId, msgId: msg.id, fromId: conn.user.id, text });
          }
        }
      }
      return { msg };
    },

    history(conn, m) {
      const limit = Math.min(Math.max(Number(m.limit) || 50, 1), 200);
      const before = Number(m.before) || Number.MAX_SAFE_INTEGER;
      let rows;
      if (m.roomId != null) {
        if (!isMember(m.roomId, conn.user.id)) fail('not_member', '이 방의 구성원이 아닙니다.');
        rows = q('SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(m.roomId, before, limit);
      } else {
        rows = q('SELECT * FROM messages WHERE dm_key = ? AND id < ? ORDER BY id DESC LIMIT ?').all(dmKey(conn.user.id, Number(m.peerId)), before, limit);
      }
      return { messages: rows.reverse().map(msgView) };
    },

    call(conn, m) {
      const target = userById(m.userId);
      if (!target) fail('no_user', '없는 사용자입니다.');
      if (target.id === conn.user.id) fail('self', '자기 자신은 호출할 수 없습니다.');
      if (m.roomId != null && (!isMember(m.roomId, conn.user.id) || !isMember(m.roomId, target.id))) fail('not_member', '같은 방에 있는 사용자만 호출할 수 있습니다.');
      addNotice(target.id, { kind: 'call', roomId: m.roomId ?? null, fromId: conn.user.id });
      return { online: online.has(target.id) }; // 꺼져 있으면 다음 접속 때 알림 내역에 나타난다
    },

    'notice.clear'(conn, m) {
      if (m.noticeId != null) q('DELETE FROM notices WHERE id = ? AND user_id = ?').run(m.noticeId, conn.user.id);
      else q('DELETE FROM notices WHERE user_id = ?').run(conn.user.id);
      return {};
    },

    // ----- 파일 중계: 디스크에 쓰지 않고 보낸 사람 → 받는 사람으로 넘기기만 한다 -----
    'file.request'(conn, m) {
      const row = q('SELECT * FROM messages WHERE id = ?').get(m.msgId);
      if (!row || !row.file) fail('no_file', '파일 메시지를 찾을 수 없습니다.');
      const allowed = row.room_id ? isMember(row.room_id, conn.user.id) : row.dm_key.split(':').map(Number).includes(conn.user.id);
      if (!allowed) fail('forbidden', '이 파일을 받을 권한이 없습니다.');
      const senders = [...(online.get(row.sender_id) || [])].filter((c) => c !== conn);
      if (!senders.length) fail('sender_offline', '보낸 사람이 접속 중이 아니어서 지금은 받을 수 없습니다.');
      const id = nextTransferId++;
      const file = JSON.parse(row.file);
      const tr = { receiver: conn, sender: null, offered: senders.length, rejected: 0, p2p: !!m.p2p };
      tr.timer = setTimeout(() => { if (!tr.sender) endTransfer(id, [conn], '보낸 사람 쪽에서 응답이 없습니다.'); }, OFFER_TIMEOUT_MS);
      transfers.set(id, tr);
      for (const c of senders) send(c, { t: 'file.offer', transferId: id, fileId: file.fileId, p2p: tr.p2p });
      return { transferId: id, file };
    },

    'file.accept'(conn, m) {
      const tr = transfers.get(m.transferId);
      if (!tr || tr.sender) fail('no_transfer', '이미 처리된 전송입니다.');
      tr.sender = conn;
      clearTimeout(tr.timer);
      send(conn, { t: 'file.go', transferId: m.transferId, p2p: tr.p2p });
      return {};
    },

    'file.reject'(conn, m) {
      const tr = transfers.get(m.transferId);
      if (tr && !tr.sender && ++tr.rejected >= tr.offered) endTransfer(m.transferId, [tr.receiver], '보낸 사람 PC에 원본 파일이 더 이상 없습니다.');
      return {};
    },

    'file.ack'(conn, m) {
      const tr = transfers.get(m.transferId);
      if (tr && tr.receiver === conn && tr.sender) send(tr.sender, { t: 'file.ack', transferId: m.transferId });
    },

    'file.end'(conn, m) {
      const tr = transfers.get(m.transferId);
      if (tr && tr.sender === conn) {
        send(tr.receiver, { t: 'file.end', transferId: m.transferId });
        endTransfer(m.transferId, []);
      }
    },

    // P2P 직접 전송: 서버는 두 PC가 서로를 찾기 위한 연결 정보만 전달한다(파일 내용은 지나가지 않음)
    'file.signal'(conn, m) {
      const tr = transfers.get(m.transferId);
      if (!tr || !tr.sender) return;
      if (tr.sender === conn) send(tr.receiver, { t: 'file.signal', transferId: m.transferId, data: m.data });
      else if (tr.receiver === conn) send(tr.sender, { t: 'file.signal', transferId: m.transferId, data: m.data });
    },

    // 직접 전송이 끝났음을 알림 → 전송 기록만 정리
    'file.done'(conn, m) {
      const tr = transfers.get(m.transferId);
      if (tr && (tr.sender === conn || tr.receiver === conn)) endTransfer(m.transferId, []);
    },

    'file.cancel'(conn, m) {
      const tr = transfers.get(m.transferId);
      if (tr && (tr.sender === conn || tr.receiver === conn)) {
        endTransfer(m.transferId, [tr.sender === conn ? tr.receiver : tr.sender], '전송이 취소되었습니다.');
      }
    },
  };

  const NO_REPLY = new Set(['file.ack', 'file.end', 'file.cancel', 'file.signal', 'file.done']);

  // ---------- 기록(로그): 메시지 내용·파일 이름은 남기지 않는다 ----------
  const roomLabel = (id) => { const r = q('SELECT name FROM rooms WHERE id = ?').get(id); return r ? `${r.name}(#${id})` : `#${id}`; };
  const who = (conn) => ({ ip: conn.ip, 닉네임: conn.user?.nick });
  const LOGGED = {
    register: (c) => ['가입', who(c)],
    login: (c, m) => ['로그인 성공', { ...who(c), 방식: m.token ? '자동 로그인' : '비밀번호' }],
    'user.rename': (c, m, r) => ['닉네임 변경', { ...who(c), 이전: r.before }],
    'room.create': (c, m, r) => ['방 생성', { ...who(c), 방: roomLabel(r.room.id), 공개: r.room.isPublic ? '예' : '아니오' }],
    'room.join': (c, m) => ['방 입장', { ...who(c), 방: roomLabel(m.roomId) }],
    'room.leave': (c, m) => ['방 나감', { ...who(c), 방: `#${m.roomId}` }],
    'room.invite': (c, m) => ['초대', { ...who(c), 방: roomLabel(m.roomId), 대상: m.nick }],
    'invite.accept': (c, m, r) => ['초대 수락', { ...who(c), 방: roomLabel(r.room.id) }],
    'invite.decline': (c) => ['초대 거절', who(c)],
    'msg.send': (c, m, r) => [r.msg.roomId ? '메시지' : '1:1 메시지', {
      ...who(c), 방: r.msg.roomId ? roomLabel(r.msg.roomId) : undefined, 상대: r.msg.roomId ? undefined : userById(r.msg.dm.find((id) => id !== c.user.id) ?? c.user.id).nick,
      글자수: r.msg.text.length, 서식: r.msg.rich ? '있음' : undefined, 답글: r.msg.replyTo ? '예' : undefined, 파일크기: r.msg.file ? r.msg.file.size : undefined, 번호: r.msg.id,
    }],
    call: (c, m, r) => ['호출', { ...who(c), 대상: userById(m.userId)?.nick, 방: m.roomId != null ? roomLabel(m.roomId) : undefined, 상대접속: r.online ? '예' : '아니오' }],
    'file.request': (c, m, r) => ['파일 요청', { ...who(c), 메시지번호: m.msgId, 전송번호: r.transferId, 크기: r.file.size }],
    'file.accept': (c, m) => ['파일 전송 시작', { ...who(c), 전송번호: m.transferId, 방식: transfers.get(m.transferId)?.p2p ? '직접 전송 시도' : '서버 경유' }],
    'file.reject': (c, m) => ['파일 원본 없음', { ...who(c), 전송번호: m.transferId }],
    'file.end': (c, m) => ['파일 전송 완료', { ...who(c), 전송번호: m.transferId, 방식: '서버 경유' }],
    'file.done': (c, m) => ['파일 전송 완료', { ...who(c), 전송번호: m.transferId, 방식: '직접 전송' }],
    'file.cancel': (c, m) => ['파일 전송 취소', { ...who(c), 전송번호: m.transferId }],
  };
  function logRequest(conn, m, result) {
    if (!logger.enabled || !LOGGED[m.t]) return;
    try { logger.log(...LOGGED[m.t](conn, m, result || {})); } catch { /* 기록 실패가 서비스를 멈추면 안 된다 */ }
  }

  wss.on('connection', (ws, req) => {
    const conn = { ws, user: null, ip: (req.socket.remoteAddress || '?').replace(/^::ffff:/, ''), since: Date.now() };
    logger.log('접속 시도', { ip: conn.ip });

    ws.on('message', (data, isBinary) => {
      if (isBinary) { // 파일 조각: [전송번호 4바이트][내용]
        if (data.length < 4) return;
        const tr = transfers.get(data.readUInt32BE(0));
        if (tr && tr.sender === conn && tr.receiver.ws.readyState === 1) tr.receiver.ws.send(data, { binary: true });
        return;
      }
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      const handler = handlers[m.t];
      try {
        if (!handler) fail('unknown', '알 수 없는 요청입니다.');
        if (!conn.user && m.t !== 'register' && m.t !== 'login') fail('auth', '먼저 로그인해 주세요.');
        const known = (m.t === 'file.end' || m.t === 'file.done' || m.t === 'file.cancel') && transfers.has(m.transferId); // 처리 전에 확인(처리하면 사라진다)
        const result = handler(conn, m);
        if (!NO_REPLY.has(m.t)) send(conn, { t: 'ok', id: m.id, ...result });
        if (!NO_REPLY.has(m.t) || known) logRequest(conn, m, result);
      } catch (e) {
        if (!(e instanceof ChatError)) console.error('[서버 오류]', e);
        if (m.t === 'login' || m.t === 'register') logger.log(m.t === 'login' ? '로그인 실패' : '가입 실패', { ip: conn.ip, 닉네임: typeof m.nick === 'string' ? m.nick.slice(0, 20) : undefined, 사유: e.code || 'internal' });
        else logger.log('요청 실패', { ...who(conn), 요청: String(m.t).slice(0, 30), 사유: e.code || 'internal' });
        send(conn, { t: 'err', id: m.id, code: e.code || 'internal', message: e instanceof ChatError ? e.message : '서버 내부 오류가 발생했습니다.' });
      }
    });

    ws.on('close', () => {
      for (const [id, tr] of transfers) {
        if (tr.sender === conn) endTransfer(id, [tr.receiver], '보낸 사람의 연결이 끊어졌습니다.');
        else if (tr.receiver === conn) endTransfer(id, [tr.sender], '받는 사람의 연결이 끊어졌습니다.');
      }
      logger.log('접속 종료', { ...who(conn), 접속시간: `${Math.round((Date.now() - conn.since) / 1000)}초` });
      if (!conn.user) return;
      const set = online.get(conn.user.id);
      set?.delete(conn);
      if (set && set.size === 0) {
        online.delete(conn.user.id);
        sendAll({ t: 'presence', userId: conn.user.id, nick: conn.user.nick, online: false });
      }
    });
    ws.on('error', () => {});
  });

  // 오래된 메시지 정리(선택)
  let sweeper = null;
  if (retentionDays > 0) {
    const sweep = () => q('DELETE FROM messages WHERE ts < ?').run(now() - retentionDays * 86_400_000);
    sweep();
    sweeper = setInterval(sweep, 3_600_000);
    sweeper.unref();
  }

  const ready = new Promise((resolve, reject) => { wss.once('listening', () => { logger.log('서버 시작', { 포트: wss.address().port }); resolve(); }); wss.once('error', reject); });
  return {
    ready,
    get port() { return wss.address().port; },
    // 서버 화면용 현황: 지금 접속한 사람과 전체 개수
    status() {
      const connections = [];
      for (const set of online.values()) for (const c of set) connections.push({ ip: c.ip, nick: c.user.nick, since: c.since });
      const count = (table) => q(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      return { connections, waiting: wss.clients.size - connections.length, users: count('users'), rooms: count('rooms'), messages: count('messages') };
    },
    close() {
      clearInterval(sweeper);
      logger.log('서버 중지', {});
      logger.close();
      for (const tr of transfers.values()) clearTimeout(tr.timer);
      for (const c of wss.clients) c.terminate();
      return new Promise((resolve) => wss.close(() => { db.close(); resolve(); }));
    },
  };
}
