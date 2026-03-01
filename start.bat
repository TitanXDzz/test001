@echo off
echo ============================================
echo   Medical Symptom Diagnosis Chatbot
echo ============================================
echo.

cd /d "%~dp0"

echo [1/3] Checking Python...
python --version 2>nul
if errorlevel 1 (
    echo ERROR: Python not found. Please install Python 3.8+
    pause
    exit /b 1
)

echo [2/3] Installing dependencies...
pip install -r requirements.txt -q

echo [3/3] Starting server (browser will open automatically)...
echo.
python app.py

pause
