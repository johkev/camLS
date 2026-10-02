@echo off
set "PROJECT_DIR=%~dp0"

start "Lænsmann Camera backend" powershell -NoExit -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%PROJECT_DIR%'; npm run dev --workspace @lensmann-camera/backend"
start "Lænsmann Camera frontend" powershell -NoExit -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%PROJECT_DIR%'; npm run dev --workspace @lensmann-camera/frontend"

timeout /t 5 /nobreak >nul
start "" "http://localhost:5173/"
