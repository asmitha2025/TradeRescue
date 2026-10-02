# Runs the whole TradeRescue backend on this laptop and connects Twilio to it.
#
#   1. starts the Firebase emulator (Cloud Function + Firestore + dashboard)
#   2. opens a public tunnel to it, because Twilio can only call public URLs
#   3. points the Twilio number's "a message comes in" webhook at the tunnel
#
# The tunnel address is new on every run, which is why step 3 is repeated
# each time. Keep this window open for as long as the demo runs.
#
# Usage:  .\start-demo.ps1
#
# Twilio is optional. With a second phone in Gateway mode you do not need
# it: steps 1 and 2 are enough. To use Twilio, set these first (or pass
# -AccountSid / -TwilioNumber):
#   $env:TWILIO_ACCOUNT_SID, $env:TWILIO_NUMBER, $env:TWILIO_AUTH_TOKEN
# The token is asked for (hidden) if it is not set. None of them belong in
# this file.

param(
    [string]$AccountSid = $env:TWILIO_ACCOUNT_SID,
    [string]$TwilioNumber = $env:TWILIO_NUMBER,
    [string]$AdminKey = "demo-admin"
)
$useTwilio = [bool]($AccountSid -and $TwilioNumber)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$project = "demo-traderescue"
$local = "http://127.0.0.1:5000"
$cloudflared = Join-Path $PSScriptRoot ".tools\cloudflared.exe"
if (-not (Test-Path $cloudflared)) { throw "Missing $cloudflared - download cloudflared-windows-amd64.exe from github.com/cloudflare/cloudflared/releases and save it there." }

# The Firestore emulator needs Java; Android Studio ships one.
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    $jbr = "C:\Program Files\Android\Android Studio\jbr"
    if (-not (Test-Path "$jbr\bin\java.exe")) { throw "Java not found. Install a JDK or Android Studio." }
    $env:JAVA_HOME = $jbr
    $env:PATH = "$jbr\bin;$env:PATH"
}

if ($useTwilio) {
    $token = $env:TWILIO_AUTH_TOKEN
    if (-not $token) {
        $secure = Read-Host "Twilio Auth Token (input hidden)" -AsSecureString
        $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
    $cred = New-Object System.Management.Automation.PSCredential($AccountSid, (ConvertTo-SecureString $token -AsPlainText -Force))
}

Write-Host "`n[1/3] Starting the backend..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force emulator-data | Out-Null
# The function reads its admin key from functions/.env when that exists;
# use the same one for the dashboard link printed below.
$envLine = Get-Content "functions\.env" -ErrorAction SilentlyContinue | Where-Object { $_ -match '^ADMIN_KEY=' } | Select-Object -First 1
if ($envLine) { $AdminKey = $envLine -replace '^ADMIN_KEY=', '' }
$emulator = Start-Process -PassThru -WindowStyle Minimized cmd.exe -ArgumentList "/c", "firebase emulators:start --only functions,firestore,hosting --project $project --import emulator-data --export-on-exit emulator-data"
$up = $false
foreach ($i in 1..60) {
    try { if ((Invoke-RestMethod "$local/api/" -TimeoutSec 3).status -eq "ok") { $up = $true; break } } catch { Start-Sleep -Seconds 2 }
}
if (-not $up) { throw "The backend did not start. Run 'firebase emulators:start --only functions,firestore,hosting --project $project' to see why." }

Write-Host "[2/3] Opening the public tunnel..." -ForegroundColor Cyan
$log = Join-Path $env:TEMP "traderescue-tunnel.log"
Remove-Item $log -ErrorAction SilentlyContinue
$tunnel = Start-Process -PassThru -WindowStyle Hidden $cloudflared -ArgumentList "tunnel", "--url", $local, "--no-autoupdate" -RedirectStandardError $log
$public = $null
foreach ($i in 1..40) {
    Start-Sleep -Seconds 1
    $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $public = $m.Matches[0].Value; break }
}
if (-not $public) { throw "The tunnel did not come up. See $log" }
# Give the new address a few seconds to register. This laptop's own DNS
# often cannot resolve it for a while even though the internet (and
# Twilio) already can, so a failure here is not treated as fatal.
foreach ($i in 1..5) {
    try { if ((Invoke-RestMethod "$public/api/" -TimeoutSec 5).status -eq "ok") { break } } catch { Start-Sleep -Seconds 2 }
}

if ($useTwilio) {
    Write-Host "[3/3] Pointing Twilio at the tunnel..." -ForegroundColor Cyan
    $api = "https://api.twilio.com/2010-04-01/Accounts/$AccountSid"
    $found = Invoke-RestMethod -Uri "$api/IncomingPhoneNumbers.json?PhoneNumber=$([uri]::EscapeDataString($TwilioNumber))" -Credential $cred
    if (-not $found.incoming_phone_numbers) { throw "$TwilioNumber is not a number on this Twilio account." }
    $webhook = "$public/api/webhook/twilio-sms"
    $set = Invoke-RestMethod -Method Post -Uri "$api/IncomingPhoneNumbers/$($found.incoming_phone_numbers[0].sid).json" -Credential $cred -Body @{ SmsUrl = $webhook; SmsMethod = "POST" }
} else {
    Write-Host "[3/3] Twilio not configured - skipping (use a phone in Gateway mode)." -ForegroundColor Cyan
}

Write-Host "`nReady." -ForegroundColor Green
Write-Host "  Admin dashboard     : $local/#key=$AdminKey"
Write-Host "  App > Backend URL   : $public/api"
if ($useTwilio) {
    Write-Host "  Twilio webhook      : $($set.sms_url)"
    Write-Host "  App > SMS number    : $TwilioNumber"
} else {
    Write-Host "  App > SMS number    : the gateway phone's own number"
}
Write-Host "`nPress Enter to stop the demo (orders are saved for next time)."
[void](Read-Host)

Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
# Ask the emulator to exit cleanly so it writes emulator-data.
taskkill /PID $emulator.Id /T 2>$null | Out-Null
Start-Sleep -Seconds 6
taskkill /PID $emulator.Id /T /F 2>$null | Out-Null
