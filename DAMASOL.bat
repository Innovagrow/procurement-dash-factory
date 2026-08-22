@echo off
REM ===========================================================================
REM  DAMASOL - Real Estate Opportunity Scanner  (Windows launcher)
REM
REM  Double-click this file. It checks Python, installs what is missing, runs
REM  the scan and opens the results page in your browser.
REM
REM  Messages in this file are kept ASCII on purpose: the batch parser is not
REM  reliable with Greek text. Python prints the Greek, and it sets the console
REM  to UTF-8 first so it renders correctly.
REM ===========================================================================
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===========================================================================
echo   DAMASOL LIMITED - Real Estate Opportunity Scanner
echo ===========================================================================
echo.

REM ---- 1. find Python ------------------------------------------------------
set PY=
py -3 --version >nul 2>&1 && set PY=py -3
if "%PY%"=="" ( python --version >nul 2>&1 && set PY=python )
if "%PY%"=="" (
  echo [!] Python was not found.
  echo.
  echo     Install it from https://www.python.org/downloads/
  echo     IMPORTANT: tick "Add Python to PATH" in the installer.
  echo     Then run this file again.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('%PY% --version 2^>^&1') do echo [1/4] Python found: %%v

REM ---- 2. dependencies -----------------------------------------------------
echo [2/4] Checking dependencies...
%PY% -c "import yaml" >nul 2>&1
if errorlevel 1 (
  echo       installing pyyaml...
  %PY% -m pip install --quiet --disable-pip-version-check pyyaml
)
%PY% -c "import playwright" >nul 2>&1
if errorlevel 1 (
  echo       installing playwright ^(needed to read Spitogatos^)...
  %PY% -m pip install --quiet --disable-pip-version-check playwright
  if errorlevel 1 (
    echo [!] pip failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
%PY% -m playwright install chromium
if errorlevel 1 (
  echo [!] Could not install the browser. The Spitogatos source needs it.
  echo     You can still use option 2 below ^(your own CSV file^).
)

REM ---- 3. what to run ------------------------------------------------------
echo.
echo [3/4] What do you want to analyse?
echo.
echo    1  My own file  ^(akinita.csv in this folder^)          ^(default^)
echo    2  Same, with a price limit I choose
echo    3  Spitogatos - REQUIRES WRITTEN PERMISSION from them
echo.
echo    Note: Spitogatos Terms of Use allow saving content for personal use
echo    only, "by no means for commercial use". Option 3 will explain and
echo    stop unless you confirm you hold their written consent.
echo.
set CHOICE=1
set /p CHOICE=Choose 1, 2 or 3 and press Enter: 

set MAXPRICE=50000
if "%CHOICE%"=="2" (
  REM Parentheses inside an if-block terminate it early, so the prompt is
  REM written without them.
  set /p MAXPRICE=Maximum price in EUR, digits only - then Enter: 
)

set OUTDIR=out
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
REM %DATE% is locale dependent - on a Greek Windows it can start with the day
REM name, which makes substring arithmetic produce nonsense filenames. Python
REM is already required here, so let it produce the stamp.
for /f "tokens=*" %%s in ('%PY% -c "import datetime;print(datetime.date.today().strftime('%%Y%%m%%d'))"') do set STAMP=%%s
if "%STAMP%"=="" set STAMP=latest
set OUTFILE=%OUTDIR%\eukairies_%STAMP%
set HTMLFILE=%OUTDIR%\apotelesmata_%STAMP%.html

echo.
echo [4/4] Analysing. A file takes seconds. A portal scan takes hours,
echo       because it is deliberately slow to avoid overloading the site.
echo.

if "%CHOICE%"=="3" goto portal

if not exist "akinita.csv" (
  echo [!] akinita.csv was not found in this folder.
  echo     Copy akinita_deigma.csv to akinita.csv and edit it, or export
  echo     your own from Excel as CSV UTF-8.
  echo     Columns understood: Timi, Emvadon, Perioxi, Katigoria, Enoikio
  echo     ^(Greek or English headers both work^)
  pause
  exit /b 1
)
%PY% -m damasol.screener --sources csv --csv-path akinita.csv --all-types ^
     --max-price %MAXPRICE% --top 500 --out "%OUTFILE%" --html-out "%HTMLFILE%"
goto done

:portal
%PY% -m damasol.screener --sources spitogatos --all-types ^
     --max-price %MAXPRICE% --min-price 5000 --enrich-top 150 --top 500 ^
     --delay 2.5 --out "%OUTFILE%" --html-out "%HTMLFILE%"

:done

if errorlevel 1 (
  echo.
  echo [!] The scan did not finish. The message above says why.
  echo     Most common cause: the portal is rate limiting - wait an hour
  echo     and run again. Everything already downloaded is cached, so the
  echo     second run resumes rather than starting over.
  pause
  exit /b 1
)

echo.
echo ===========================================================================
echo   Done.
echo     Results page : %HTMLFILE%
echo     Spreadsheet  : %OUTFILE%.csv
echo     Full data    : %OUTFILE%.json
echo ===========================================================================
start "" "%HTMLFILE%"
pause
