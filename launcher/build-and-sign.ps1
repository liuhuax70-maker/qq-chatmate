# =========================================================
#  Build the launcher exe and sign it with a self-signed cert
#
#  Why sign:
#    An unsigned exe triggers Windows SmartScreen ("Windows protected
#    your PC") on every launch. Signing with a locally-trusted
#    self-signed certificate removes that prompt.
#
#  First-time setup (run once, as Administrator):
#    .\sign-setup.ps1
#      - creates a self-signed code-signing certificate
#      - imports it into Trusted Root Certification Authorities
#      - exports qinai-codesign.cer for reference
#
#  Then just run this script to build + sign.
# =========================================================

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
    Write-Host '[ERROR] csc.exe not found. Need .NET Framework 4.' -ForegroundColor Red
    exit 1
}

$src = Join-Path $here 'Launcher.cs'
$manifest = Join-Path $here 'launcher.manifest'
if (-not (Test-Path $src)) { Write-Host '[ERROR] Launcher.cs not found' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $manifest)) { Write-Host '[ERROR] launcher.manifest not found' -ForegroundColor Red; exit 1 }

$common = @(
    '/nologo',
    '/reference:System.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    "/win32manifest:$manifest"
)

# 输出到临时目录再改名：中文文件名直接给 /out: 会被 GBK 转换搞乱
$tmpDir = Join-Path $env:TEMP 'qinai-build'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

$guiTmp = Join-Path $tmpDir 'qinai.exe'
$consoleTmp = Join-Path $tmpDir 'qinai-status.exe'

Write-Host '[1/3] Building GUI version...'
& $csc /target:winexe "/out:$guiTmp" @common $src
if ($LASTEXITCODE -ne 0) { Write-Host '[FAILED] GUI build' -ForegroundColor Red; exit 1 }

Write-Host '[2/3] Building console version...'
& $csc /target:exe "/out:$consoleTmp" @common $src
if ($LASTEXITCODE -ne 0) { Write-Host '[FAILED] console build' -ForegroundColor Red; exit 1 }

# 部署（先删旧文件；被占用时用新名字）
# 注意：这里不写中文字面量——PowerShell 5.1 用 -File 调用时
# 会把脚本里的中文按 GBK 重新解释，导致文件名变成乱码。
# 改为从现有 exe 推断目标名，找不到就用 ASCII 名。
$existingExes = Get-ChildItem $here -Filter '*.exe' -File -ErrorAction SilentlyContinue
$guiExisting = $existingExes | Where-Object { $_.BaseName -notmatch 'status|状态|_old' } | Select-Object -First 1
$consoleExisting = $existingExes | Where-Object { $_.BaseName -match 'status|状态' } | Select-Object -First 1

if ($guiExisting) { $guiTarget = $guiExisting.FullName } else { $guiTarget = Join-Path $here 'qinai-launcher.exe' }
if ($consoleExisting) { $consoleTarget = $consoleExisting.FullName } else { $consoleTarget = Join-Path $here 'qinai-status.exe' }

foreach ($pair in @(@($guiTmp, $guiTarget), @($consoleTmp, $consoleTarget))) {
    $from, $to = $pair
    try {
        if (Test-Path $to) { Remove-Item $to -Force -ErrorAction Stop }
        Copy-Item $from $to -Force
        Write-Host "  deployed: $to"
    }
    catch {
        $alt = $to -replace '\.exe$', '_new.exe'
        Copy-Item $from $alt -Force
        Write-Host "  [WARN] target locked, wrote instead: $alt" -ForegroundColor Yellow
    }
}

Write-Host '[3/3] Signing...'
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -like '*Qinai*' } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

if (-not $cert) {
    Write-Host '  [WARN] no code-signing cert found. Run sign-setup.ps1 first.' -ForegroundColor Yellow
    Write-Host '         Unsigned exe will trigger SmartScreen on every launch.'
}
else {
    $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits' -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if (-not $signtool) {
        Write-Host '  [WARN] signtool.exe not found (needs Windows SDK). Skipping signing.' -ForegroundColor Yellow
    }
    else {
        foreach ($t in @($guiTarget, $consoleTarget)) {
            if (-not (Test-Path $t)) { continue }
            & $signtool.FullName sign /sha1 $cert.Thumbprint /fd SHA256 /t http://timestamp.digicert.com $t 2>$null
            if ($LASTEXITCODE -ne 0) {
                # 时间戳服务器不可达时，不带时间戳签
                & $signtool.FullName sign /sha1 $cert.Thumbprint /fd SHA256 $t 2>$null
            }
            $sig = Get-AuthenticodeSignature $t
            Write-Host "  $([System.IO.Path]::GetFileName($t)) -> $($sig.Status)"
        }
    }
}

Write-Host ''
Write-Host '[DONE]'
Write-Host "  $guiTarget"
Write-Host "  $consoleTarget"
