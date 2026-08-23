@echo off
REM ===========================================================================
REM  DROPLET.bat - publish the results pages to your own droplet, from Windows.
REM
REM  Double-click, type the droplet address, done. Everything runs ON the
REM  droplet over ssh, which Windows 10 and 11 already have.
REM
REM  ASCII only on purpose: the batch parser is not reliable with Greek text.
REM ===========================================================================
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo ===========================================================================
echo   Publish the results to your droplet
echo ===========================================================================
echo.

where ssh >nul 2>&1
if errorlevel 1 goto nossh

set DROPLET=
set /p DROPLET=Droplet IP or domain, then Enter: 
if "%DROPLET%"=="" goto noaddress

set SSHUSER=root
set /p SSHUSER=SSH user - press Enter for root: 
if "%SSHUSER%"=="" set SSHUSER=root

set WEBLOGIN=admin
echo.
echo Choose the username and password for the pages. You will type them once
echo on each device - phone and computer - and the browser remembers them.
set /p WEBLOGIN=Username - press Enter for admin: 
if "%WEBLOGIN%"=="" set WEBLOGIN=admin
set WEBPASS=
set /p WEBPASS=Password - press Enter to get a random one: 
set WEBPORT=
echo.
echo The pages get their own port so nothing already running is disturbed.
echo Press Enter to let it pick a free one, or type a port number.
set /p WEBPORT=Port, or just press Enter: 

set REMOTE=curl -fsSL https://raw.githubusercontent.com/Innovagrow/procurement-dash-factory/claude/greek-brokers-investment-outreach-gr5j9p/deploy/droplet.sh -o /tmp/droplet.sh ^&^& WEB_USER='%WEBLOGIN%' WEB_PASS='%WEBPASS%' bash /tmp/droplet.sh
if not "%WEBPORT%"=="" set REMOTE=curl -fsSL https://raw.githubusercontent.com/Innovagrow/procurement-dash-factory/claude/greek-brokers-investment-outreach-gr5j9p/deploy/droplet.sh -o /tmp/droplet.sh ^&^& WEB_USER='%WEBLOGIN%' WEB_PASS='%WEBPASS%' PORT=%WEBPORT% bash /tmp/droplet.sh

echo.
echo [1/2] Setting up the droplet.
echo       On the first connection ssh asks you to confirm the host key.
echo       Type yes and press Enter. Then your droplet password, if you use one.
echo.
ssh %SSHUSER%@%DROPLET% "%REMOTE%"
if errorlevel 1 goto failed

echo.
echo [2/2] Upload the scan report too?
set UPLOAD=Y
set /p UPLOAD=Type Y or N and press Enter: 
if /i not "%UPLOAD%"=="Y" goto done

set REPORT=
if exist "out\eukairies_analysis.json" set REPORT=out\eukairies_analysis.json
if "%REPORT%"=="" for /f "delims=" %%f in ('dir /b /o-d "out\*_analysis.json" 2^>nul') do if "!REPORT!"=="" set REPORT=out\%%f
if "%REPORT%"=="" goto noreport

echo.
echo       Uploading !REPORT!
scp "!REPORT!" %SSHUSER%@%DROPLET%:/var/www/akinita/scan.json
if errorlevel 1 goto failed
goto done

:noreport
echo.
echo       No scan data found in the out folder yet. Run SAROSI.bat first,
echo       then run this again to upload it.
goto done

:nossh
echo [!] The ssh command was not found.
echo     Windows 10 and 11 include it. Turn it on here:
echo     Settings - System - Optional features - Add a feature - OpenSSH Client
pause
exit /b 1

:noaddress
echo [!] No address entered. Nothing to do.
pause
exit /b 1

:failed
echo.
echo [!] It did not finish. The message above says why.
echo     Wrong password or wrong user are the usual causes.
pause
exit /b 1

:done
echo.
echo ===========================================================================
echo   Done. The address, user and password were printed above.
echo   Nothing that was already running on ports 80 and 443 was touched.
echo   The map refreshes itself on the droplet every day.
echo ===========================================================================
pause
