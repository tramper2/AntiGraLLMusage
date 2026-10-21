$ErrorActionPreference = "Stop"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  ⚡ Antigravity Quota Status Bar & Panel Installer" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sidecarTarget = Join-Path $HOME ".gemini\config\sidecars\antigravity_quota_panel"
$skillTarget   = Join-Path $HOME ".gemini\config\skills\quota-panel"

# 1. Create target directories (real directories, avoiding Windows Junction bug)
New-Item -ItemType Directory -Force -Path $sidecarTarget | Out-Null
New-Item -ItemType Directory -Force -Path $skillTarget   | Out-Null

# 2. Copy Sidecar files
Copy-Item -Path (Join-Path $scriptDir "sidecar.json") -Destination (Join-Path $sidecarTarget "sidecar.json") -Force
Copy-Item -Path (Join-Path $scriptDir "server.cjs")   -Destination (Join-Path $sidecarTarget "server.cjs")   -Force
Copy-Item -Path (Join-Path $scriptDir "ui.html")      -Destination (Join-Path $sidecarTarget "ui.html")      -Force

# 3. Copy Skill file
Copy-Item -Path (Join-Path $scriptDir "SKILL.md")     -Destination (Join-Path $skillTarget "SKILL.md")       -Force

Write-Host "[✓] 사이드카 설치 완료: $sidecarTarget" -ForegroundColor Green
Write-Host "[✓] 스킬 설치 완료    : $skillTarget"   -ForegroundColor Green

# 4. Try to hot-start / restart the sidecar if Antigravity language_server is running
try {
  $lsProc = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^language_server' -and $_.CommandLine -match '--subclient_type\s+hub' } | Select-Object -First 1
  if (-not $lsProc) {
    $lsProc = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^language_server' } | Select-Object -First 1
  }

  if ($lsProc -and ($lsProc.CommandLine -match '--csrf_token\s+([a-fA-F0-9\-]+)')) {
    $csrf = $matches[1]
    $ports = @(Get-NetTCPConnection -OwningProcess $lsProc.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }

    foreach ($p in $ports) {
      try {
        $uri = "https://127.0.0.1:$p/exa.language_server_pb.LanguageServerService/ManageSidecar"
        $body = '{"sidecarId":"antigravity_quota_panel","action":"SIDECAR_ACTION_RESTART"}'
        $headers = @{
          "Content-Type" = "application/json"
          "Connect-Protocol-Version" = "1"
          "x-codeium-csrf-token" = $csrf
        }
        Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -TimeoutSec 3 | Out-Null
        Write-Host "[✓] 실행 중인 Antigravity 창에 하단 상태바가 즉시 적용되었습니다!" -ForegroundColor Green
        break
      } catch {}
    }
  } else {
    Write-Host "[i] Antigravity를 실행(또는 재시작)하면 하단 상태바가 자동으로 표시됩니다." -ForegroundColor Yellow
  }
} catch {
  Write-Host "[i] Antigravity를 재시작하면 하단 상태바가 자동으로 활성화됩니다." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "설치가 완료되었습니다! 🎉" -ForegroundColor Cyan
