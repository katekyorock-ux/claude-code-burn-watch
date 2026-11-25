' run-hidden.vbs - runs burn-watch.js once without opening a console window (used by install-task.ps1).
' Output is appended to %USERPROFILE%\.claude-code-burn-watch\burn-watch.log
' Needs node on the PATH.
Option Explicit
Dim sh, fso, script, logDir, logFile
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
script = fso.BuildPath(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)), "burn-watch.js")
logDir = fso.BuildPath(sh.ExpandEnvironmentStrings("%USERPROFILE%"), ".claude-code-burn-watch")
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logFile = fso.BuildPath(logDir, "burn-watch.log")
' 0 = hidden window, True = wait until it finishes
sh.Run "cmd /c ""node """ & script & """ >> """ & logFile & """ 2>&1""", 0, True
