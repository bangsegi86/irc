import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';

let server, url;
before(async () => { server = startServer({ port: 0, host: '127.0.0.1' }); await server.ready; url = `ws://127.0.0.1:${server.port}`; });
after(() => server.close());

// 테스트용 간이 클라이언트
async function client() {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let nextId = 1;
  const pending = new Map(), events = [], waiters = [], binary = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) { binary.push(data); c.onBinary?.(data); return; }
    const m = JSON.parse(data.toString());
    if ((m.t === 'ok' || m.t === 'err') && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      return m.t === 'ok' ? p.res(m) : p.rej(Object.assign(new Error(m.message), { code: m.code }));
    }
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].res(m); else events.push(m);
  });
  const c = {
    ws, binary,
    req: (t, body = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ t, id, ...body })); }),
    emit: (t, body = {}) => ws.send(JSON.stringify({ t, ...body })),
    next: (t) => {
      const i = events.findIndex((e) => e.t === t);
      if (i >= 0) return Promise.resolve(events.splice(i, 1)[0]);
      return new Promise((res, rej) => { waiters.push({ t, res }); setTimeout(() => rej(new Error(`'${t}' 이벤트가 오지 않음`)), 2000); });
    },
    close: () => new Promise((res) => { ws.once('close', res); ws.close(); }),
  };
  return c;
}
async function user(nick) { const c = await client(); c.me = (await c.req('register', { nick, password: 'pass1234' })).user; return c; }

test('가입, 로그인, 토큰 재접속', async () => {
  const a = await client();
  const r = await a.req('register', { nick: '철수', password: 'pass1234' });
  assert.equal(r.user.nick, '철수');
  await assert.rejects(a.req('register', { nick: '철수', password: 'pass1234' }), { code: 'nick_taken' });
  const b = await client();
  await assert.rejects(b.req('login', { nick: '철수', password: 'wrong' }), { code: 'bad_login' });
  assert.equal((await b.req('login', { nick: '철수', password: 'pass1234' })).user.id, r.user.id);
  const c = await client();
  assert.equal((await c.req('login', { token: r.token })).user.id, r.user.id);
  await assert.rejects((await client()).req('room.list'), { code: 'auth' });
  await Promise.all([a.close(), b.close(), c.close()]);
});

test('비공개 방: 초대 → 수락 → 대화 → 답글 → @호출', async () => {
  const a = await user('영희'), b = await user('민수'), c = await user('외부인');
  const { room } = await a.req('room.create', { name: '비밀방', isPublic: false });
  await assert.rejects(b.req('room.join', { roomId: room.id }), { code: 'private_room' });
  await assert.rejects(b.req('msg.send', { roomId: room.id, text: '몰래' }), { code: 'not_member' });
  assert.equal((await b.req('room.list')).rooms.some((r) => r.id === room.id), false);

  await a.req('room.invite', { roomId: room.id, nick: '민수' });
  const { invite } = await b.next('invite');
  assert.equal(invite.roomName, '비밀방');
  const joined = await b.req('invite.accept', { inviteId: invite.id });
  assert.equal(joined.room.members.length, 2);

  const first = (await a.req('msg.send', { roomId: room.id, text: '안녕하세요' })).msg;
  assert.equal((await b.next('msg')).msg.text, '안녕하세요');

  const reply = (await b.req('msg.send', { roomId: room.id, text: '반가워요 @영희', replyTo: first.id })).msg;
  assert.deepEqual(reply.replyTo, { id: first.id, nick: '영희', text: '안녕하세요' });
  const mention = (await a.next('notice')).notice;
  assert.deepEqual([mention.kind, mention.msgId, mention.roomName, mention.from.nick, mention.text], ['mention', reply.id, '비밀방', '민수', '반가워요 @영희']);

  const hist = await b.req('history', { roomId: room.id });
  assert.deepEqual(hist.messages.map((m) => m.text), ['안녕하세요', '반가워요 @영희']);
  await assert.rejects(c.req('history', { roomId: room.id }), { code: 'not_member' });

  await a.req('call', { userId: b.me.id, roomId: room.id });
  const call = (await b.next('notice')).notice;
  assert.deepEqual([call.kind, call.roomId, call.from.nick], ['call', room.id, '영희']);
  await assert.rejects(c.req('call', { userId: b.me.id, roomId: room.id }), { code: 'not_member' });
  await Promise.all([a.close(), b.close(), c.close()]);
});

test('오프라인 초대는 다음 로그인 때 전달된다', async () => {
  const a = await user('방장'), b = await user('지각생');
  const token = (await b.req('login', { nick: '지각생', password: 'pass1234' })).token;
  await b.close();
  const { room } = await a.req('room.create', { name: '나중방', isPublic: false });
  await a.req('room.invite', { roomId: room.id, nick: '지각생' });
  const b2 = await client();
  const session = await b2.req('login', { token });
  assert.equal(session.invites[0].roomName, '나중방');
  await Promise.all([a.close(), b2.close()]);
});

test('공개 방 참여와 1:1 대화', async () => {
  const a = await user('가'.repeat(2)), b = await user('나'.repeat(2)), c = await user('다'.repeat(2));
  const { room } = await a.req('room.create', { name: '광장', isPublic: true });
  assert.ok((await b.req('room.list')).rooms.some((r) => r.id === room.id));
  await b.req('room.join', { roomId: room.id });

  await a.req('msg.send', { toUserId: b.me.id, text: '둘만의 이야기' });
  assert.equal((await b.next('msg')).msg.text, '둘만의 이야기');
  assert.equal((await b.req('history', { peerId: a.me.id })).messages.length, 1);
  assert.equal((await c.req('history', { peerId: a.me.id })).messages.length, 0);
  await Promise.all([a.close(), b.close(), c.close()]);
});

test('파일 중계: 내용이 그대로 전달되고 서버에는 정보만 남는다', async () => {
  const a = await user('보낸이'), b = await user('받는이'), c = await user('남남');
  const { room } = await a.req('room.create', { name: '자료방', isPublic: false });
  await a.req('room.invite', { roomId: room.id, nick: '받는이' });
  await b.req('invite.accept', { inviteId: (await b.next('invite')).invite.id });

  const content = randomBytes(700_000);
  const CHUNK = 256 * 1024;
  const { msg } = await a.req('msg.send', { roomId: room.id, file: { fileId: 'f1', name: '사진.png', size: content.length, mime: 'image/png' } });
  assert.equal(msg.file.name, '사진.png');
  await assert.rejects(c.req('file.request', { msgId: msg.id }), { code: 'forbidden' });

  // 받는 쪽: 조각을 받을 때마다 ack
  const received = [];
  b.onBinary = (data) => { received.push(data.subarray(4)); b.emit('file.ack', { transferId: data.readUInt32BE(0) }); };

  const { transferId, file } = await b.req('file.request', { msgId: msg.id });
  assert.equal(file.size, content.length);

  // 보낸 쪽: offer → accept → go → 조각 전송(ack 기다리며)
  const offer = await a.next('file.offer');
  assert.equal(offer.fileId, 'f1');
  await a.req('file.accept', { transferId });
  await a.next('file.go');
  for (let off = 0; off < content.length; off += CHUNK) {
    const head = Buffer.alloc(4); head.writeUInt32BE(transferId);
    a.ws.send(Buffer.concat([head, content.subarray(off, off + CHUNK)]));
    await a.next('file.ack');
  }
  a.emit('file.end', { transferId });
  await b.next('file.end');
  assert.ok(Buffer.concat(received).equals(content));

  // 보낸 사람이 오프라인이면 받을 수 없다
  await a.close();
  await assert.rejects(b.req('file.request', { msgId: msg.id }), { code: 'sender_offline' });
  await Promise.all([b.close(), c.close()]);
});

test('보낸 쪽에 원본이 없으면 실패 알림', async () => {
  const a = await user('삭제한이'), b = await user('기다린이');
  const { msg } = await a.req('msg.send', { toUserId: b.me.id, file: { fileId: 'gone', name: 'a.zip', size: 10 } });
  const { transferId } = await b.req('file.request', { msgId: msg.id });
  await a.next('file.offer');
  await a.req('file.reject', { transferId });
  assert.equal((await b.next('file.fail')).transferId, transferId);
  await Promise.all([a.close(), b.close()]);
});

test('P2P 신호 전달: 당사자끼리만 오가고, 완료 알림 후 전송이 정리된다', async () => {
  const a = await user('직접보냄'), b = await user('직접받음'), c = await user('엿보는이');
  const { msg } = await a.req('msg.send', { toUserId: b.me.id, file: { fileId: 'p2p', name: 'big.iso', size: 10 } });
  const { transferId } = await b.req('file.request', { msgId: msg.id, p2p: true });
  assert.equal((await a.next('file.offer')).p2p, true);
  await a.req('file.accept', { transferId });
  assert.equal((await a.next('file.go')).p2p, true);

  a.emit('file.signal', { transferId, data: { sdp: 'offer' } });
  assert.deepEqual((await b.next('file.signal')).data, { sdp: 'offer' });
  b.emit('file.signal', { transferId, data: { sdp: 'answer' } });
  assert.deepEqual((await a.next('file.signal')).data, { sdp: 'answer' });

  c.emit('file.signal', { transferId, data: { sdp: 'evil' } }); // 제3자의 신호는 무시
  c.emit('file.done', { transferId });
  a.emit('file.signal', { transferId, data: { n: 2 } });
  assert.deepEqual((await b.next('file.signal')).data, { n: 2 });

  b.emit('file.done', { transferId });
  await b.req('users.list'); // 서버가 file.done 을 처리할 때까지 기다림
  await assert.rejects(a.req('file.accept', { transferId }), { code: 'no_transfer' });
  await Promise.all([a.close(), b.close(), c.close()]);
});

test('알림 내역: 꺼져 있던 동안의 호출도 다음 접속 때 보이고, 지울 수 있다', async () => {
  const a = await user('부르는이'), b = await user('자리비움');
  const token = (await b.req('login', { nick: '자리비움', password: 'pass1234' })).token;
  const { room } = await a.req('room.create', { name: '알림방', isPublic: true });
  await b.req('room.join', { roomId: room.id });
  await b.close();

  await a.req('msg.send', { roomId: room.id, text: '@자리비움 회의 시작해요' });
  assert.equal((await a.req('call', { userId: b.me.id, roomId: room.id })).online, false);
  await assert.rejects(a.req('call', { userId: a.me.id }), { code: 'self' });

  const b2 = await client();
  const { notices } = await b2.req('login', { token });
  assert.deepEqual(notices.map((n) => n.kind), ['call', 'mention']); // 최신순
  assert.equal(notices[1].text, '@자리비움 회의 시작해요');

  await b2.req('notice.clear', { noticeId: notices[1].id });
  await a.req('notice.clear', { noticeId: notices[0].id }); // 남의 알림은 못 지운다
  const b3 = await client();
  assert.deepEqual((await b3.req('login', { token })).notices.map((n) => n.kind), ['call']);
  await b3.req('notice.clear');
  const b4 = await client();
  assert.equal((await b4.req('login', { token })).notices.length, 0);
  await Promise.all([a.close(), b2.close(), b3.close(), b4.close()]);
});
