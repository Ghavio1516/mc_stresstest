@echo off
title Minecraft Performance Tester

echo 🎮 Minecraft Server Performance Tester
echo ======================================

:: Check Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python not found! Download from: https://python.org
    pause
    exit /b 1
)

:: Install mcrcon if needed (optional for real TPS monitoring)
echo 📦 Checking dependencies...
pip install mcrcon >nul 2>&1

:: Create results folder
mkdir results 2>nul

:: Run the tester
echo 🚀 Starting Performance Tester...
python minecraft_tester.py

pause
