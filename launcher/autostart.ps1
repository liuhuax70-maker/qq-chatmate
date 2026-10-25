# =========================================================
#  Enable / disable auto-start at Windows login
#
#  Usage:
#    autostart.ps1 on      - enable (start all components at login)
#    autostart.ps1 off     - disable
#    autostart.ps1 check   - show current state
#
#  Why a scheduled task instead of a registry Run entry:
#    The launcher needs administrator rights because NapCat injects
#    into the QQ process. A registry Run entry starts with normal
#    rights and triggers a UAC prompt at every login. A scheduled
#    task with -RunLevel Highest starts silently with admin rights.
# =========================================================

param(
    [Parameter(Position = 0)]
    [string]$Mode = 'check'
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'QinaiChatmateLauncher'

# 找 GUI 版启动器：名字里不含 "状态"/"status" 的那个 exe
$exe = Get-ChildItem -Path $here -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -notmatch '状态|status' } |
    Select-Object -First 1

switch ($Mode.ToLower()) {
    'on' {
        if (-not $exe) {
            Write-Host '[ERROR] 找不到启动器 exe，请先运行 build.bat' -ForegroundColor Red
            exit 1
        }

        # 清掉可能存在的旧注册表项（历史遗留）
        Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
            -Name 'QinaiChatmateLauncher' -ErrorAction SilentlyContinue

        $taskAction = New-ScheduledTaskAction -Execute $exe.FullName -Argument '-silent'
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -StartWhenAvailable
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
            -LogonType Interactive -RunLevel Highest

        Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger `
            -Settings $settings -Principal $principal -Force | Out-Null

        Write-Host "[OK] 开机自启已开启（计划任务）" -ForegroundColor Green
        Write-Host "     $($exe.FullName) -silent"
        Write-Host "     登录时以最高权限静默启动，不弹 UAC。"
        exit 0
    }

    'off' {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
            -Name 'QinaiChatmateLauncher' -ErrorAction SilentlyContinue
        Write-Host '[OK] 开机自启已关闭' -ForegroundColor Green
        exit 0
    }

    'check' {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            Write-Host '[STATE] 开机自启已开启（计划任务）' -ForegroundColor Green
            Write-Host "        State: $($task.State)"
        }
        else {
            Write-Host '[STATE] 开机自启未开启'
        }
        exit 0
    }

    default {
        Write-Host '用法: autostart.ps1 [on|off|check]'
        exit 2
    }
}
