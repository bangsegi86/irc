@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 22 이상 버전을 설치해 주세요.
  pause
  exit /b 1
)

if not exist node_modules\electron (
  echo 처음 실행: 필요한 구성 요소를 설치합니다. 몇 분 걸릴 수 있습니다...
  call npm install
)

rem 서버 화면을 엽니다. 포트·암호·기록 등 모든 설정은 화면의 '설정'에서 바꿉니다.
call npm run gui
