$ErrorActionPreference = "Stop"

$sidecarTarget = Join-Path $HOME ".gemini\config\sidecars\antigravity_quota_panel"
$skillTarget   = Join-Path $HOME ".gemini\config\skills\quota-panel"

if (Test-Path $sidecarTarget) { Remove-Item -Recurse -Force $sidecarTarget }
if (Test-Path $skillTarget)   { Remove-Item -Recurse -Force $skillTarget }

Write-Host "[✓] Antigravity Quota Panel 이 제거되었습니다. Antigravity를 재시작해 주세요." -ForegroundColor Yellow
