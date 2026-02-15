@echo off
echo ========================================
echo BidRoom GR - Quick Setup Script
echo ========================================
echo.

echo [1/6] Installing dependencies...
call npm install
if errorlevel 1 goto error

echo.
echo [2/6] Starting Docker containers (Postgres, Redis, MinIO)...
docker-compose up -d
if errorlevel 1 goto docker_error

echo.
echo [3/6] Waiting for databases to be ready...
timeout /t 10 /nobreak > nul

echo.
echo [4/6] Setting up database schema...
call npm run db:push
if errorlevel 1 goto error

echo.
echo [5/6] Seeding demo data...
call npm run db:seed
if errorlevel 1 goto error

echo.
echo [6/6] Setup complete!
echo.
echo ========================================
echo SUCCESS! BidRoom GR is ready to use
echo ========================================
echo.
echo Next steps:
echo   1. Start dev server: npm run dev
echo   2. Visit: http://localhost:3000
echo   3. Login with: admin@demo.gr / password123
echo.
echo Optional:
echo   - Start worker: npm run worker (in new terminal)
echo   - View MinIO console: http://localhost:9001 (minioadmin/minioadmin)
echo.
goto end

:docker_error
echo.
echo ERROR: Docker is not running or not installed
echo Please install Docker Desktop and try again
echo Download from: https://www.docker.com/products/docker-desktop
goto end

:error
echo.
echo ERROR: Setup failed. Check the error message above.
goto end

:end
pause
