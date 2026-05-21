# run-dev.ps1 — start both dev servers in separate windows.
# Usage:  pwsh ./run-dev.ps1
#
# Backend needs the dependencies in backend/requirements.txt installed
# into a virtualenv (e.g. backend/.venv). Frontend needs Node 18+.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSCommandPath

Write-Host ""
Write-Host "=== Booting PMO 360 (FastAPI + React) ===" -ForegroundColor Red
Write-Host ""

# Backend
$backend = Join-Path $root "backend"
$venvPython = Join-Path $backend ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "No .venv found at $venvPython" -ForegroundColor Yellow
    Write-Host "Create one with:  python -m venv backend\.venv ; backend\.venv\Scripts\pip install -r backend\requirements.txt" -ForegroundColor Yellow
    exit 1
}
Write-Host "Backend  → http://localhost:8000  (Swagger /docs)" -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "cd '$backend'; & '$venvPython' -m uvicorn app:app --reload --port 8000"

# Frontend
$frontend = Join-Path $root "frontend"
Write-Host "Frontend → http://localhost:5173" -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command",
    "cd '$frontend'; npm run dev"

Write-Host ""
Write-Host "Both servers launched in new windows. Close them to stop." -ForegroundColor Yellow
