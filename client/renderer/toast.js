// 알림 팝업: 아래에서 올라와 잠시 머문 뒤 아래로 내려간다
'use strict';
const q = new URLSearchParams(location.search);
const toast = document.getElementById('toast');
const stay = Number(q.get('ms')) || 5000;
const slide = Number(q.get('slide')) || 300;
document.getElementById('title').textContent = q.get('title') || '';
document.getElementById('body').textContent = q.get('body') || '';
toast.style.setProperty('--slide', `${slide}ms`);
toast.onclick = () => window.api.toastClick();
requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('in')));
setTimeout(() => toast.classList.add('out'), slide + stay);
