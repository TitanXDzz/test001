@echo off
echo ============================================
echo   Medical Symptom Diagnosis Chatbot
echo ============================================
echo.

cd /d "%~dp0"

echo [1/3] Checking Node.js...
node --version
if errorlevel 1 (
    echo ERROR: Node.js not found. Please install from https://nodejs.org
    pause
    exit /b 1
)

echo [2/3] Installing dependencies...
npm install

echo [3/3] Starting server (browser will open automatically)...
echo.
node server.js

pause
