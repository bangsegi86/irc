# 사랑방 (Sarangbang)

개인 PC에서 켜는 IRC형 채팅. 서버는 글자 메시지만 보관하고, 파일·이미지는 서버에 저장하지 않고 보낸 사람 PC에서 받는 사람 PC로 바로 넘깁니다.

설계 문서: [docs/DESIGN.md](docs/DESIGN.md)

## 준비물

[Node.js](https://nodejs.org) 22.13 이상 (서버 PC와 클라이언트 PC 모두)

## 서버 켜기

`server\start-server.bat` 를 더블클릭합니다. 창에 표시되는 주소(`ws://...:7070`)를 참여자에게 알려 주세요.
접속 암호, 포트, 메시지 보관 기간은 `start-server.bat` 안에서 바꿉니다. 데이터는 `server\data` 폴더에 쌓입니다.

## 클라이언트 켜기

`client\start-client.bat` 를 더블클릭합니다. 서버 주소·닉네임·비밀번호를 넣고 처음이면 "새로 가입"을 누릅니다.

설치 파일(.exe) 만들기: `client` 폴더에서 `npm install` 후 `npm run dist` → `client\dist` 에 생성됩니다.

## 테스트

```
cd server && npm install && npm test          # 서버 통합 테스트
```

클라이언트 자동 점검(서버를 `PORT=7171` 로 켠 상태에서):

```
cd client && npm install && npx electron test/smoke.js
```

## 브랜치

| 브랜치 | 용도 |
|---|---|
| `release` | 배포 버전 (테스트 합격분만, 버전 태그) |
| `develop` | 개발 통합 |
| `feature/*` | 기능별 작업 → `develop` 으로 합침 |
