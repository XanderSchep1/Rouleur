' Rouleur launcher - opens the app in your default browser, no console window.
Dim fso, shell, here, target
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.BuildPath(fso.BuildPath(here, "app"), "index.html")
shell.Run """" & target & """", 1, False
