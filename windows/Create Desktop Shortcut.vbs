' Creates a "Rouleur" shortcut on the Desktop with the real Rouleur icon.
' Run this once (double-click), then launch the app from the Desktop icon.
Dim fso, shell, here, desktop, link
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = shell.SpecialFolders("Desktop")

Set link = shell.CreateShortcut(fso.BuildPath(desktop, "Rouleur.lnk"))
link.TargetPath = fso.BuildPath(here, "Rouleur.vbs")
link.WorkingDirectory = here
link.IconLocation = fso.BuildPath(fso.BuildPath(here, "app"), "rouleur.ico") & ",0"
link.Description = "Rouleur - retro roadbike route builder"
link.Save

MsgBox "Rouleur shortcut created on your Desktop.", 64, "Rouleur"
