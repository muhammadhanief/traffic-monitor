@echo off
rem ============================================================
rem  run-ingest.cmd - pembungkus untuk menjalankan ingest.js
rem  Dipakai oleh Scheduled Task "NetflowIngest" (24/7).
rem  Log: C:\netflow-monitor\logs\ingest.log
rem ============================================================
setlocal
cd /d "C:\netflow-monitor"

rem Bersihkan goflow2 yang tertinggal dari proses sebelumnya.
rem Kalau tidak, port UDP 2055 tetap terkunci dan start baru gagal.
taskkill /IM goflow2-2.2.7-windows-amd64.exe /F >nul 2>&1

if not exist "logs" mkdir "logs"

rem Rotasi sederhana: kalau log sudah lewat 20 MB, ganti nama jadi .old
if exist "logs\ingest.log" for %%F in ("logs\ingest.log") do if %%~zF GEQ 20971520 (
  move /y "logs\ingest.log" "logs\ingest.old.log" >nul 2>&1
)

echo.>> "logs\ingest.log"
echo ==== mulai %DATE% %TIME% ====>> "logs\ingest.log"

rem --env-file-if-exists=.env -> baca DB_HOST/USER/PASSWORD dari .env
node --env-file-if-exists=.env ingest.js >> "logs\ingest.log" 2>&1

rem Kalau node keluar (crash / MySQL mati), catat lalu keluar dengan kode error
rem supaya Scheduled Task tahu ini gagal dan menyalakan ulang.
echo ==== berhenti %DATE% %TIME% (kode %ERRORLEVEL%) ====>> "logs\ingest.log"
exit /b %ERRORLEVEL%