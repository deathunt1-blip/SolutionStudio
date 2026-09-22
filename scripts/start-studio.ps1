param([switch]$WaitOnly, [switch]$CheckOnly, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $studioRoot

# Match the server's environment-first HOST/PORT configuration without reading keys into logs.
$studioConfig = @{}
if (Test-Path -LiteralPath '.env') {
    foreach ($studioLine in Get-Content -LiteralPath '.env') {
        if ($studioLine -match '^\s*(HOST|PORT)\s*=\s*(.*?)\s*$') {
            $studioConfig[$Matches[1]] = $Matches[2].Split('#')[0].Trim().Trim('"', "'")
        }
    }
}
$studioHost = if ($env:HOST) { $env:HOST } elseif ($studioConfig['HOST']) { $studioConfig['HOST'] } else { '127.0.0.1' }
$studioPort = if ($env:PORT) { $env:PORT } elseif ($studioConfig['PORT']) { $studioConfig['PORT'] } else { '4310' }
if ($studioPort -notmatch '^\d+$' -or [int]$studioPort -lt 1 -or [int]$studioPort -gt 65535) { throw 'Invalid PORT setting.' }
if ($studioHost -eq '0.0.0.0') { $studioHost = '127.0.0.1' }
if ($studioHost -eq '::' -or $studioHost -eq '::1') { $studioHost = '[::1]' }
$studioUrl = "http://${studioHost}:${studioPort}"
function Test-StudioReady {
    try {
        $studioHealth = Invoke-RestMethod -Uri "$studioUrl/api/health" -TimeoutSec 2
        return $studioHealth.status -eq 'ok' -and $studioHealth.database -in @('pglite', 'postgres')
    } catch { return $false }
}
function Open-Studio {
    Write-Host "Solution Studio is ready: $studioUrl"
    if (-not $NoOpen) { Start-Process -FilePath $studioUrl }
}
if ($CheckOnly) { if (Test-StudioReady) { exit 0 }; exit 1 }
if (Test-StudioReady) { Open-Studio; exit 0 }
if ($WaitOnly) {
    $studioDeadline = (Get-Date).AddSeconds(120)
    do {
        if (Test-StudioReady) { Open-Studio; exit 0 }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $studioDeadline)
    exit 1
}

# Serialize double-clicks before either process can open the embedded database.
$studioHash = [System.Security.Cryptography.SHA256]::Create()
$studioLockName = ([BitConverter]::ToString($studioHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($studioRoot.ToLowerInvariant())))).Replace('-', '')
$studioHash.Dispose()
$studioMutex = New-Object System.Threading.Mutex($false, "Local\SolutionStudio-$studioLockName")
$studioOwnsLock = $false
try {
    $studioDeadline = (Get-Date).AddSeconds(180)
    while (-not $studioOwnsLock) {
        try { $studioOwnsLock = $studioMutex.WaitOne(500) } catch [System.Threading.AbandonedMutexException] { $studioOwnsLock = $true }
        if (Test-StudioReady) { Open-Studio; exit 0 }
        if ((Get-Date) -gt $studioDeadline) { throw 'Another launcher is still starting. Check its console window.' }
    }
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js is missing. Install Node.js 24 LTS, then launch again.' }
    if (-not (Test-Path -LiteralPath 'node_modules')) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' } }
    if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. See the error above.' }
    if (Test-StudioReady) { Open-Studio; exit 0 }
    $studioWatcherArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -WaitOnly"
    if ($NoOpen) { $studioWatcherArgs += ' -NoOpen' }
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList $studioWatcherArgs
    Write-Host "Starting Solution Studio. The browser will open when ready: $studioUrl"
    Write-Host 'Keep this console open while using the application.'
    & npm.cmd start
    if ($LASTEXITCODE -ne 0) { throw 'Server stopped with an error. See the error above.' }
} catch {
    Write-Host "Solution Studio could not start: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($studioOwnsLock) { $studioMutex.ReleaseMutex() }
    $studioMutex.Dispose()
}
