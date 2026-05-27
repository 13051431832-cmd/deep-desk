@echo off
REM Deep Desk — Windows Tauri build script
REM Run from project root (where this file is)

echo ========================================
echo   Deep Desk Windows Build
echo ========================================

REM Step 1: Build frontend
echo [1/3] Building frontend...
cd web
call bun install
call bun run build
cd ..
echo   Frontend built

REM Step 2: Build Tauri
echo [2/3] Building Tauri (this takes a few minutes)...
cd src-tauri
set TAURI_SIGNING_PRIVATE_KEY=
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
call cargo tauri build --target x86_64-pc-windows-msvc
cd ..
echo   Tauri build complete

REM Step 3: Show output
echo [3/3] Done!
echo.
echo Output files:
dir /s /b src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\*.msi 2>nul
dir /s /b src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\*.exe 2>nul
echo.
echo MSI installer ready for upload to CDN.
pause
