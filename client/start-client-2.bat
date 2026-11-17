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
  echo 처음 실행: 필요한 구성 요소를 설치합니다. 몇 분 걸릴 수 있습니다...
  call npm install
)
rem 테스트용 두 번째 클라이언트: 로그인 정보를 따로 써서, 한 PC에서 계정 두 개로 대화를 시험할 수 있습니다.
set SARANGBANG_PROFILE=2
call npm start
