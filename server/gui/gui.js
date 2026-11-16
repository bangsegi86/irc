// 사랑방 서버 화면: 현황 · 기록 · 설정
'use strict';

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}
const two = (n) => String(n).padStart(2, '0');
const clock = (ts) => { const d = new Date(ts); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
function duration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}초`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 ${Math.floor((sec % 3600) / 60)}분`;
  return `${Math.floor(sec / 86400)}일 ${Math.floor((sec % 86400) / 3600)}시간`;
}
const size = (n) => { n = Number(n); return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`; };

// ---------------- 기록을 사람이 읽기 쉬운 말로 ----------------
const CATS = [
  { id: 'all', label: '전체' }, { id: 'problem', label: '문제' }, { id: 'conn', label: '접속' }, { id: 'login', label: '로그인·가입' },
  { id: 'room', label: '방·초대' }, { id: 'msg', label: '메시지·호출' }, { id: 'file', label: '파일' }, { id: 'server', label: '서버' },
];
const KIND_CAT = {
  '접속 시도': 'conn', '접속 종료': 'conn',
  '가입': 'login', '로그인 성공': 'login', '로그인 실패': 'login', '가입 실패': 'login',
  '방 생성': 'room', '방 입장': 'room', '방 나감': 'room', '초대': 'room', '초대 수락': 'room', '초대 거절': 'room',
  '메시지': 'msg', '1:1 메시지': 'msg', '호출': 'msg',
  '파일 요청': 'file', '파일 전송 시작': 'file', '파일 전송 완료': 'file', '파일 전송 취소': 'file', '파일 원본 없음': 'file',
  '서버 시작': 'server', '서버 중지': 'server', '서버 시작 실패': 'server', '요청 실패': 'server',
};
const PROBLEMS = new Set(['로그인 실패', '가입 실패', '요청 실패', '파일 전송 취소', '파일 원본 없음', '서버 시작 실패']);
const REASONS = {
  bad_login: '닉네임 또는 비밀번호가 틀림', bad_token: '저장된 로그인이 만료됨(다른 서버 데이터이거나 초기화됨)', bad_server_password: '서버 접속 암호가 틀림',
  nick_taken: '이미 있는 닉네임', bad_nick: '닉네임 형식이 맞지 않음', bad_password: '비밀번호가 너무 짧음', auth: '로그인하지 않고 요청함',
  not_member: '그 방의 구성원이 아님', no_room: '없는 방', private_room: '비공개 방(초대 필요)', name_taken: '같은 이름의 방이 있음', bad_name: '방 이름 형식이 맞지 않음',
  no_user: '없는 사용자', already_member: '이미 방에 있는 사용자', no_invite: '없는 초대', self: '자기 자신을 대상으로 함',
  empty: '빈 메시지', too_long: '메시지가 너무 김', bad_reply: '답글 대상이 없음', bad_file: '파일 정보가 잘못됨', bad_rich: '서식 정보가 잘못됨',
  no_file: '파일 메시지가 아님', forbidden: '받을 권한이 없음', sender_offline: '보낸 사람이 접속 중이 아님', no_transfer: '이미 끝난 전송', unknown: '알 수 없는 요청', internal: '서버 내부 오류',
  EADDRINUSE: '포트를 다른 프로그램이 사용 중',
};
const reason = (code) => (REASONS[code] ? `${REASONS[code]}` : String(code || '알 수 없음'));
const REQUESTS = { 'room.join': '방 입장', 'room.create': '방 만들기', 'room.leave': '방 나가기', 'room.invite': '초대', 'room.list': '방 목록 보기', 'msg.send': '메시지 보내기', history: '지난 대화 보기', call: '호출', 'file.request': '파일 받기', 'file.accept': '파일 보내기', 'invite.accept': '초대 수락', 'users.list': '사용자 목록 보기', 'notice.clear': '알림 지우기' };

// 한 건을 문장으로. [본문, 덧붙임(흐리게)]
function describe(kind, f) {
  switch (kind) {
    case '접속 시도': return ['서버에 연결했습니다', '아직 로그인 전'];
    case '접속 종료': return ['연결을 끊었습니다', f.접속시간 ? `머문 시간 ${duration(parseInt(f.접속시간, 10))}` : ''];
    case '가입': return ['새로 가입했습니다', ''];
    case '로그인 성공': return ['로그인했습니다', f.방식 || ''];
    case '로그인 실패': return [`로그인 실패 — ${reason(f.사유)}`, ''];
    case '가입 실패': return [`가입 실패 — ${reason(f.사유)}`, ''];
    case '방 생성': return [`방 '${f.방}' 을 만들었습니다`, f.공개 === '예' ? '공개 방' : '비공개 방'];
    case '방 입장': return [`방 '${f.방}' 에 들어갔습니다`, ''];
    case '방 나감': return [`방 ${f.방} 에서 나갔습니다`, ''];
    case '초대': return [`${f.대상} 님을 방 '${f.방}' 에 초대했습니다`, ''];
    case '초대 수락': return [`초대를 받아 방 '${f.방}' 에 들어갔습니다`, ''];
    case '초대 거절': return ['초대를 거절했습니다', ''];
    case '메시지': return [`방 '${f.방}' 에 메시지를 보냈습니다`, [f.파일크기 != null ? `파일 ${size(f.파일크기)}` : `${f.글자수}자`, f.서식 && '서식 있음', f.답글 && '답글', f.번호 && `#${f.번호}`].filter(Boolean).join(' · ')];
    case '1:1 메시지': return [`${f.상대} 님에게 1:1 메시지를 보냈습니다`, [f.파일크기 != null ? `파일 ${size(f.파일크기)}` : `${f.글자수}자`, f.서식 && '서식 있음', f.답글 && '답글', f.번호 && `#${f.번호}`].filter(Boolean).join(' · ')];
    case '호출': return [`${f.대상} 님을 호출했습니다`, [f.방 && `방 '${f.방}'`, f.상대접속 === '예' ? '상대 접속 중' : '상대 자리 비움(다음 접속 때 전달)'].filter(Boolean).join(' · ')];
    case '파일 요청': return ['파일 받기를 요청했습니다', [f.크기 != null && size(f.크기), f.전송번호 && `전송 ${f.전송번호}`, f.메시지번호 && `메시지 #${f.메시지번호}`].filter(Boolean).join(' · ')];
    case '파일 전송 시작': return ['파일을 보내기 시작했습니다', [f.방식, f.전송번호 && `전송 ${f.전송번호}`].filter(Boolean).join(' · ')];
    case '파일 전송 완료': return ['파일 전송이 끝났습니다', [f.방식, f.전송번호 && `전송 ${f.전송번호}`].filter(Boolean).join(' · ')];
    case '파일 전송 취소': return ['파일 전송이 취소되었습니다', f.전송번호 ? `전송 ${f.전송번호}` : ''];
    case '파일 원본 없음': return ['보낸 사람 PC에 원본 파일이 없어 전송하지 못했습니다', f.전송번호 ? `전송 ${f.전송번호}` : ''];
    case '요청 실패': return [`${REQUESTS[f.요청] || f.요청} 실패 — ${reason(f.사유)}`, f.요청 || ''];
    case '서버 시작': return [`서버를 시작했습니다`, [f.포트 && `포트 ${f.포트}`, f.참고].filter(Boolean).join(' · ')];
    case '서버 중지': return ['서버를 중지했습니다', ''];
    case '서버 시작 실패': return [`서버를 시작하지 못했습니다 — ${reason(f.사유)}`, f.포트 ? `포트 ${f.포트}` : ''];
    default: return [kind, Object.entries(f).filter(([k]) => k !== 'ip' && k !== '닉네임').map(([k, v]) => `${k} ${v}`).join(' · ')];
  }
}

const catOf = (e) => KIND_CAT[e.kind] || 'server';
const isProblem = (e) => PROBLEMS.has(e.kind);
const plain = (e) => { const [a, b] = describe(e.kind, e.fields); return `${dayKey(e.ts)} ${clock(e.ts)}  ${e.kind}  ${e.fields.닉네임 || '-'}  ${e.fields.ip || '-'}  ${a}${b ? ` (${b})` : ''}`; };

// ---------------- 상태 ----------------
const ui = { state: null, view: 'home', live: [], shown: [], cat: 'all', query: '', date: 'live', lastTs: 0 };
const GAP_MS = 10 * 60 * 1000;
const MAX_ROWS = 3000;

function row(e, onPick) {
  const [what, extra] = describe(e.kind, e.fields);
  const nick = e.fields.닉네임, ip = e.fields.ip;
  const pick = (value) => (onPick ? el('button', { type: 'button', title: `'${value}' 만 보기`, onclick: () => onPick(value) }, value) : el('span', {}, value));
  const who = nick ? pick(nick) : el('span', {}, '–'); who.classList.add('who');
  const ipNode = ip ? pick(ip) : el('span', {}, '–'); ipNode.classList.add('ip');
  return el('div', { className: `logRow cat-${catOf(e)} ${isProblem(e) ? 'problem' : ''}`, title: new Date(e.ts).toLocaleString('ko-KR') },
    el('span', { className: 'time' }, clock(e.ts)), el('span', { className: 'kind' }, e.kind), who, ipNode,
    el('span', { className: 'what' }, what, extra ? el('small', {}, extra) : null));
}

const matches = (e) => {
  if (ui.cat === 'problem' ? !isProblem(e) : ui.cat !== 'all' && catOf(e) !== ui.cat) return false;
  if (!ui.query) return true;
  const hay = `${e.kind} ${Object.values(e.fields).join(' ')} ${describe(e.kind, e.fields).join(' ')}`.toLowerCase();
  return ui.query.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
};

function renderCats() {
  const source = ui.shown;
  const counts = Object.fromEntries(CATS.map((c) => [c.id, 0]));
  for (const e of source) { counts.all++; counts[catOf(e)]++; if (isProblem(e)) counts.problem++; }
  $('cats').replaceChildren(...CATS.map((c) => el('button', { type: 'button', role: 'tab', className: `${ui.cat === c.id ? 'on' : ''} ${c.id === 'problem' && counts.problem ? 'problem' : ''}`, ariaSelected: String(ui.cat === c.id), onclick: () => { ui.cat = c.id; renderLog(); } },
    c.label, el('b', {}, String(counts[c.id])))));
  const liveProblems = ui.live.filter(isProblem).length;
  $('navProblems').hidden = !liveProblems;
  $('navProblems').textContent = String(liveProblems);
}

function appendRow(list, e) {
  if (ui.lastTs && e.ts - ui.lastTs >= GAP_MS) list.append(el('div', { className: 'logGap' }, `— ${duration((e.ts - ui.lastTs) / 1000)} 동안 기록 없음 —`));
  ui.lastTs = e.ts;
  list.append(row(e, (value) => { $('logSearch').value = ui.query = value; renderLog(); }));
}

function renderLog() {
  renderCats();
  const list = $('logList');
  const items = ui.shown.filter(matches).slice(-MAX_ROWS);
  ui.lastTs = 0;
  list.replaceChildren();
  if (!items.length) list.append(el('div', { className: 'logEmpty' }, ui.shown.length ? '조건에 맞는 기록이 없습니다.' : '아직 기록이 없습니다.'));
  for (const e of items) appendRow(list, e);
  $('logCount').textContent = `${ui.date === 'live' ? '오늘(실시간)' : ui.date} · 전체 ${ui.shown.length}건 중 ${items.length}건 표시${ui.query || ui.cat !== 'all' ? ' (걸러 보는 중)' : ''}`;
  if ($('logFollow').checked) list.scrollTop = list.scrollHeight;
}

function onLiveEntry(e) {
  ui.live.push(e);
  if (ui.live.length > MAX_ROWS) ui.live.shift();
  if (isProblem(e)) renderProblems();
  if (ui.date !== 'live') return renderCats();
  renderCats();
  if (!matches(e)) return;
  const list = $('logList');
  list.querySelector('.logEmpty')?.remove();
  appendRow(list, e);
  while (list.childElementCount > MAX_ROWS + 200) list.firstElementChild.remove();
  if ($('logFollow').checked) list.scrollTop = list.scrollHeight;
  $('logCount').textContent = `오늘(실시간) · 전체 ${ui.shown.length}건`;
}

async function loadDates() {
  const dates = await window.srv.logDates();
  const today = dayKey(Date.now());
  const keep = $('logDate').value || 'live';
  $('logDate').replaceChildren(el('option', { value: 'live' }, '오늘 (실시간)'), ...dates.filter((d) => d !== today).map((d) => el('option', { value: d }, d)));
  $('logDate').value = [...$('logDate').options].some((o) => o.value === keep) ? keep : 'live';
}

async function pickDate(value) {
  ui.date = value;
  ui.shown = value === 'live' ? ui.live : await window.srv.readLog(value);
  $('logFollow').disabled = value !== 'live';
  renderLog();
}

function renderProblems() {
  const items = ui.live.filter(isProblem).slice(-5).reverse();
  $('recentProblems').replaceChildren(...(items.length ? items.map((e) => row(e)) : [el('div', { className: 'logEmpty' }, '오늘 기록된 문제가 없습니다.')]));
}

// ---------------- 현황 ----------------
function renderState(s) {
  ui.state = s;
  const on = s.running, err = !!s.error;
  for (const dot of [$('statusDot'), document.querySelector('#navStatus .dot')]) dot.className = `dot ${dot.id === 'statusDot' ? 'big' : ''} ${on ? 'on' : err ? 'err' : ''}`;
  $('statusTitle').textContent = on ? '서버 실행 중' : err ? '서버를 시작하지 못했습니다' : '서버 중지됨';
  $('navStatusText').textContent = on ? `실행 중 · 포트 ${s.port}` : '중지됨';
  $('btnToggle').textContent = on ? '서버 중지' : '서버 시작';
  $('btnToggle').className = `primary ${on ? 'stop' : ''}`;
  $('errorBox').hidden = !err;
  $('errorBox').textContent = s.error || '';
  $('version').textContent = `버전 ${s.version}`;
  $('addresses').replaceChildren(...(on && s.addresses.length ? s.addresses.map((ip) => {
    const text = `${ip}:${s.port}`;
    const btn = el('button', { type: 'button', onclick: () => { window.srv.copy(text); btn.textContent = '복사됨'; setTimeout(() => { btn.textContent = '복사'; }, 1200); } }, '복사');
    return el('div', { className: 'addr' }, el('b', {}, text), btn);
  }) : [el('p', { className: 'hint' }, on ? '네트워크 주소를 찾지 못했습니다. 이 PC가 공유기에 연결되어 있는지 확인해 주세요.' : '서버를 시작하면 주소가 표시됩니다.')]));
  $('localAddr').textContent = `localhost:${s.port ?? s.settings.port}`;
  $('logOff').hidden = s.settings.log;
  $('dataPath').textContent = s.dataDir;
  tick();
}

async function tick() {
  const s = ui.state;
  if (!s) return;
  $('statusSub').textContent = s.running ? `포트 ${s.port} · 켠 지 ${duration((Date.now() - s.uptimeFrom) / 1000)} · 기록 ${s.settings.log ? '켜짐' : '꺼짐'}` : s.error ? '아래 안내를 확인해 주세요.' : "'서버 시작'을 누르면 참여자가 접속할 수 있습니다.";
  const st = s.running ? await window.srv.getStatus() : null;
  $('stOnline').textContent = st ? `${new Set(st.connections.map((c) => c.nick)).size}명` : '–';
  $('stUsers').textContent = st ? `${st.users}명` : '–';
  $('stRooms').textContent = st ? `${st.rooms}개` : '–';
  $('stMessages').textContent = st ? `${st.messages.toLocaleString('ko-KR')}건` : '–';
  const body = $('connTable').tBodies[0];
  const conns = st ? [...st.connections].sort((a, b) => a.nick.localeCompare(b.nick, 'ko') || a.since - b.since) : [];
  body.replaceChildren(...(conns.length ? conns.map((c) => el('tr', {}, el('td', {}, el('b', {}, c.nick)), el('td', { className: 'mono' }, c.ip), el('td', {}, duration((Date.now() - c.since) / 1000))))
    : [el('tr', {}, el('td', { className: 'empty', colSpan: 3 }, s.running ? '지금 접속한 사람이 없습니다.' : '서버가 꺼져 있습니다.'))]));
}

// ---------------- 설정 ----------------
function fillSettings(v) {
  $('sPort').value = v.port; $('sPassword').value = v.serverPassword; $('sLog').checked = v.log; $('sLogDays').value = v.logDays;
  $('sRetention').value = v.retentionDays; $('sAutoStart').checked = v.autoStart; $('sLaunch').checked = v.launchAtLogin; $('sTheme').value = v.theme;
}
const readSettings = () => ({
  port: Number($('sPort').value), serverPassword: $('sPassword').value.trim(), log: $('sLog').checked, logDays: Number($('sLogDays').value),
  retentionDays: Number($('sRetention').value), autoStart: $('sAutoStart').checked, launchAtLogin: $('sLaunch').checked, theme: $('sTheme').value,
});

function show(view) {
  ui.view = view;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.view === view);
  for (const v of ['home', 'log', 'settings']) $(`view-${v}`).hidden = v !== view;
  if (view === 'log') { loadDates(); renderLog(); }
  if (view === 'settings') { fillSettings(ui.state.settings); $('settingsMsg').textContent = ''; }
}

async function init() {
  for (const t of document.querySelectorAll('.tab')) t.onclick = () => show(t.dataset.view);
  $('btnToggle').onclick = async () => { $('btnToggle').disabled = true; try { renderState(await (ui.state.running ? window.srv.stop() : window.srv.start())); } finally { $('btnToggle').disabled = false; } };
  $('btnSeeProblems').onclick = () => { ui.cat = 'problem'; $('logDate').value = 'live'; ui.date = 'live'; ui.shown = ui.live; show('log'); };
  $('logSearch').oninput = () => { ui.query = $('logSearch').value.trim(); renderLog(); };
  $('logDate').onchange = () => pickDate($('logDate').value);
  $('logFollow').onchange = () => { if ($('logFollow').checked) $('logList').scrollTop = $('logList').scrollHeight; };
  $('btnLogCopy').onclick = () => {
    const lines = ui.shown.filter(matches).slice(-MAX_ROWS).map(plain);
    window.srv.copy(lines.join('\n'));
    $('btnLogCopy').textContent = `${lines.length}건 복사됨`;
    setTimeout(() => { $('btnLogCopy').textContent = '보이는 기록 복사'; }, 1500);
  };
  $('btnLogFolder').onclick = $('btnOpenLogs').onclick = () => window.srv.openLogs();
  $('btnOpenData').onclick = () => window.srv.openData();
  $('btnReset').onclick = () => { fillSettings(ui.state.settings); $('settingsMsg').textContent = '저장된 값으로 되돌렸습니다.'; };
  $('settingsForm').onsubmit = async (e) => {
    e.preventDefault();
    const r = await window.srv.saveSettings(readSettings());
    renderState(r.state);
    fillSettings(r.state.settings);
    $('settingsMsg').textContent = r.state.error ? `저장했지만 서버를 시작하지 못했습니다: ${r.state.error}` : r.restarted ? '저장했습니다. 바뀐 설정으로 서버를 다시 시작했습니다(접속 중이던 사람은 잠시 끊겼다가 자동으로 다시 붙습니다).' : '저장했습니다.';
  };

  ui.live = await window.srv.recentLog();
  ui.shown = ui.live;
  window.srv.onState(renderState);
  window.srv.onLog(onLiveEntry);
  renderState(await window.srv.getState());
  renderProblems();
  renderCats();
  setInterval(tick, 2000);
}

init();
