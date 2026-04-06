$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $projectRoot "backend"
$frontendPath = Join-Path $projectRoot "frontend"

function Test-PortListening {
  param([int]$Port)
  try {
    return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
}

function Get-PythonExecutable {
  $venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
  if (Test-Path $venvPython) {
    return $venvPython
  }

  return "python"
}

Write-Host "[Network Lab] Starting services..." -ForegroundColor Cyan

if (Test-PortListening -Port 5000) {
  Write-Host "[Backend] Already running on port 5000" -ForegroundColor Yellow
} else {
  $pythonExe = Get-PythonExecutable
  Start-Process powershell -WindowStyle Minimized -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location '$backendPath'; & '$pythonExe' app.py"
  ) | Out-Null
  Write-Host "[Backend] Starting on http://localhost:5000" -ForegroundColor Green
}

if (Test-PortListening -Port 3000) {
  Write-Host "[Frontend] Already running on port 3000" -ForegroundColor Yellow
} else {
  Start-Process powershell -WindowStyle Minimized -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location '$frontendPath'; npm run dev -- --host 0.0.0.0"
  ) | Out-Null
  Write-Host "[Frontend] Starting on http://localhost:3000" -ForegroundColor Green
}

Write-Host "[Network Lab] Startup checks complete." -ForegroundColor Cyan
