@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "HOOK_SCRIPT=%SCRIPT_DIR%run_asset_hook.sh"

if not exist "%HOOK_SCRIPT%" (
  echo Asset hook launcher script not found: %HOOK_SCRIPT% 1>&2
  exit /b 127
)

set "GIT_BASH="
if defined CODEX_ASSET_BASH if exist "%CODEX_ASSET_BASH%" set "GIT_BASH=%CODEX_ASSET_BASH%"
if not defined GIT_BASH if exist "%ProgramFiles%\Git\bin\bash.exe" set "GIT_BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined GIT_BASH if exist "%ProgramFiles%\Git\usr\bin\bash.exe" set "GIT_BASH=%ProgramFiles%\Git\usr\bin\bash.exe"
if not defined GIT_BASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "GIT_BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined GIT_BASH (
  for /f "delims=" %%I in ('where bash.exe 2^>nul') do (
    echo %%I | findstr /I /C:"\Windows\System32\bash.exe" >nul
    if errorlevel 1 if not defined GIT_BASH set "GIT_BASH=%%I"
  )
)

if not defined GIT_BASH (
  echo Git Bash not found. Install Git for Windows or set CODEX_ASSET_BASH. 1>&2
  exit /b 127
)

"%GIT_BASH%" "%HOOK_SCRIPT%"
exit /b %ERRORLEVEL%
