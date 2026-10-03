' 双击这个文件启动，不弹控制台窗口。
' 需要日志时改用同目录的「启动 Mili 播放器.cmd」。

Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = root
shell.Run """" & root & "\启动 Mili 播放器.cmd""", 0, False
