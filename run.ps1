# Run both backend and frontend for Local Academic Research Workbench
# Requires: venv with dependencies, Node 18+
Write-Host "=== Academic Research Workbench ===" -ForegroundColor Cyan
Write-Host "Starting backend (FastAPI) on http://127.0.0.1:8000" -ForegroundColor Yellow
$backend = Start-Process -FilePath ".\venv\Scripts\python.exe" -ArgumentList "-m","uvicorn","server:app","--host","127.0.0.1","--port","8000","--reload" -PassThru -WindowStyle Normal
Start-Sleep -Seconds 3
# wait for health
for ($i=0; $i -lt 10; $i++) {
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec 2
    Write-Host "Backend ready: $($h.documents) docs" -ForegroundColor Green
    break
  } catch {
    Write-Host "Waiting for backend... ($i)" -ForegroundColor DarkGray
    Start-Sleep -Seconds 2
  }
}
Write-Host "Starting frontend (Next.js) on http://127.0.0.1:3000" -ForegroundColor Yellow
$frontend = Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run dev -- --port 3000 --hostname 127.0.0.1" -WorkingDirectory ".\web" -PassThru -WindowStyle Normal
Write-Host ""
Write-Host "Services starting - open:" -ForegroundColor Cyan
Write-Host "  Library UI:  http://127.0.0.1:3000" -ForegroundColor White
Write-Host "  API docs:    http://127.0.0.1:8000/docs" -ForegroundColor White
Write-Host "  Health:      http://127.0.0.1:8000/api/health" -ForegroundColor White
Write-Host ""
Write-Host "Press Enter to stop both servers..." -ForegroundColor DarkGray
Read-Host | Out-Null
try { Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue } catch {}
try { Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue } catch {}
Write-Host "Stopped." -ForegroundColor Yellow
