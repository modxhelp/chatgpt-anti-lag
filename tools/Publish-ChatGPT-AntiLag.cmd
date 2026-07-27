@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0Publish-ChatGPT-AntiLag.ps1" (
  echo ERROR: Publish-ChatGPT-AntiLag.ps1 was not found.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Publish-ChatGPT-AntiLag.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Publication failed. Review the error message above.
  pause
  exit /b %EXIT_CODE%
)

echo.
echo Publication completed successfully.
pause
exit /b 0
