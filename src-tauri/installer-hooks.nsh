; Two earlier installs would otherwise end up side by side with this one (two
; Start menu entries, two apps fighting for the overlay port), so they are
; silently uninstalled first:
;
;  - the 1.x versions, an Electron app installed by electron-builder in
;    %LOCALAPPDATA%\Programs\wakfu-combo-overlay;
;  - the 2.x versions up to 2.3.x, when the app was still called "Wakfu Combo
;    Overlay": Tauri installs in a folder named after the product, so renaming
;    it makes the updater's installer land in a new folder.
;
; Their settings (%APPDATA%\Wakfu Combo Overlay) are kept — neither uninstaller
; touches them — and this version copies them to %APPDATA%\Taktik at launch.

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

  StrCpy $R9 "$LOCALAPPDATA\Wakfu Combo Overlay"
  IfFileExists "$R9\uninstall.exe" 0 wco_no_renamed_install
    DetailPrint "Désinstallation de l'ancienne version (Wakfu Combo Overlay)…"
    ExecWait '"$R9\uninstall.exe" /S _?=$R9'
    RMDir /r "$R9"
  wco_no_renamed_install:
!macroend
