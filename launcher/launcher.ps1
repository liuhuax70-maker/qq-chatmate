<#
    鲸奈 QQ 网友 · 一键启动器
    ------------------------------------------------------------
    管理四个组件：机器人主程序 / Lagrange 协议端 / 签名服务 / TTS

    设计要点：
      - 图形界面，双击即可用，不需要命令行
      - 组件以独立进程启动，关掉本启动器不影响它们继续跑
      - 启动前会检查是否已在运行，重复点不会起两份
      - 状态每 3 秒自动刷新
#>

param(
    # 命令行模式（不开图形界面），便于脚本 / 计划任务 / 排障
    [switch]$Status,
    [switch]$StartAll,
    [switch]$StopAll
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ── 路径 ────────────────────────────────────────────────────
$LauncherDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Base        = Split-Path -Parent $LauncherDir

$BotDir        = Join-Path $Base "qq-netizen"
$TtsPython     = Join-Path $Base "tts-env\venv\Scripts\python.exe"
$TtsScript     = Join-Path $Base "gpt-sovits\tts_server.py"
$LagrangeBat   = Join-Path $LauncherDir "start-lagrange.bat"
$LogDir        = Join-Path $Base "logs"
$SignContainer = "ntqq-sign-server"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# ── 工具函数 ────────────────────────────────────────────────

function Test-Port {
    param([int]$Port, [string]$Host_ = "127.0.0.1")
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect($Host_, $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(600)
        if ($ok -and $c.Connected) { $c.Close(); return $true }
        $c.Close(); return $false
    } catch { return $false }
}

function Get-PidByPort {
    param([int]$Port)
    try {
        $line = netstat -ano -p TCP | Select-String -Pattern "127\.0\.0\.1:$Port\s+\S+\s+LISTENING\s+(\d+)" | Select-Object -First 1
        if ($line -and $line.Matches.Count -gt 0) { return [int]$line.Matches[0].Groups[1].Value }
    } catch { }
    return 0
}

function Stop-ByPort {
    param([int]$Port, [string]$Name)
    $p = Get-PidByPort -Port $Port
    if ($p -gt 0) {
        taskkill /PID $p /T /F 2>$null | Out-Null
        Start-Sleep -Milliseconds 800
        return $true
    }
    return $false
}

function Get-DockerReady {
    try {
        $null = docker ps 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Find-DockerDesktopExe {
    # Docker Desktop 的位置各版本不同（Program Files / 用户目录 / 自定义），
    # 逐个探测，最后再查注册表兜底。
    $candidates = @(
        "C:\Program Files\Docker\Docker\Docker Desktop.exe"
        "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
        "$env:LOCALAPPDATA\Docker\Docker Desktop.exe"
        "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
        "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    # 注册表兜底
    try {
        $keys = @(
            "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop",
            "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop"
        )
        foreach ($k in $keys) {
            if (Test-Path $k) {
                $loc = (Get-ItemProperty $k -ErrorAction SilentlyContinue).InstallLocation
                if ($loc) {
                    $p = Join-Path $loc "Docker Desktop.exe"
                    if (Test-Path $p) { return $p }
                }
            }
        }
    } catch { }
    return $null
}

function Start-DockerDesktopIfNeeded {
    if (Get-DockerReady) { return $true }
    $exe = Find-DockerDesktopExe
    if (-not $exe) { return $false }
    Start-Process -FilePath $exe -WindowStyle Minimized
    # Docker Desktop 冷启动可能要 1-2 分钟，这里最多等 120 秒
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 3
        if (Get-DockerReady) { return $true }
    }
    return (Get-DockerReady)
}

function Test-LagrangeProcess {
    $p = Get-Process -Name "Lagrange.OneBot" -ErrorAction SilentlyContinue
    return ($null -ne $p)
}

function Test-SignContainer {
    if (-not (Get-DockerReady)) { return $false }
    try {
        $names = docker ps --filter "name=$SignContainer" --format "{{.Names}}" 2>$null
        return ($names -match $SignContainer)
    } catch { return $false }
}

# ── 组件操作 ────────────────────────────────────────────────

function Start-Bot {
    if ((Test-Port 8080) -and (Test-Port 3000)) { return "机器人已在运行" }
    Stop-ByPort -Port 8080 -Name "bot" | Out-Null
    Stop-ByPort -Port 3000 -Name "bot" | Out-Null

    # 先编译再用 dist 启动。
    # 为什么不用 npm run dev：那是 tsx watch，会留下 watch 父进程，
    # 停止时杀不干净、还可能被自动重启。dist 是单个 node 进程，干净可控。
    Push-Location $BotDir
    try {
        $build = & npm run build 2>&1
        $buildOk = ($LASTEXITCODE -eq 0)
    } finally {
        Pop-Location
    }
    if (-not $buildOk) {
        $tail = ($build | Select-Object -Last 3) -join " | "
        return "编译失败：$tail"
    }

    $log = Join-Path $LogDir "bot.log"
    $inner = "node dist\index.js >> `"$log`" 2>&1"
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $inner -WorkingDirectory $BotDir -WindowStyle Hidden
    return "机器人启动中（约 5 秒）"
}

function Stop-Bot {
    $a = Stop-ByPort -Port 8080 -Name "bot"
    $b = Stop-ByPort -Port 3000 -Name "bot"
    if ($a -or $b) { return "机器人已停止" }
    return "机器人本就没在运行"
}

function Start-Tts {
    if (Test-Port 9880) { return "TTS 已在运行" }
    if (-not (Test-Path $TtsPython)) { return "找不到 TTS 的 python：$TtsPython" }
    if (-not (Test-Path $TtsScript)) { return "找不到 TTS 脚本：$TtsScript" }

    # 直接用 Start-Process 启动 python 本体（不要套 cmd /c 重定向——
    # 实测那样启动会静默失败，python 进程根本不出现）。
    # 输出用 -RedirectStandardOutput / Error 落盘。
    $log = Join-Path $LogDir "tts.log"
    $errLog = Join-Path $LogDir "tts.err.log"
    Start-Process -FilePath $TtsPython `
        -ArgumentList "`"$TtsScript`"", "9880" `
        -WorkingDirectory (Split-Path $TtsScript -Parent) `
        -WindowStyle Hidden `
        -RedirectStandardOutput $log `
        -RedirectStandardError $errLog
    return "TTS 启动中（模型加载约 10-30 秒）"
}

function Stop-Tts {
    if (Stop-ByPort -Port 9880 -Name "tts") { return "TTS 已停止" }
    return "TTS 本就没在运行"
}

function Start-Lagrange {
    if (Test-LagrangeProcess) { return "协议端已在运行" }
    if (-not (Test-Path $LagrangeBat)) { return "找不到 start-lagrange.bat" }
    Start-Process -FilePath $LagrangeBat
    return "协议端启动中（首次需在弹出窗口扫码）"
}

function Stop-Lagrange {
    $p = Get-Process -Name "Lagrange.OneBot" -ErrorAction SilentlyContinue
    if (-not $p) { return "协议端本就没在运行" }

    foreach ($proc in $p) {
        # 先试整棵进程树（Lagrange 会派生子进程）
        & taskkill /PID $proc.Id /T /F 2>$null | Out-Null
    }
    Start-Sleep -Milliseconds 600

    # 兜底：taskkill 失败（权限/子进程卡住）时再试 Stop-Process
    $still = Get-Process -Name "Lagrange.OneBot" -ErrorAction SilentlyContinue
    if ($still) {
        foreach ($proc in $still) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 600
    }

    $final = Get-Process -Name "Lagrange.OneBot" -ErrorAction SilentlyContinue
    if ($final) {
        return "⚠️ 协议端仍在运行（可能权限不足，请手动结束）"
    }
    return "协议端已停止"
}

function Start-Sign {
    if (Test-SignContainer) { return "签名服务已在运行" }
    if (-not (Start-DockerDesktopIfNeeded)) { return "Docker 未就绪，请先启动 Docker Desktop" }
    $r = docker start $SignContainer 2>&1
    if ($LASTEXITCODE -eq 0) { return "签名服务已启动" }
    return "启动失败：$r"
}

function Stop-Sign {
    if (-not (Test-SignContainer)) { return "签名服务本就没在运行" }
    $r = docker stop $SignContainer 2>&1
    if ($LASTEXITCODE -eq 0) { return "签名服务已停止" }
    return "停止失败：$r"
}

# ── 命令行模式 ──────────────────────────────────────────────

function Write-StatusTable {
    $botUp  = (Test-Port 8080) -and (Test-Port 3000)
    $lagUp  = Test-LagrangeProcess
    $signUp = Test-SignContainer
    $ttsUp  = Test-Port 9880
    $docker = Get-DockerReady

    # 逐行输出，不用 Format-Table——中文是双宽字符，表格会对不齐
    $items = @(
        @{ Name = "机器人主程序";   Up = $botUp;  Note = "端口 3000/8080" }
        @{ Name = "Lagrange 协议端"; Up = $lagUp; Note = $(if ($lagUp -and $botUp) { "在线" } elseif ($lagUp) { "未连上机器人" } else { "未运行" }) }
        @{ Name = "签名服务";       Up = $signUp; Note = $(if ($docker) { "Docker 就绪" } else { "Docker 未运行" }) }
        @{ Name = "TTS 语音";       Up = $ttsUp;  Note = "端口 9880" }
    )

    $upCount = 0
    foreach ($it in $items) {
        if ($it.Up) { $upCount++ }
        $mark  = if ($it.Up) { "●" } else { "○" }
        $state = if ($it.Up) { "运行中" } else { "已停止" }
        $color = if ($it.Up) { "Green" } else { "DarkGray" }
        Write-Host ("  $mark " + $it.Name.PadRight(10) + " " + $state + "  " + $it.Note) -ForegroundColor $color
    }
    Write-Host ""
    $totalColor = if ($upCount -eq 4) { "Green" } else { "Yellow" }
    Write-Host "  运行中 $upCount / 4" -ForegroundColor $totalColor
}

if ($Status) {
    Write-Host "`n=== 鲸奈 · QQ 网友 组件状态 ===`n" -ForegroundColor Cyan
    Write-StatusTable
    exit 0
}

if ($StartAll) {
    Write-Host "`n=== 一键启动全部组件 ===`n" -ForegroundColor Cyan
    Write-Host (Start-Sign)
    Start-Sleep -Seconds 2
    Write-Host (Start-Lagrange)
    Start-Sleep -Seconds 2
    Write-Host (Start-Bot)
    Start-Sleep -Seconds 2
    Write-Host (Start-Tts)
    Write-Host "`n提示：机器人约 10 秒就绪，TTS 约 3-10 秒加载模型。`n" -ForegroundColor DarkGray
    exit 0
}

if ($StopAll) {
    Write-Host "`n=== 停止全部组件 ===`n" -ForegroundColor Cyan
    Write-Host (Stop-Bot)
    Write-Host (Stop-Lagrange)
    Write-Host (Stop-Tts)
    Write-Host (Stop-Sign)
    exit 0
}

# ── 界面 ────────────────────────────────────────────────────

$form                 = New-Object System.Windows.Forms.Form
$form.Text            = "鲸奈 · QQ 网友 启动器"
$form.Size            = New-Object System.Drawing.Size(560, 560)
$form.StartPosition   = "CenterScreen"
$form.BackColor       = [System.Drawing.Color]::FromArgb(15, 23, 42)
$form.ForeColor       = [System.Drawing.Color]::FromArgb(226, 232, 240)
$form.Font            = New-Object System.Drawing.Font("Microsoft YaHei UI", 9)
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox     = $false

$title           = New-Object System.Windows.Forms.Label
$title.Text      = "鲸奈 · QQ 网友"
$title.Font      = New-Object System.Drawing.Font("Microsoft YaHei UI", 15, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(96, 165, 250)
$title.Location  = New-Object System.Drawing.Point(24, 16)
$title.Size      = New-Object System.Drawing.Size(300, 34)
$form.Controls.Add($title)

$sub           = New-Object System.Windows.Forms.Label
$sub.Text      = "四个组件一键启停 · 关掉本窗口不影响它们继续运行"
$sub.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$sub.Location  = New-Object System.Drawing.Point(26, 50)
$sub.Size      = New-Object System.Drawing.Size(480, 20)
$form.Controls.Add($sub)

# 组件卡片：名称 / 端口或进程 / 启动 / 停止
$components = @(
    @{ Key="bot";      Label="机器人主程序";  Port=3000; Start={ Start-Bot };      Stop={ Stop-Bot } },
    @{ Key="lagrange"; Label="Lagrange 协议端"; Port=0;  Start={ Start-Lagrange }; Stop={ Stop-Lagrange } },
    @{ Key="sign";     Label="签名服务";      Port=8090; Start={ Start-Sign };     Stop={ Stop-Sign } },
    @{ Key="tts";      Label="TTS 语音";      Port=9880; Start={ Start-Tts };      Stop={ Stop-Tts } }
)

$statusLabels = @{}
$y = 84

foreach ($comp in $components) {
    $panel           = New-Object System.Windows.Forms.Panel
    $panel.Location  = New-Object System.Drawing.Point(20, $y)
    $panel.Size      = New-Object System.Drawing.Size(504, 56)
    $panel.BackColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
    $form.Controls.Add($panel)

    $dot           = New-Object System.Windows.Forms.Label
    $dot.Text      = "●"
    $dot.Font      = New-Object System.Drawing.Font("Segoe UI", 13)
    $dot.ForeColor = [System.Drawing.Color]::FromArgb(248, 113, 113)
    $dot.Location  = New-Object System.Drawing.Point(12, 14)
    $dot.Size      = New-Object System.Drawing.Size(22, 26)
    $panel.Controls.Add($dot)

    $name           = New-Object System.Windows.Forms.Label
    $name.Text      = $comp.Label
    $name.Font      = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
    $name.Location  = New-Object System.Drawing.Point(38, 9)
    $name.Size      = New-Object System.Drawing.Size(200, 22)
    $panel.Controls.Add($name)

    $st           = New-Object System.Windows.Forms.Label
    $st.Text      = "检查中…"
    $st.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
    $st.Location  = New-Object System.Drawing.Point(38, 31)
    $st.Size      = New-Object System.Drawing.Size(250, 18)
    $panel.Controls.Add($st)
    $statusLabels[$comp.Key] = @{ Dot = $dot; Text = $st }

    $btnStart           = New-Object System.Windows.Forms.Button
    $btnStart.Text      = "启动"
    $btnStart.Location  = New-Object System.Drawing.Point(356, 13)
    $btnStart.Size      = New-Object System.Drawing.Size(66, 30)
    $btnStart.FlatStyle = "Flat"
    $btnStart.BackColor = [System.Drawing.Color]::FromArgb(52, 211, 153)
    $btnStart.ForeColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
    $btnStart.FlatAppearance.BorderSize = 0
    $startAction = $comp.Start
    $btnStart.Add_Click({ param($s, $e) Invoke-UiAction $startAction }.GetNewClosure())
    $panel.Controls.Add($btnStart)

    $btnStop           = New-Object System.Windows.Forms.Button
    $btnStop.Text      = "停止"
    $btnStop.Location  = New-Object System.Drawing.Point(428, 13)
    $btnStop.Size      = New-Object System.Drawing.Size(66, 30)
    $btnStop.FlatStyle = "Flat"
    $btnStop.BackColor = [System.Drawing.Color]::FromArgb(248, 113, 113)
    $btnStop.ForeColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
    $btnStop.FlatAppearance.BorderSize = 0
    $stopAction = $comp.Stop
    $btnStop.Add_Click({ param($s, $e) Invoke-UiAction $stopAction }.GetNewClosure())
    $panel.Controls.Add($btnStop)

    $y += 64
}

# 底部按钮
$btnAll           = New-Object System.Windows.Forms.Button
$btnAll.Text      = "一键全部启动"
$btnAll.Location  = New-Object System.Drawing.Point(20, $y + 8)
$btnAll.Size      = New-Object System.Drawing.Size(240, 40)
$btnAll.FlatStyle = "Flat"
$btnAll.BackColor = [System.Drawing.Color]::FromArgb(96, 165, 250)
$btnAll.ForeColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
$btnAll.Font      = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
$btnAll.FlatAppearance.BorderSize = 0
$form.Controls.Add($btnAll)

$btnStopAll           = New-Object System.Windows.Forms.Button
$btnStopAll.Text      = "全部停止"
$btnStopAll.Location  = New-Object System.Drawing.Point(284, $y + 8)
$btnStopAll.Size      = New-Object System.Drawing.Size(240, 40)
$btnStopAll.FlatStyle = "Flat"
$btnStopAll.BackColor = [System.Drawing.Color]::FromArgb(71, 85, 105)
$btnStopAll.ForeColor = [System.Drawing.Color]::FromArgb(226, 232, 240)
$btnStopAll.Font      = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
$btnStopAll.FlatAppearance.BorderSize = 0
$form.Controls.Add($btnStopAll)

$btnPanel           = New-Object System.Windows.Forms.Button
$btnPanel.Text      = "打开机器人控制面板"
$btnPanel.Location  = New-Object System.Drawing.Point(20, $y + 56)
$btnPanel.Size      = New-Object System.Drawing.Size(240, 32)
$btnPanel.FlatStyle = "Flat"
$btnPanel.BackColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
$btnPanel.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$btnPanel.FlatAppearance.BorderSize = 0
$form.Controls.Add($btnPanel)

$btnLogs           = New-Object System.Windows.Forms.Button
$btnLogs.Text      = "打开日志目录"
$btnLogs.Location  = New-Object System.Drawing.Point(284, $y + 56)
$btnLogs.Size      = New-Object System.Drawing.Size(240, 32)
$btnLogs.FlatStyle = "Flat"
$btnLogs.BackColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
$btnLogs.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$btnLogs.FlatAppearance.BorderSize = 0
$form.Controls.Add($btnLogs)

$statusBar           = New-Object System.Windows.Forms.Label
$statusBar.Text      = "就绪"
$statusBar.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$statusBar.Location  = New-Object System.Drawing.Point(22, $y + 94)
$statusBar.Size      = New-Object System.Drawing.Size(510, 20)
$form.Controls.Add($statusBar)

# ── 交互逻辑 ────────────────────────────────────────────────

function Set-StatusText {
    param([string]$Msg)
    $statusBar.Text = "$(Get-Date -Format 'HH:mm:ss')  $Msg"
    $statusBar.Refresh()
}

function Invoke-UiAction {
    param([scriptblock]$Action)
    try {
        $msg = & $Action
        Set-StatusText $msg
    } catch {
        Set-StatusText "操作失败：$($_.Exception.Message)"
    }
    Update-AllStatus
}

function Update-AllStatus {
    # 机器人：8080 + 3000 都在监听才算健康
    $botUp = (Test-Port 8080) -and (Test-Port 3000)
    $s = $statusLabels["bot"]
    if ($botUp) {
        $s.Dot.ForeColor = [System.Drawing.Color]::FromArgb(52, 211, 153)
        $s.Text.Text = "运行中 · 端口 3000/8080"
        $s.Text.ForeColor = [System.Drawing.Color]::FromArgb(52, 211, 153)
    } else {
        $s.Dot.ForeColor = [System.Drawing.Color]::FromArgb(248, 113, 113)
        $s.Text.Text = "已停止"
        $s.Text.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
    }

    # Lagrange：看进程
    $lagUp = Test-LagrangeProcess
    $s = $statusLabels["lagrange"]
    if ($lagUp) {
        $s.Dot.ForeColor = [System.Drawing.Color]::FromArgb(52, 211, 153)
        $s.Text.Text = if ($botUp) { "运行中 · 在线" } else { "运行中 · 未连上机器人" }
        $s.Text.ForeColor = [System.Drawing.Color]::FromArgb(52, 211, 153)
    } else {
        $s.Dot.ForeColor = [System.Drawing.Color]::FromArgb(248, 113, 113)
        $s.Text.Text = "已停止"
        $s.Text.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
    }

    # 签名服务
    $signUp = Test-SignContainer
    $s = $statusLabels["sign"]
    if ($signUp) {
        $s.Dot.ForeColor = [System.Drawing.Color]::FromArgb(52, 211, 153)
        $s.Text.Text = "运行中 · 容器健康"
        $s.Text.ForeColor = [System.Drawing.Color]::FromArgb(52, 211, 153)
    } else {
        $s.Dot.ForeColor = [System.Drawing.Color]::FromArgb(248, 113, 113)
        $s.Text.Text = if (Get-DockerReady) { "已停止" } else { "已停止 · Docker 未运行" }
        $s.Text.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
    }

    # TTS
    $ttsUp = Test-Port 9880
    $s = $statusLabels["tts"]
    if ($ttsUp) {
        $s.Dot.ForeColor = [System.Drawing.Color]::FromArgb(52, 211, 153)
        $s.Text.Text = "运行中 · 服务就绪"
        $s.Text.ForeColor = [System.Drawing.Color]::FromArgb(52, 211, 153)
    } else {
        $s.Dot.ForeColor = [System.Drawing.Color]::FromArgb(248, 113, 113)
        $s.Text.Text = "已停止"
        $s.Text.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
    }
}

$btnAll.Add_Click({
    Set-StatusText "正在启动全部组件…"
    # 顺序有讲究：签名服务 → 协议端 → 机器人 → TTS
    Set-StatusText (& { Start-Sign })
    Start-Sleep -Seconds 2
    Set-StatusText (& { Start-Lagrange })
    Start-Sleep -Seconds 2
    Set-StatusText (& { Start-Bot })
    Start-Sleep -Seconds 2
    Set-StatusText (& { Start-Tts })
    Update-AllStatus
})

$btnStopAll.Add_Click({
    Set-StatusText "正在停止全部组件…"
    & { Stop-Bot }      | Out-Null
    & { Stop-Lagrange } | Out-Null
    & { Stop-Tts }      | Out-Null
    & { Stop-Sign }     | Out-Null
    Set-StatusText "全部组件已停止"
    Update-AllStatus
})

$btnPanel.Add_Click({
    Start-Process "http://127.0.0.1:3000/panel"
    Set-StatusText "已在浏览器打开控制面板"
})

$btnLogs.Add_Click({
    Start-Process "explorer.exe" $LogDir
    Set-StatusText "已打开日志目录：$LogDir"
})

# 定时刷新
$timer          = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-AllStatus })
$timer.Start()

$form.Add_Shown({
    Update-AllStatus
    Set-StatusText "就绪 · 点「一键全部启动」开始"
})

[void]$form.ShowDialog()
