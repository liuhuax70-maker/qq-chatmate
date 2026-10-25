# =========================================================
#  One-time setup: create a self-signed code-signing certificate
#  and trust it on this machine.
#
#  Why this is needed:
#    Windows SmartScreen blocks unsigned executables with
#    "Windows protected your PC". Signing with a certificate that
#    is trusted locally removes that prompt — permanently, for this
#    machine only. Nothing is uploaded anywhere.
#
#  Usage:
#    .\sign-setup.ps1
#
#  Run once. Re-running is safe: it reuses an existing cert if the
#  subject matches and it has not expired.
# =========================================================

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$subject = 'CN=Qinai Chatmate Launcher, O=Local, C=CN'
$cerPath = Join-Path $here 'qinai-codesign.cer'

Write-Host '[1/3] Looking for an existing certificate...'
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date).AddDays(30) } |
    Select-Object -First 1

if ($cert) {
    Write-Host "  reusing: $($cert.Thumbprint)"
}
else {
    Write-Host '  creating a new self-signed code-signing certificate...'
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $subject `
        -KeyUsage DigitalSignature `
        -FriendlyName 'Qinai Launcher Self-Signed' `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -NotAfter (Get-Date).AddYears(10)
    Write-Host "  created: $($cert.Thumbprint)"
}

Write-Host '[2/3] Exporting certificate...'
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null
Write-Host "  $cerPath"

Write-Host '[3/3] Trusting the certificate on this machine...'
$root = Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $cert.Thumbprint }

if ($root) {
    Write-Host '  already trusted'
}
else {
    # certutil works without a UI prompt, unlike Import-Certificate
    $out = & certutil.exe -user -addstore Root $cerPath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  [FAILED] could not add to trusted root' -ForegroundColor Red
        $out | Select-Object -Last 5 | ForEach-Object { Write-Host "    $_" }
        exit 1
    }
    Write-Host '  trusted'
}

# 验证整条链
$chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
$valid = $chain.Build($cert)
Write-Host ''
if ($valid) {
    Write-Host '[OK] Certificate is valid and trusted on this machine.' -ForegroundColor Green
    Write-Host '     Now run build-and-sign.ps1 to build and sign the launcher.'
}
else {
    Write-Host '[WARN] Chain validation failed:' -ForegroundColor Yellow
    $chain.ChainStatus | ForEach-Object { Write-Host "       $($_.Status)" }
}
