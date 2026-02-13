@echo off
echo ================================================
echo github-router Server with Usage Viewer
echo ================================================
echo.

if not exist node_modules (
    echo Installing dependencies...
    bun install
    echo.
)

echo Starting server...
echo The usage viewer page will open automatically after the server starts
echo.

start "" "https://animeshkundu.github.io/github-router/dashboard.html?endpoint=http://localhost:8787/usage"
bun run dev

pause
