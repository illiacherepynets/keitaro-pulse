@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Keitaro Pulse - оновлення даних
echo ============================================
echo.
node fetch.mjs
if %errorlevel% neq 0 (
  echo.
  echo [X] Помилка. Перевір, що встановлено Node.js ^(node --version^).
  pause
  exit /b 1
)
echo.
echo Відкриваю dashboard.html ...
start "" "dashboard.html"
