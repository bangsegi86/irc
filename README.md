# 사랑방 (Sarangbang)

개인 PC에서 켜는 IRC형 채팅. 서버는 글자 메시지만 보관하고, 파일·이미지는 서버에 저장하지 않습니다. 두 PC가 직접 주고받고(P2P), 직접 연결이 안 되면 서버를 통과만 시켜 넘깁니다.

설계 문서: [docs/DESIGN.md](docs/DESIGN.md)

## 준비물

[Node.js](https://nodejs.org) 22.13 이상 (서버 PC와 클라이언트 PC 모두)

## 서버 켜기

`server\start-server-gui.bat` 를 더블클릭하면 **서버 화면**이 열립니다. 화면에 표시되는 주소를 참여자에게 알려 주세요.

- 시작/중지, 접속 주소 복사, 지금 접속한 사람, 실시간 기록(로그)을 화면에서 봅니다.
- 포트, 접속 암호, 기록 켜기/끄기, 보관 기간은 화면의 '설정'에서 바꿉니다. 파일을 고칠 필요가 없습니다.
- 창을 닫아도 서버는 트레이에서 계속 돕니다. 완전히 끄려면 트레이 아이콘 우클릭 → 종료.
- 데이터는 `server\data` 폴더에 쌓입니다.

화면 없이 검은 창으로만 돌리려면 `server\start-server.bat` 을 씁니다(설정은 그 파일 안에서).

## 클라이언트 켜기

`client\start-client.bat` 를 더블클릭합니다. 서버 주소·닉네임·비밀번호를 넣고 처음이면 "새로 가입"을 누릅니다.

**혼자 시험하기:** 한 PC에서 `start-client.bat` 과 `start-client-2.bat` 을 둘 다 실행하면 클라이언트가 두 개 뜹니다. 서로 다른 닉네임으로 가입해 대화·초대·파일 전송을 시험할 수 있습니다.

설치 파일(.exe) 만들기: `client` 폴더에서 `npm install` 후 `npm run dist` → `client\dist` 에 생성됩니다.

## 테스트

```
cd server && npm install && npm test          # 서버 통합 테스트
cd server && npx electron gui-test/smoke.mjs   # 서버 화면 자동 점검
```

클라이언트 자동 점검(서버를 `PORT=7171` 로 켠 상태에서):

```
cd client && npm install && npx electron test/smoke.js
```

P2P 직접 전송 점검은 클라이언트 두 개를 띄웁니다(방법은 `client/test/smoke-p2p.js` 첫머리 참고).

## 브랜치

| 브랜치 | 용도 |
|---|---|
| `release` | 배포 버전 (테스트 합격분만, 버전 태그) |
| `develop` | 개발 통합 |
| `feature/*` | 기능별 작업 → `develop` 으로 합침 |
