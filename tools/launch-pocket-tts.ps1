<#
.SYNOPSIS
    Launches (or kills) the local pocket-tts server used by the Amazing Grace
    Book Reader Android app for the "Drop PDF + Pocket TTS" feature.

.DESCRIPTION
    Activates the Python virtual environment at
    C:\Users\carpe\.minimax\experiments\pocket-tts\.venv (if it exists) and
    starts serve_local.py in the background, bound to 127.0.0.1:8765 by
    default. The launched process PID is written to .pocket-tts.pid in the
    current working directory so subsequent invocations (including --kill) can
    find it.

    Default voice is "eve" (a built-in pocket-tts voice). Override with -Voice.

    Idempotent: if a server is already running on the requested port, this
    script reports that and exits 0 without starting a second instance.

.PARAMETER Port
    TCP port to bind. Defaults to 8765.

.PARAMETER Voice
    Default voice to load on the server. Defaults to "eve".

.PARAMETER BaseUrl
    Reserved for the script's own health probe; not currently user-tunable.

.PARAMETER Kill
    Stop the previously-launched server (reads the PID from .pocket-tts.pid)
    and exit. Implemented as a switch so ".\launch-pocket-tts.ps1 -Kill" works
    from PowerShell.

.EXAMPLE
    .\tools\launch-pocket-tts.ps1
    # Starts the server in the background. PID in .\.pocket-tts.pid.

.EXAMPLE
    .\tools\launch-pocket-tts.ps1 -Kill
    # Stops the previously-launched server.

.EXAMPLE
    .\tools\launch-pocket-tts.ps1 -Port 9000 -Voice alba
    # Starts on port 9000 with the "alba" voice.

.NOTES
    PowerShell-only (no bash). Verified on PowerShell 7.x on Windows.
#>

[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$Voice = "eve",
    [string]$BaseUrl = "http://127.0.0.1:$Port",
    [switch]$Kill
)

$ErrorActionPreference = 'Stop'

# Paths
$ScriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot     = Resolve-Path (Join-Path $ScriptRoot '..')
$PocketTtsDir = 'C:\Users\carpe\.minimax\experiments\pocket-tts'
$VenvDir      = Join-Path $PocketTtsDir '.venv'
$VenvPython   = Join-Path $VenvDir 'Scripts\python.exe'
$ServerScript = Join-Path $PocketTtsDir 'serve_local.py'
$PidFile      = Join-Path $RepoRoot '.pocket-tts.pid'

function Test-ServerReachable {
    param([string]$Url, [int]$TimeoutSeconds = 2)
    try {
        $null = Invoke-WebRequest -Uri "$Url/health" -Method Get -TimeoutSec $TimeoutSeconds -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

function Get-StoredPid {
    if (Test-Path -LiteralPath $PidFile) {
        $raw = Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue
        if ($raw -and $raw.Trim() -match '^\d+$') {
            return [int]$raw.Trim()
        }
    }
    return $null
}

if ($Kill) {
    $storedPid = Get-StoredPid
    if ($null -eq $storedPid) {
        Write-Host "No .pocket-tts.pid found at $PidFile - nothing to kill."
        if (Test-ServerReachable -Url $BaseUrl) {
            Write-Host "A server is reachable on $BaseUrl but its PID is unknown to this script."
            Write-Host "Stop it manually via Stop-Process, Task Manager, or run the launcher with -Kill after restarting it once."
            exit 0
        }
        exit 0
    }

    $proc = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
        Write-Host "Stale PID $storedPid in $PidFile - process is not running. Cleaning up the pid file."
        Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
        exit 0
    }

    Write-Host "Stopping pocket-tts (PID $storedPid)..."
    Stop-Process -Id $storedPid -Force
    Start-Sleep -Milliseconds 500

    if (Get-Process -Id $storedPid -ErrorAction SilentlyContinue) {
        Write-Host "Process $storedPid did not exit cleanly; the OS will reap it shortly."
    } else {
        Write-Host "pocket-tts (PID $storedPid) stopped."
    }

    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    exit 0
}

# --- Launch path -----------------------------------------------------------

# Idempotency: if a server is already reachable, do nothing.
if (Test-ServerReachable -Url $BaseUrl) {
    $existing = Get-StoredPid
    if ($existing) {
        Write-Host "pocket-tts is already running on $BaseUrl (PID $existing, pidfile $PidFile). Nothing to do."
    } else {
        Write-Host "A pocket-tts-compatible service is already reachable on $BaseUrl (no pidfile). Nothing to do."
    }
    exit 0
}

# Sanity-check the server script exists before trying to launch.
if (-not (Test-Path -LiteralPath $ServerScript)) {
    Write-Error "serve_local.py not found at $ServerScript. Is the pocket-tts experiment checked out at $PocketTtsDir?"
    exit 1
}

# Pick the python interpreter. Prefer the venv if it exists; fall back to
# whatever `python` is on PATH with a clear warning.
$PythonExe = $null
$UsedVenv  = $false
if (Test-Path -LiteralPath $VenvPython) {
    $PythonExe = $VenvPython
    $UsedVenv  = $true
} else {
    $pythonCmd = (Get-Command 'python' -ErrorAction SilentlyContinue)
    if ($pythonCmd) {
        $PythonExe = $pythonCmd.Source
        Write-Warning "Venv not found at $VenvDir. Falling back to $($pythonCmd.Source) on PATH. The pocket-tts deps (uvicorn, fastapi, pocket_tts) must be installed there."
    } else {
        Write-Error "Neither $VenvPython nor 'python' on PATH could be found. Set up the venv at $VenvDir (see DEV.md) or install Python and the pocket-tts deps."
        exit 1
    }
}

Write-Host "Launching pocket-tts: $PythonExe $ServerScript --port $Port --voice $Voice"
Write-Host "  cwd: $PocketTtsDir"
Write-Host "  url: $BaseUrl"

# Start-Process -PassThru returns the Process object so we can grab the PID.
# -RedirectStandardOutput / -RedirectStandardError keep the server's logs
# out of the caller's terminal — they're written to pocket-tts.stdout.log /
# pocket-tts.stderr.log inside the pocket-tts directory. -NoNewWindow keeps
# the launcher PowerShell-friendly; uvicorn will still log to the redirected
# files.
$stdoutLog = Join-Path $PocketTtsDir 'launcher.stdout.log'
$stderrLog = Join-Path $PocketTtsDir 'launcher.stderr.log'

$proc = Start-Process -FilePath $PythonExe `
                      -ArgumentList @("$ServerScript", "--port", "$Port", "--voice", "$Voice") `
                      -WorkingDirectory $PocketTtsDir `
                      -RedirectStandardOutput $stdoutLog `
                      -RedirectStandardError $stderrLog `
                      -PassThru `
                      -WindowStyle Hidden

# Persist the PID BEFORE waiting on the health probe, so a concurrent --kill
# has something to find.
$proc.Id | Out-File -FilePath $PidFile -Encoding ascii -NoNewline
Write-Host "Started pocket-tts (PID $($proc.Id)). PID file: $PidFile"
Write-Host "Logs: $stdoutLog / $stderrLog"

# Wait up to ~30s for the server to come up. Synthesizing the first request
# can be slow (model load + first-request voice pre-encode) so a generous
# timeout is required on cold start.
Write-Host "Waiting for $BaseUrl/health to come up..."
$deadline = (Get-Date).AddSeconds(30)
$ok = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    if (Test-ServerReachable -Url $BaseUrl) {
        $ok = $true
        break
    }
    # Bail out early if the process died on launch.
    if ($proc.HasExited) {
        Write-Error "pocket-tts process exited (code $($proc.ExitCode)) during startup. See $stderrLog."
        Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
        exit 1
    }
}

if (-not $ok) {
    Write-Warning "pocket-tts did not respond on $BaseUrl within 30s. The server may still be loading. Tail $stderrLog for details."
    exit 1
}

Write-Host "pocket-tts is up at $BaseUrl."
Write-Host "Next steps:"
Write-Host "  - Run tools\probe-pocket-tts.ps1 to smoke-test the endpoint."
Write-Host "  - In the app, set the server URL to $BaseUrl (Android emulator: use 10.0.2.2 instead of 127.0.0.1)."
Write-Host "  - To stop: tools\launch-pocket-tts.ps1 -Kill"
exit 0
