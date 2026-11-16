// 메시지 입력기: 보이는 대로 편집(굵게·기울임·밑줄·취소선·배경색·크기) + 코드/쿼리 입력
// 메시지는 HTML이 아니라 허용된 조각 목록으로 주고받는다.
//   글자 조각: { s, b, i, u, x, bg, sz }   코드 조각: { t: 'code', lang, text }
'use strict';

const Editor = (() => {
  const PALETTE = { yellow: '#7a6220', green: '#2f6b4a', pink: '#7d3b5c', blue: '#2f5688' };
  const SIZE_TO_FONT = { s: '2', l: '5', xl: '6' };
  const FONT_TO_SIZE = { 1: 's', 2: 's', 4: 'l', 5: 'l', 6: 'xl', 7: 'xl' };
  const LANG_LABEL = { text: '일반 텍스트', sql: 'SQL', json: 'JSON', javascript: 'JavaScript', python: 'Python', markdown: 'Markdown' };
  const KEYWORDS = {
    sql: 'select from where and or not insert into values update set delete create alter drop table index view join inner left right outer full on as group by order having limit offset union all distinct case when then else end null is in like between exists count sum avg min max desc asc primary key foreign references default with top'.split(' '),
    javascript: 'const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof this null undefined true false of in'.split(' '),
    python: 'def return if elif else for while in not and or is import from as class try except finally raise with lambda pass break continue yield None True False async await global nonlocal del assert'.split(' '),
    json: ['true', 'false', 'null'],
  };
  const COMMENTS = { sql: '--[^\\n]*|/\\*[\\s\\S]*?\\*/', javascript: '//[^\\n]*|/\\*[\\s\\S]*?\\*/', python: '#[^\\n]*' };

  let input, codeInput, toolbar, langSel, hint, codeBtn, onSend;
  let codeMode = false;
  const colorKey = {}; // 'rgb(r, g, b)' -> 팔레트 이름

  const el = (tag, props = {}, ...children) => { const n = Object.assign(document.createElement(tag), props); n.append(...children); return n; };

  // ---------- 언어 자동 인식 ----------
  function detectLang(text) {
    const t = text.trim();
    if (/^[{[]/.test(t)) { try { JSON.parse(t); return 'json'; } catch { /* JSON 아님 */ } }
    if (/^\s*(select|insert\s+into|update|delete\s+from|create\s+(table|index|view)|alter\s+table|drop\s+table|with\s+\w+\s+as)\b/im.test(t) && /\b(from|into|set|table|values|index|view|as)\b/i.test(t)) return 'sql';
    if (/^\s*(def \w+\(|class \w+.*:\s*$|import \w+|from [\w.]+ import )/m.test(t) || /^\s*(if|for|while) .+:\s*$/m.test(t)) return 'python';
    if (/\b(const|let|var) \w+\s*=|\bfunction\s*\w*\(|=>|console\.\w+\(|;\s*$/m.test(t) && /[{}();]/.test(t)) return 'javascript';
    if (/^#{1,6} \S/m.test(t) || (/^\s*[-*] \S/m.test(t) && /\*\*.+\*\*|\[.+\]\(.+\)/.test(t))) return 'markdown';
    return null;
  }

  // ---------- 코드 색 입히기 ----------
  function highlight(lang, text) {
    const span = (cls, s) => el('span', { className: cls }, s);
    if (lang === 'markdown') {
      return text.split(/(\n)/).map((line) => (/^#{1,6} /.test(line) ? span('tok-kw', line) : /^\s*([-*]|\d+\.) /.test(line) ? span('tok-num', line) : /^```/.test(line) ? span('tok-com', line) : line));
    }
    if (!KEYWORDS[lang]) return [text];
    const words = new Set(KEYWORDS[lang]);
    const re = new RegExp(`(${COMMENTS[lang] || '(?!)'})|('(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_][A-Za-z0-9_]*)`, 'g');
    const out = [];
    let last = 0;
    for (let m; (m = re.exec(text));) {
      let cls = null;
      if (m[1]) cls = 'tok-com';
      else if (m[2]) cls = lang === 'json' && /^\s*:/.test(text.slice(re.lastIndex)) ? 'tok-key' : 'tok-str';
      else if (m[3]) cls = 'tok-num';
      else if (words.has(lang === 'sql' ? m[4].toLowerCase() : m[4])) cls = 'tok-kw';
      if (!cls) continue;
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(span(cls, m[0]));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  // ---------- 받은 메시지 그리기 (사용자 입력은 항상 글자로만 넣는다) ----------
  function codeBlock(node) {
    const copy = el('button', { type: 'button', className: 'copy', onclick: () => {
      window.api.copyText(node.text);
      copy.textContent = '복사됨';
      setTimeout(() => { copy.textContent = '복사'; }, 1200);
    } }, '복사');
    return el('div', { className: 'code' },
      el('div', { className: 'codeHead' }, el('span', {}, LANG_LABEL[node.lang] || LANG_LABEL.text), copy),
      el('pre', {}, ...highlight(node.lang, node.text)));
  }

  function renderRich(nodes, textNodes) {
    const box = el('div', { className: 'text' });
    for (const n of nodes) {
      if (n.t === 'code') { box.append(codeBlock(n)); continue; }
      const cls = [n.b && 'f-b', n.i && 'f-i', n.u && 'f-u', n.x && 'f-x', n.u && n.x && 'f-ux', n.bg && `bg-${n.bg}`, n.sz && `sz-${n.sz}`].filter(Boolean).join(' ');
      if (cls) box.append(el('span', { className: cls }, ...textNodes(n.s)));
      else box.append(...textNodes(n.s));
    }
    return box;
  }

  // ---------- 입력란 내용을 조각 목록으로 ----------
  function serialize() {
    const runs = [];
    const push = (s, f) => {
      const last = runs[runs.length - 1];
      const same = last && ['b', 'i', 'u', 'x', 'bg', 'sz'].every((k) => last[k] === f[k]);
      if (same) last.s += s; else runs.push({ s, ...f });
    };
    const text = () => runs.map((r) => r.s).join('');
    (function walk(node, f) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { if (child.data) push(child.data, f); continue; }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName;
        if (tag === 'BR') { push('\n', {}); continue; }
        const g = { ...f };
        if (tag === 'B' || tag === 'STRONG') g.b = 1;
        if (tag === 'I' || tag === 'EM') g.i = 1;
        if (tag === 'U') g.u = 1;
        if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') g.x = 1;
        if (tag === 'FONT' && child.size) { const sz = FONT_TO_SIZE[child.size]; if (sz) g.sz = sz; else delete g.sz; }
        const bg = child.style?.backgroundColor;
        if (bg) { if (colorKey[bg]) g.bg = colorKey[bg]; else delete g.bg; }
        const block = tag === 'DIV' || tag === 'P';
        if (block && runs.length && !text().endsWith('\n')) push('\n', {});
        walk(child, g);
      }
    })(input, {});
    // 앞뒤 빈칸·빈 줄 정리
    while (runs.length && !runs[0].s.trimStart()) runs.shift();
    while (runs.length && !runs[runs.length - 1].s.trimEnd()) runs.pop();
    if (runs.length) { runs[0].s = runs[0].s.trimStart(); runs[runs.length - 1].s = runs[runs.length - 1].s.trimEnd(); }
    return runs.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v)));
  }

  // 보낼 내용: { text } (서식 없음) 또는 { rich } (서식·코드). 비어 있으면 null
  function getContent() {
    if (codeMode) {
      const text = codeInput.value.replace(/\s+$/, '');
      if (!text.trim()) return null;
      const lang = langSel.value === 'auto' ? detectLang(text) || 'text' : langSel.value;
      return { rich: [{ t: 'code', lang, text }] };
    }
    const runs = serialize();
    if (!runs.length) return null;
    return runs.some((r) => Object.keys(r).length > 1) ? { rich: runs } : { text: runs.map((r) => r.s).join('') };
  }

  // ---------- 서식 버튼 ----------
  function exec(cmd, value) {
    input.focus();
    document.execCommand(cmd, false, value);
    refreshToolbar();
  }

  // 커서 위치의 글자 크기(작게/크게/아주 크게). 보통이면 null
  function currentSize() {
    for (let n = document.getSelection()?.anchorNode; n && n !== input; n = n.parentNode) {
      if (n.tagName === 'FONT' && n.size) return FONT_TO_SIZE[n.size] || null;
    }
    return null;
  }

  function refreshToolbar() {
    const inside = !codeMode && input.contains(document.getSelection()?.anchorNode);
    for (const b of toolbar.querySelectorAll('[data-cmd]')) b.classList.toggle('on', inside && document.queryCommandState(b.dataset.cmd));
    const size = inside ? currentSize() : null;
    for (const b of toolbar.querySelectorAll('[data-size]')) b.classList.toggle('on', b.dataset.size === size);
  }

  function setCodeMode(on, text, note) {
    if (on === codeMode && text == null) return;
    if (on) {
      codeInput.value = text ?? input.innerText.replace(/\n$/, '');
      input.replaceChildren();
    } else if (codeMode) {
      input.textContent = codeInput.value;
      codeInput.value = '';
    }
    codeMode = on;
    toolbar.classList.toggle('codeMode', on);
    codeBtn.classList.toggle('on', on);
    input.hidden = on;
    codeInput.hidden = langSel.hidden = !on;
    hint.textContent = on ? `${note ? `${note} · ` : ''}코드 입력 중 — Enter 줄바꿈, Ctrl+Enter 전송. 일반 글자로 돌아가려면 '코드' 버튼을 다시 누르세요.` : '';
    growCode();
    focus();
  }

  function growCode() {
    codeInput.style.height = 'auto';
    codeInput.style.height = `${Math.min(Math.max(codeInput.scrollHeight, 80), 260)}px`;
  }

  function clear() {
    input.replaceChildren();
    codeInput.value = '';
    if (codeMode) setCodeMode(false);
    langSel.value = 'auto';
    refreshToolbar();
  }
  const focus = () => (codeMode ? codeInput : input).focus();

  function init(opts) {
    onSend = opts.onSend;
    input = document.getElementById('input');
    codeInput = document.getElementById('codeInput');
    toolbar = document.getElementById('toolbar');
    langSel = document.getElementById('codeLang');
    hint = document.getElementById('composeHint');
    codeBtn = document.getElementById('btnCode');

    const probe = document.createElement('span');
    for (const [key, hex] of Object.entries(PALETTE)) { probe.style.backgroundColor = hex; colorKey[probe.style.backgroundColor] = key; }
    langSel.append(el('option', { value: 'auto' }, '언어 자동 인식'), ...Object.entries(LANG_LABEL).map(([v, label]) => el('option', { value: v }, label)));
    document.execCommand('styleWithCSS', false, false);

    // 버튼을 눌러도 입력란의 선택 영역이 풀리지 않게 한다
    toolbar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.cmd) exec(b.dataset.cmd);
      else if (b.dataset.bg != null) exec('hiliteColor', b.dataset.bg ? PALETTE[b.dataset.bg] : 'transparent');
      else if (b.dataset.size) exec('fontSize', currentSize() === b.dataset.size ? '3' : SIZE_TO_FONT[b.dataset.size]); // 같은 크기를 다시 누르면 보통으로
      else if (b.id === 'btnClearFmt') { exec('hiliteColor', 'transparent'); exec('removeFormat'); }
      else if (b.id === 'btnCode') setCodeMode(!codeMode);
    });
    document.addEventListener('selectionchange', refreshToolbar);

    input.addEventListener('keydown', (e) => {
      // Enter 전송, Shift+Enter 줄바꿈. 한글 조합 중의 Enter는 전송하지 않는다
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); onSend(); }
    });
    input.addEventListener('input', () => { if (!input.textContent && !input.querySelector('br + br')) input.replaceChildren(); });
    input.addEventListener('paste', (e) => {
      // 다른 프로그램의 서식은 버리고 글자만 붙인다. 여러 줄 코드·쿼리면 코드 입력으로 자동 전환
      e.preventDefault();
      const text = (e.clipboardData.getData('text/plain') || '').replace(/\r\n?/g, '\n');
      if (!text) return;
      const lang = text.includes('\n') && !input.textContent.trim() ? detectLang(text) : null;
      if (lang) setCodeMode(true, text, `${LANG_LABEL[lang]}(으)로 인식했습니다`);
      else document.execCommand('insertText', false, text);
    });
    input.addEventListener('drop', (e) => e.preventDefault());

    codeInput.addEventListener('input', growCode);
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSend(); }
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    });
  }

  return { init, getContent, clear, focus, renderRich, detectLang, setCodeMode };
})();
