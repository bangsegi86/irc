// 메시지 입력기: 보이는 대로 편집(굵게·기울임·밑줄·취소선·배경색·크기) + 입력란 안에 넣는 코드 블록
// 한 메시지에 서식 글자와 코드 블록을 함께 쓸 수 있다.
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

  let input, toolbar, langSel, hint, codeBtn, onSend;
  let activePre = null; // 마지막으로 커서가 있던 코드 블록(언어 선택 대상)
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
  // 코드 블록(<pre>) 안의 글자: 줄바꿈 태그는 줄바꿈 글자로
  function preText(pre) {
    let out = '';
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) out += child.data;
        else if (child.tagName === 'BR') out += '\n';
        else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.tagName === 'DIV' && out && !out.endsWith('\n')) out += '\n';
          walk(child);
        }
      }
    })(pre);
    return out.replace(/\s+$/, '');
  }

  function serialize() {
    const nodes = [];
    const push = (s, f) => {
      const last = nodes[nodes.length - 1];
      const same = last && last.t !== 'code' && ['b', 'i', 'u', 'x', 'bg', 'sz'].every((k) => last[k] === f[k]);
      if (same) last.s += s; else nodes.push({ s, ...f });
    };
    const needsBreak = () => { const last = nodes[nodes.length - 1]; return !!last && last.t !== 'code' && !last.s.endsWith('\n'); };
    (function walk(node, f) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { if (child.data) push(child.data, f); continue; }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName;
        if (tag === 'BR') { push('\n', {}); continue; }
        if (tag === 'PRE') { // 코드 블록
          const text = preText(child);
          if (text.trim()) nodes.push({ t: 'code', lang: child.dataset.lang === 'auto' ? detectLang(text) || 'text' : child.dataset.lang, text });
          continue;
        }
        const g = { ...f };
        if (tag === 'B' || tag === 'STRONG') g.b = 1;
        if (tag === 'I' || tag === 'EM') g.i = 1;
        if (tag === 'U') g.u = 1;
        if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') g.x = 1;
        if (tag === 'FONT' && child.size) { const sz = FONT_TO_SIZE[child.size]; if (sz) g.sz = sz; else delete g.sz; }
        const bg = child.style?.backgroundColor;
        if (bg) { if (colorKey[bg]) g.bg = colorKey[bg]; else delete g.bg; }
        if ((tag === 'DIV' || tag === 'P') && needsBreak()) push('\n', {});
        walk(child, g);
      }
    })(input, {});

    // 정리: 맨 앞·맨 뒤, 그리고 코드 블록과 맞닿은 쪽의 빈 줄을 없앤다(블록 자체가 줄을 나눈다)
    const isRun = (n) => n && n.t !== 'code';
    nodes.forEach((n, i) => {
      if (!isRun(n)) return;
      if (i === 0 || !isRun(nodes[i - 1])) n.s = i === 0 ? n.s.trimStart() : n.s.replace(/^\n+/, '');
      if (i === nodes.length - 1 || !isRun(nodes[i + 1])) n.s = i === nodes.length - 1 ? n.s.trimEnd() : n.s.replace(/\n+$/, '');
    });
    let out = nodes.filter((n) => !isRun(n) || n.s);
    while (out.length && isRun(out[0]) && !out[0].s.trim()) out.shift();
    while (out.length && isRun(out[out.length - 1]) && !out[out.length - 1].s.trim()) out.pop();
    if (isRun(out[0])) out[0].s = out[0].s.trimStart();
    if (isRun(out[out.length - 1])) out[out.length - 1].s = out[out.length - 1].s.trimEnd();
    out = out.filter((n) => !isRun(n) || n.s);
    return out.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v)));
  }

  // 보낼 내용: { text } (서식 없음) 또는 { rich } (서식·코드 포함). 비어 있으면 null
  function getContent() {
    const nodes = serialize();
    if (!nodes.length) return null;
    return nodes.some((n) => n.t === 'code' || Object.keys(n).length > 1) ? { rich: nodes } : { text: nodes.map((n) => n.s).join('') };
  }

  // ---------- 서식 버튼 ----------
  function exec(cmd, value) {
    input.focus();
    document.execCommand(cmd, false, value);
    refreshToolbar();
  }

  const selectionNode = () => { const n = document.getSelection()?.anchorNode; return n && input.contains(n) ? n : null; };

  // 커서가 들어 있는 코드 블록(없으면 null)
  function currentPre() {
    for (let n = selectionNode(); n && n !== input; n = n.parentNode) if (n.tagName === 'PRE') return n;
    return null;
  }

  // 커서 위치의 글자 크기(작게/크게/아주 크게). 보통이면 null
  function currentSize() {
    for (let n = selectionNode(); n && n !== input; n = n.parentNode) {
      if (n.tagName === 'FONT' && n.size) return FONT_TO_SIZE[n.size] || null;
    }
    return null;
  }

  function refreshToolbar() {
    const inside = !!selectionNode();
    const pre = currentPre();
    if (pre) activePre = pre;
    for (const b of toolbar.querySelectorAll('[data-cmd]')) b.classList.toggle('on', inside && !pre && document.queryCommandState(b.dataset.cmd));
    const size = inside && !pre ? currentSize() : null;
    for (const b of toolbar.querySelectorAll('[data-size]')) b.classList.toggle('on', b.dataset.size === size);
    // 코드 블록 안에서는 글자 서식 대신 언어 선택을 보여 준다
    const inCode = !!pre || document.activeElement === langSel;
    toolbar.classList.toggle('codeMode', inCode);
    codeBtn.classList.toggle('on', inCode);
    codeBtn.textContent = inCode ? '코드 밖으로' : '</> 코드';
    langSel.hidden = !inCode;
    if (pre) langSel.value = pre.dataset.lang;
    hint.textContent = inCode ? "코드 블록 안 — Enter 줄바꿈 · Ctrl+Enter 전송 · '코드 밖으로' 버튼이나 ↓ 키로 블록을 벗어나 글을 이어 씁니다." : '';
  }

  function setLang(pre, lang) {
    pre.dataset.lang = lang;
    pre.dataset.label = lang === 'auto' ? '코드 · 언어 자동 인식' : `코드 · ${LANG_LABEL[lang]}`;
  }

  function placeCaret(node, atStart) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(!!atStart);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 커서 위치에 코드 블록을 넣는다. 선택한 글자가 있으면 그 글자가 코드가 된다.
  function insertCode(text = '', lang = 'auto') {
    input.focus();
    const sel = document.getSelection();
    const range = sel.rangeCount && input.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
    let content = text;
    if (range && !range.collapsed) { if (!content) content = range.toString(); range.deleteContents(); }
    const pre = document.createElement('pre');
    pre.className = 'codeEdit';
    pre.spellcheck = false;
    setLang(pre, lang);
    if (content) pre.textContent = content; else pre.append(document.createElement('br'));

    const at = range ? range.startContainer : null;
    if (!at) input.append(pre);
    else if (at === input || (at.nodeType === Node.TEXT_NODE && at.parentNode === input)) range.insertNode(pre); // 글 중간이면 그 자리에서 나눈다
    else { let top = at; while (top.parentNode !== input) top = top.parentNode; top.after(pre); }           // 서식 안이면 그 줄 뒤에
    for (const side of [pre.previousSibling, pre.nextSibling]) if (side?.nodeType === Node.TEXT_NODE && !side.data) side.remove();
    if (!pre.nextSibling) input.append(document.createElement('br')); // 블록 뒤에 글을 이어 쓸 자리
    placeCaret(pre, !content);
    activePre = pre;
    refreshToolbar();
    return pre;
  }

  // 코드 블록을 벗어나 그 뒤에서 글을 이어 쓴다
  function exitCode(pre) {
    if (!pre.nextSibling) input.append(document.createElement('br'));
    const range = document.createRange();
    range.setStartAfter(pre);
    range.collapse(true);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    input.focus();
    refreshToolbar();
  }

  function clear() {
    input.replaceChildren();
    activePre = null;
    refreshToolbar();
  }
  const focus = () => input.focus();

  // 붙여넣은 내용이 이미지인 경우 그 파일들(글자가 함께 들어 있으면 글자를 우선한다 — 예: 엑셀 셀 복사)
  function imagesIn(e) {
    const images = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    return images.length && !e.clipboardData.getData('text/plain') ? images : [];
  }

  function init(opts) {
    onSend = opts.onSend;
    input = document.getElementById('input');
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
      if (b.id === 'btnCode') { const pre = currentPre() || (document.activeElement === langSel ? activePre : null); if (pre) exitCode(pre); else insertCode(); return; }
      if (currentPre()) return; // 코드 블록 안에서는 글자 서식을 쓰지 않는다
      if (b.dataset.cmd) exec(b.dataset.cmd);
      else if (b.dataset.bg != null) exec('hiliteColor', b.dataset.bg ? PALETTE[b.dataset.bg] : 'transparent');
      else if (b.dataset.size) exec('fontSize', currentSize() === b.dataset.size ? '3' : SIZE_TO_FONT[b.dataset.size]); // 같은 크기를 다시 누르면 보통으로
      else if (b.id === 'btnClearFmt') { exec('hiliteColor', 'transparent'); exec('removeFormat'); }
    });
    langSel.addEventListener('change', () => {
      if (activePre?.isConnected) { setLang(activePre, langSel.value); input.focus(); placeCaret(activePre, false); }
      refreshToolbar();
    });
    langSel.addEventListener('blur', refreshToolbar);
    document.addEventListener('selectionchange', refreshToolbar);

    input.addEventListener('keydown', (e) => {
      const pre = currentPre();
      if (e.key === 'Enter' && !e.isComposing) { // 한글 조합 중의 Enter는 건드리지 않는다
        if (pre && !(e.ctrlKey || e.metaKey)) { e.preventDefault(); document.execCommand('insertLineBreak'); return; } // 코드 안: 줄바꿈
        if (pre || !e.shiftKey) { e.preventDefault(); onSend(); }                                                  // 그 밖: Enter 전송, Shift+Enter 줄바꿈
        return;
      }
      if (!pre) return;
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
      if (e.key === 'Backspace' && !preText(pre)) { e.preventDefault(); const next = pre.nextSibling; pre.remove(); if (next?.isConnected) placeCaret(next, true); cleanup(); refreshToolbar(); } // 빈 블록은 지운다
    });
    const cleanup = () => { if (!input.textContent && !input.querySelector('pre, br + br')) input.replaceChildren(); };
    input.addEventListener('input', cleanup);
    input.addEventListener('paste', (e) => {
      if (imagesIn(e).length) return; // 이미지는 화면 쪽에서 미리보기로 처리한다
      // 다른 프로그램의 서식은 버리고 글자만 붙인다
      e.preventDefault();
      const text = (e.clipboardData.getData('text/plain') || '').replace(/\r\n?/g, '\n');
      if (!text) return;
      const pre = currentPre();
      if (pre) { // 코드 블록 안: 줄바꿈까지 그대로
        const range = document.getSelection().getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        return;
      }
      // 여러 줄 코드·쿼리면 그 자리에 코드 블록으로 넣는다
      const lang = text.includes('\n') ? detectLang(text) : null;
      if (lang) insertCode(text, lang);
      else document.execCommand('insertText', false, text);
    });
    input.addEventListener('drop', (e) => e.preventDefault());
  }

  return { init, getContent, clear, focus, renderRich, detectLang, insertCode, imagesIn };
})();
