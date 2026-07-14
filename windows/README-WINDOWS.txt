ROULEUR for Windows
===================

This machine (the one that built this) is a Mac with no Windows compiler
available, so this isn't a compiled .exe — it's a genuine double-click
launcher that opens the real app (the same HTML/CSS/JS as the Mac version)
in your default browser, with its own custom icon. No install, no Node,
no Python needed on your PC.

HOW TO USE
----------
1. Unzip this folder anywhere (Desktop, Documents, etc.) and keep all the
   files together.
2. Double-click "Create Desktop Shortcut.vbs" once. It adds a "Rouleur"
   icon to your Desktop (uses rouleur.ico — the real app icon).
3. From then on, just double-click the Rouleur icon on your Desktop to
   launch the app. (Or skip the shortcut and just double-click
   "Rouleur.vbs" directly, any time.)

If Windows SmartScreen warns about the .vbs file (common for any script
you download from the internet), click "More info" -> "Run anyway". You
can open Rouleur.vbs and Create Desktop Shortcut.vbs in Notepad first to
see exactly what they do — they only open a local HTML file and create a
desktop shortcut, nothing else.

WHAT WORKS
----------
Everything: drawing/generating routes, sightseeing markers, elevation,
road-surface breakdown, wind, cafe/water stops, saved routes, GPX export,
team kits. It needs an internet connection (map tiles + routing APIs).

ONE CAVEAT
----------
"Center on my location" uses browser geolocation, which some browsers
restrict for local files opened this way. If it doesn't prompt you for
location, just use the search box or click the map to set your start
point instead — everything else is unaffected.

FILES
-----
app/              the web app (index.html, style.css, app.js, icons)
Rouleur.vbs                   launches the app (no console window)
Create Desktop Shortcut.vbs   one-time: adds a desktop icon
