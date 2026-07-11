@echo off
setlocal EnableExtensions

set "HOOK_DIR=%~dp0"
set "SESSION_START=%HOOK_DIR%session-start-codex"

if not exist "%SESSION_START%" (
    echo superpowers Codex SessionStart recovery script is missing: "%SESSION_START%" >&2
    exit /b 1
)

if exist "C:\Program Files\Git\bin\bash.exe" (
    "C:\Program Files\Git\bin\bash.exe" "%SESSION_START%"
    exit /b %ERRORLEVEL%
)

if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    "C:\Program Files (x86)\Git\bin\bash.exe" "%SESSION_START%"
    exit /b %ERRORLEVEL%
)

echo superpowers Codex SessionStart recovery requires Git Bash at a supported Git for Windows location. >&2
exit /b 1
