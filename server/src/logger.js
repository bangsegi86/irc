// 서버 기록(로그): 누가·어디서·무엇을 했는지 남긴다. 메시지 내용과 파일 이름은 남기지 않는다.
// 서버 창에 보여 주고, 날짜별 파일(logs/2026-11-16.log)로 저장한다.
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const two = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const timeOf = (d) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

export function createLogger({ enabled = false, dir = null, days = 14, echo = true } = {}) {
  if (!enabled) return { enabled: false, log() {}, close() {} };
  if (dir) mkdirSync(dir, { recursive: true });

  // 보관 기간이 지난 기록 파일 삭제
  const sweep = () => {
    if (!dir || !(days > 0)) return;
    const limit = dayOf(new Date(Date.now() - days * 86_400_000));
    for (const name of readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (m && m[1] < limit) { try { unlinkSync(join(dir, name)); } catch { /* 다음에 다시 시도 */ } }
    }
  };
  sweep();
  const timer = setInterval(sweep, 6 * 3_600_000);
  timer.unref();

  return {
    enabled: true,
    // kind: 종류(접속, 로그인 등), fields: { ip, 닉네임, ... } — 값이 없는 항목은 생략
    log(kind, fields = {}) {
      const now = new Date();
      const detail = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ')}`).join('  ');
      const line = `${dayOf(now)} ${timeOf(now)}  [${kind}]  ${detail}`;
      if (echo) console.log(line);
      if (dir) { try { appendFileSync(join(dir, `${dayOf(now)}.log`), `${line}\n`); } catch (e) { console.error('기록 파일에 쓰지 못했습니다.', e.message); } }
    },
    close() { clearInterval(timer); },
  };
}
