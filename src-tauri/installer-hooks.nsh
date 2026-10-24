; Versions 1.x were an Electron app, installed by electron-builder in another
; folder and registered under another uninstall entry. Installing this version
; over it would leave both side by side (two Start menu entries, two apps
; fighting for the overlay port), so the old one is silently uninstalled first.
; Its settings (%APPDATA%\Wakfu Combo Overlay) are kept: electron-builder's
; uninstaller leaves them alone, and this version reads the same file.

!macro NSIS_HOOK_PREINSTALL
  StrCpy $R9 "$LOCALAPPDATA\Programs\wakfu-combo-overlay"
  IfFileExists "$R9\Uninstall Wakfu Combo Overlay.exe" 0 wco_no_electron_install
    DetailPrint "Désinstallation de l'ancienne version (Electron)…"
    ; _?= makes ExecWait actually wait (the uninstaller otherwise relaunches
    ; itself from %TEMP% and returns at once), at the cost of leaving the
    ; uninstaller itself behind — hence the RMDir.
    ExecWait '"$R9\Uninstall Wakfu Combo Overlay.exe" /currentuser /S _?=$R9'
    RMDir /r "$R9"
  wco_no_electron_install:
!macroend
