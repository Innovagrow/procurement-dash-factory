@echo off
echo ============================================================
echo Eurostat Dashboard Factory - Fast Rendering Mode
echo ============================================================
echo.
echo Killing any existing Python processes...
taskkill /F /IM python.exe 2>nul
timeout /t 2 /nobreak >nul
echo.
echo Starting server with fast rendering (2s vs 30s)...
echo Server will be available at: http://localhost:5000
echo.
echo Features:
echo   - Fast HTML rendering (Jinja2)
echo   - Parallel data fetch + AI
echo   - Smart filtering for all datasets
echo   - No caching (fresh data each time)
echo.
echo Press Ctrl+C to stop the server
echo ============================================================
echo.
py api_server.py
