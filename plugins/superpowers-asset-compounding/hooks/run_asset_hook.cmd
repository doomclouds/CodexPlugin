@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "HOOK_SCRIPT=%SCRIPT_DIR%asset_hook.py"

if not exist "%HOOK_SCRIPT%" (
  echo Asset hook script not found: %HOOK_SCRIPT% 1>&2
  exit /b 127
)

set "PYTHON_EXE="
if defined CODEX_ASSET_PYTHON call :try_python "%CODEX_ASSET_PYTHON%"
if not defined PYTHON_EXE (
  for %%P in (
    "%LOCALAPPDATA%\Python\bin\python.exe"
    "%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe"
    "%LOCALAPPDATA%\Python\pythoncore-3.13-64\python.exe"
    "%LOCALAPPDATA%\Python\pythoncore-3.12-64\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python314\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%ProgramFiles%\Python314\python.exe"
    "%ProgramFiles%\Python313\python.exe"
    "%ProgramFiles%\Python312\python.exe"
  ) do (
    if not defined PYTHON_EXE call :try_python "%%~fP"
  )
)
if not defined PYTHON_EXE (
  for /f "delims=" %%I in ('where python.exe 2^>nul') do (
    if not defined PYTHON_EXE call :try_python "%%I"
  )
)

if defined PYTHON_EXE (
  set "ASSET_HOOK_LAUNCHER=windows-direct"
  set "PYTHONIOENCODING=utf-8"
  "%PYTHON_EXE%" -X utf8 "%HOOK_SCRIPT%"
  exit /b %ERRORLEVEL%
)

set "FALLBACK_HOOK_SCRIPT=%SCRIPT_DIR%run_asset_hook.sh"
if not exist "%FALLBACK_HOOK_SCRIPT%" (
  echo Asset hook fallback script not found: %FALLBACK_HOOK_SCRIPT% 1>&2
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
  echo No real Python interpreter or Git Bash fallback found. Set CODEX_ASSET_PYTHON or CODEX_ASSET_BASH. 1>&2
  exit /b 127
)

set "ASSET_HOOK_LAUNCHER=windows-git-bash"
"%GIT_BASH%" "%FALLBACK_HOOK_SCRIPT%"
exit /b %ERRORLEVEL%

:try_python
set "CANDIDATE=%~1"
if "%CANDIDATE%"=="" exit /b 0
if not exist "%CANDIDATE%" exit /b 0
echo "%CANDIDATE%" | findstr /I /C:"\WindowsApps\" >nul
if not errorlevel 1 exit /b 0
set "PYTHON_EXE=%CANDIDATE%"
exit /b 0
