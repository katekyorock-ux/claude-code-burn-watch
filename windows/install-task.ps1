# Registers a Windows scheduled task that runs burn-watch.js every 15 minutes without a console window.
#   Install: powershell -ExecutionPolicy Bypass -File windows\install-task.ps1
#   Remove:  Unregister-ScheduledTask -TaskName claude-code-burn-watch -Confirm:$false
# Log: %USERPROFILE%\.claude-code-burn-watch\burn-watch.log
$ErrorActionPreference = 'Stop'
$name = 'claude-code-burn-watch'
$vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$trigger = New-ScheduledTaskTrigger -Daily -At '00:00'
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'claude-code-burn-watch: check Claude Code usage every 15 minutes' -Force | Out-Null
$task = Get-ScheduledTask -TaskName $name
"Registered '$($task.TaskName)' ($($task.State)), every $($task.Triggers[0].Repetition.Interval)."
"Log: $env:USERPROFILE\.claude-code-burn-watch\burn-watch.log"
