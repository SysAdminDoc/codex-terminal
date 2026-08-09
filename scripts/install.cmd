@echo off
setlocal enabledelayedexpansion
rem Installs a Codex Terminal .vsix into every VS Code family editor found on this machine.
rem
rem Exists because double-clicking a .vsix on Windows hands it to Visual Studio's VSIX
rem Installer (the .vsix file association), which refuses VS Code extensions with
rem "not successful for all the selected products". A .vsix is an archive the editor
rem unpacks, not an installer - it has to be passed to the editor's own CLI.
rem
rem Usage: double-click this file, or: install.cmd "C:\path\to\codex-terminal-0.3.0.vsix"

title Codex Terminal - install

set "VSIX=%~1"
if "%VSIX%"=="" (
    for %%F in ("%~dp0*.vsix") do set "VSIX=%%~fF"
)
if "%VSIX%"=="" (
    for %%F in ("%~dp0..\dist\*.vsix") do set "VSIX=%%~fF"
)

if "%VSIX%"=="" (
    echo [ERROR] No .vsix found next to this script or in ..\dist.
    echo         Pass one explicitly:  install.cmd "C:\path\to\codex-terminal-0.3.0.vsix"
    echo.
    pause
    exit /b 1
)
if not exist "%VSIX%" (
    echo [ERROR] Not found: %VSIX%
    echo.
    pause
    exit /b 1
)

echo Installing: %VSIX%
echo.

set "FOUND=0"
call :install "codium" "VSCodium"
call :install "code"   "Visual Studio Code"
call :install "code-insiders" "VS Code Insiders"
call :install "cursor" "Cursor"

if "%FOUND%"=="0" (
    echo [ERROR] No VS Code family editor found on PATH.
    echo         Open the editor, then: Extensions view -^> ... -^> Install from VSIX...
    echo.
    pause
    exit /b 1
)

echo.
echo Done. Reload the editor window ^(Command Palette -^> Developer: Reload Window^)
echo and the Codex button appears in the status bar.
echo.
pause
exit /b 0

:install
where %~1 >nul 2>&1
if errorlevel 1 exit /b 0
set "FOUND=1"
echo   %~2 ...
call %~1 --install-extension "%VSIX%" --force
if errorlevel 1 (
    echo   [FAILED] %~2 returned an error.
) else (
    echo   [OK] %~2
)
exit /b 0
