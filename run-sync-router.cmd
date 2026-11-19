@echo off
rem ============================================================
rem  run-sync-router.cmd - pembungkus sync-router.js
rem  Dipakai Scheduled Task (tiap 1 menit):
rem    NetflowSyncRouter -> run-sync-router.cmd
rem  Log: C:\netflow-monitor\logs\sync-router.log
rem ============================================================
setlocal
cd /d "C:\netflow-monitor"

if not exist "logs" mkdir "logs"

rem Rotasi sederhana: kalau log sudah lewat 20 MB, ganti nama jadi .old
if exist "logs\sync-router.log" for %%F in ("logs\sync-router.log") do if %%~zF GEQ 20971520 (
  move /y "logs\sync-router.log" "logs\sync-router.old.log" >nul 2>&1
)

echo.>> "logs\sync-router.log"
echo ==== mulai %DATE% %TIME% ====>> "logs\sync-router.log"

node --env-file-if-exists=.env sync-router.js >> "logs\sync-router.log" 2>&1

echo ==== berhenti %DATE% %TIME% (kode %ERRORLEVEL%) ====>> "logs\sync-router.log"
exit /b %ERRORLEVEL%