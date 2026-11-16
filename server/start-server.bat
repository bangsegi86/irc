@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 22 이상 버전을 설치해 주세요.
  pause
  exit /b 1
)

if not exist node_modules (
  echo 처음 실행: 필요한 구성 요소를 설치합니다...
  call npm install --omit=dev
)

rem ---- 설정 (필요하면 값을 바꾸세요) ----
set PORT=7070
rem 접속 암호를 쓰려면 아래 줄의 rem 을 지우고 값을 바꾸세요.
rem set SERVER_PASSWORD=우리끼리암호
rem 오래된 메시지 자동 삭제(일). 0이면 삭제하지 않음.
set RETENTION_DAYS=0

node src/index.js
pause
