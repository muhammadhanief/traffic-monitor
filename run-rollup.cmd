@echo off
rem ============================================================
rem  run-rollup.cmd - pembungkus rollup.js
rem  Dipakai Scheduled Task:
rem    NetflowRollupHourly -> run-rollup.cmd --hourly   (tiap jam)
rem    NetflowRollupDaily  -> run-rollup.cmd --daily    (00:15)
rem  Log: C:\netflow-monitor\logs\rollup.log
rem ============================================================
setlocal
cd /d "C:\netflow-monitor"

if not exist "logs" mkdir "logs"

rem Rotasi sederhana: kalau log sudah lewat 20 MB, ganti nama jadi .old
if exist "logs\rollup.log" for %%F in ("logs\rollup.log") do if %%~zF GEQ 20971520 (
  move /y "logs\rollup.log" "logs\rollup.old.log" >nul 2>&1
)

echo.>> "logs\rollup.log"
echo ==== mulai %DATE% %TIME% mode=%1 ====>> "logs\rollup.log"

node --env-file-if-exists=.env rollup.js %1 >> "logs\rollup.log" 2>&1

echo ==== berhenti %DATE% %TIME% (kode %ERRORLEVEL%) ====>> "logs\rollup.log"
exit /b %ERRORLEVEL%