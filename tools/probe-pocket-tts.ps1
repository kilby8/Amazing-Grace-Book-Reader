<#
.SYNOPSIS
    Smoke-tests a running local pocket-tts server by POSTing a short test
    string to /tts and verifying the response is a WAV (RIFF magic).

.DESCRIPTION
    Hits <BaseUrl>/tts with a multipart form containing 'text' and 'voice_url',
    then checks:
      1. HTTP 200
      2. Content-Type starts with "audio/wav"
      3. The first 4 bytes of the body are "RIFF" (the WAV magic)

    Prints a clear PASS / FAIL summary and the Content-Type that came back.
    Exits 0 on PASS, 1 on FAIL.

    Designed to be run after tools\launch-pocket-tts.ps1 as a one-shot
    integration smoke (see DESIGN.md §5 — "integration smoke").

.PARAMETER BaseUrl
    Root URL of the pocket-tts server. Defaults to http://127.0.0.1:8765.

.PARAMETER Text
    Short test string to synthesize. Default keeps the test cheap and
    deterministic.

.PARAMETER Voice
    Voice identifier. Default is "eve" to match the launcher's default.

.EXAMPLE
    .\tools\probe-pocket-tts.ps1
    # Probes http://127.0.0.1:8765/tts with "hello world" using the eve voice.

.EXAMPLE
    .\tools\probe-pocket-tts.ps1 -BaseUrl http://127.0.0.1:9000
    # Probe an alternate port.

.NOTES
    PowerShell-only. Requires the launcher to have started the server first.
#>

[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:8765',
    [string]$Text    = 'Hello from the pocket-tts probe.',
    [string]$Voice   = 'eve'
)

$ErrorActionPreference = 'Stop'

# Normalize the URL: strip trailing slash so "$BaseUrl/tts" never becomes
# ".../tts" (would 404 in some servers) or "...//tts" (would 404 in most).
$BaseUrl = $BaseUrl.TrimEnd('/')
$Endpoint = "$BaseUrl/tts"

# 1) Reachability check: a friendly error if the server isn't up at all.
try {
    $null = Invoke-WebRequest -Uri "$BaseUrl/health" -Method Get -TimeoutSec 3 -UseBasicParsing
} catch {
    Write-Host "FAIL: pocket-tts is not reachable at $BaseUrl"
    Write-Host "  $($_.Exception.Message)"
    Write-Host ""
    Write-Host "Start the server first:"
    Write-Host "  .\tools\launch-pocket-tts.ps1"
    exit 1
}

# 2) Hit /tts with a multipart form. PowerShell 5.1's Invoke-WebRequest does
# not support -Form, so we build a multipart/form-data body by hand and post
# it with a generated boundary. The shape mirrors what Invoke-WebRequest's
# -Form parameter would produce on PowerShell 6+ — the server's FastAPI
# parser doesn't care about whitespace differences as long as the boundary
# is consistent between the header and the body.
try {
    $boundary = [System.Guid]::NewGuid().ToString('N')
    $contentType = "multipart/form-data; boundary=$boundary"

    $lf = "`r`n"
    $bodyLines = @()
    foreach ($pair in @(
        @{ name = 'text';      value = $Text },
        @{ name = 'voice_url'; value = $Voice }
    )) {
        $bodyLines += "--$boundary"
        $bodyLines += "Content-Disposition: form-data; name=`"$($pair.name)`""
        $bodyLines += ""
        $bodyLines += $pair.value
    }
    $bodyLines += "--$boundary--"
    $bodyLines += ""
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes(($bodyLines -join $lf))

    $response = Invoke-WebRequest -Uri $Endpoint `
                                  -Method Post `
                                  -ContentType $contentType `
                                  -Body $bodyBytes `
                                  -UseBasicParsing
} catch {
    $statusCode = $null
    $errBody    = $null
    if ($_.Exception.Response) {
        $statusCode = [int]$_.Exception.Response.StatusCode
        try {
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $errBody = $reader.ReadToEnd()
            $reader.Close()
        } catch {
            $errBody = '(could not read error body)'
        }
    }
    Write-Host "FAIL: POST $Endpoint returned an error"
    if ($statusCode) {
        Write-Host "  HTTP $statusCode"
    }
    if ($errBody) {
        Write-Host "  body: $errBody"
    } else {
        Write-Host "  $($_.Exception.Message)"
    }
    exit 1
}

$status = [int]$response.StatusCode
$contentType = $response.Headers['Content-Type']
if (-not $contentType) { $contentType = $response.ContentType }
$rawBytes = $response.RawContentStream.ToArray()

# 3) Three checks: 200, audio/wav content-type, RIFF magic.
$problems = New-Object System.Collections.Generic.List[string]

if ($status -ne 200) {
    $problems.Add("expected HTTP 200, got $status")
}

if (-not ($contentType -and $contentType.StartsWith('audio/wav', [System.StringComparison]::OrdinalIgnoreCase))) {
    $problems.Add("expected Content-Type to start with 'audio/wav', got '$contentType'")
}

if ($rawBytes.Length -lt 4) {
    $problems.Add("response body is shorter than 4 bytes (got $($rawBytes.Length))")
} else {
    $magic = -join ($rawBytes[0..3] | ForEach-Object { [char]$_ })
    if ($magic -ne 'RIFF') {
        $problems.Add("expected first 4 bytes to be 'RIFF', got '$magic'")
    }
}

if ($problems.Count -gt 0) {
    Write-Host "FAIL: $Endpoint did not return a valid WAV"
    foreach ($p in $problems) {
        Write-Host "  - $p"
    }
    Write-Host ""
    Write-Host "Response summary:"
    Write-Host "  HTTP $status"
    Write-Host "  Content-Type: $contentType"
    Write-Host "  Body length:  $($rawBytes.Length) bytes"
    if ($rawBytes.Length -ge 4) {
        $first4 = -join ($rawBytes[0..3] | ForEach-Object { '{0:X2}' -f $_ })
        Write-Host "  First 4 bytes (hex): $first4"
    }
    exit 1
}

Write-Host "PASS: $Endpoint returned a valid WAV"
Write-Host "  HTTP $status"
Write-Host "  Content-Type: $contentType"
Write-Host "  Body length:  $($rawBytes.Length) bytes"
Write-Host "  First 4 bytes: RIFF (WAV magic confirmed)"
exit 0
