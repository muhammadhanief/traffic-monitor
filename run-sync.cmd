@echo off
rem ============================================================
rem  run-sync.cmd - pembungkus sync-mikrotik.js
rem  Dipakai Scheduled Task (mis. tiap 5 menit):
rem    NetflowSyncMikrotik -> run-sync.cmd
rem  Log: C:\netflow-monitor\logs\sync.log
rem ============================================================
setlocal
cd /d "C:\netflow-monitor"

if not exist "logs" mkdir "logs"

rem Rotasi sederhana: kalau log sudah lewat 20 MB, ganti nama jadi .old
if exist "logs\sync.log" for %%F in ("logs\sync.log") do if %%~zF GEQ 20971520 (
  move /y "logs\sync.log" "logs\sync.old.log" >nul 2>&1
)

echo.>> "logs\sync.log"
echo ==== mulai %DATE% %TIME% ====>> "logs\sync.log"

node --env-file-if-exists=.env sync-mikrotik.js >> "logs\sync.log" 2>&1

echo ==== berhenti %DATE% %TIME% (kode %ERRORLEVEL%) ====>> "logs\sync.log"
exit /b %ERRORLEVEL%
