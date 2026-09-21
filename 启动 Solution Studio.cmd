@echo off
cd /d "%~dp0"
if not exist node_modules (
  call npm ci
  if errorlevel 1 goto fail
)
if not exist .env copy .env.example .env >nul
call npm run build
if errorlevel 1 goto fail
echo Solution Studio: http://127.0.0.1:4310
call npm start
:fail
pause
