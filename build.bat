@echo off
setlocal
REM Deep Desk — Windows Tauri build script
REM Run from project root (where this file is)

echo ========================================
echo   Deep Desk Windows Build
echo ========================================

REM Step 0: Ensure bun binary is in place
echo [0/4] Checking bun binary...
set "BUN_DIR=src-tauri\binaries\bun-windows-x64"
if not exist "%BUN_DIR%\bun.exe" (
    echo   bun.exe not found, attempting download...
    mkdir "%BUN_DIR%" 2>nul
    curl -fsSL -o "%TEMP%\bun-windows-x64.zip" "https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip"
    if %ERRORLEVEL% neq 0 (
        echo   Download failed, checking local bun installation...
        for /f "delims=" %%i in ('where bun 2^>nul') do set "LOCAL_BUN=%%i"
        if defined LOCAL_BUN (
            copy /y "%LOCAL_BUN%" "%BUN_DIR%\bun.exe" >nul
            echo   ^✓ copied from local installation
        ) else (
            echo   ERROR: Cannot obtain bun binary. Place bun.exe at %BUN_DIR%\bun.exe
            exit /b 1
        )
    ) else (
        powershell -Command "Expand-Archive -Path '%TEMP%\bun-windows-x64.zip' -DestinationPath '%BUN_DIR%\' -Force"
        if %ERRORLEVEL% neq 0 (
            echo   ERROR: Failed to extract bun binary
            exit /b 1
        )
        del "%TEMP%\bun-windows-x64.zip" 2>nul
        echo   ^✓ bun.exe downloaded
    )
) else (
    echo   ^✓ bun.exe found
)

REM Step 1: Build frontend
echo [1/4] Building frontend...
cd web
call bun install
if %ERRORLEVEL% neq 0 (echo ERROR: bun install failed && exit /b 1)
call bun run build
if %ERRORLEVEL% neq 0 (echo ERROR: web build failed && exit /b 1)
cd ..
echo   ^✓ Frontend built

REM Step 2: Build Tauri
echo [2/4] Building Tauri...
cd src-tauri
set TAURI_SIGNING_PRIVATE_KEY=
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
call cargo tauri build --target x86_64-pc-windows-msvc
if %ERRORLEVEL% neq 0 (echo ERROR: Tauri build failed && exit /b 1)
cd ..
echo   ^✓ Tauri build complete

REM Step 3: Show output
echo [3/4] Done!
echo.
echo Output files:
dir /s /b src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\*.msi 2>nul
dir /s /b src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\*.exe 2>nul
echo.
echo MSI installer ready for upload to CDN.
pause
endlocal
