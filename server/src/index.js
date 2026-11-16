// 사랑방 서버 실행 파일
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { startServer } from './server.js';

const port = Number(process.env.PORT) || 7070;
const dbPath = resolve(process.env.DATA_DIR || './data', 'sarangbang.db');
mkdirSync(dirname(dbPath), { recursive: true });

const server = startServer({
  port,
  dbPath,
  serverPassword: process.env.SERVER_PASSWORD || '',
  retentionDays: Number(process.env.RETENTION_DAYS) || 0,
});

server.ready.then(() => {
  console.log('사랑방 서버가 켜졌습니다.');
  console.log(`  데이터 위치 : ${dbPath}`);
  console.log(`  접속 암호   : ${process.env.SERVER_PASSWORD ? '설정됨' : '없음'}`);
  console.log('  클라이언트에 입력할 주소:');
  console.log(`    이 PC에서      ws://localhost:${port}`);
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) console.log(`    같은 네트워크  ws://${ni.address}:${port}`);
  }
  console.log('끄려면 Ctrl+C 를 누르세요.');
}).catch((e) => {
  console.error(e.code === 'EADDRINUSE' ? `포트 ${port}를 다른 프로그램이 쓰고 있습니다. PORT 값을 바꿔 주세요.` : e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close().then(() => process.exit(0)));
