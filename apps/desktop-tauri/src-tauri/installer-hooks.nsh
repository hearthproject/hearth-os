!macro NSIS_HOOK_PREINSTALL
  ; Keep application files out of %LOCALAPPDATA%\Hearth, which is the data root.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Hearth"
  CreateDirectory "$INSTDIR"
  ; Hashed web assets change every build; remove the old set before extracting.
  RMDir /r "$INSTDIR\resources\web"
  SetOutPath "$INSTDIR"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Older builds installed Hearth.exe; the binary is now hearth_desktop.exe.
  ; Tauri's update mode skips desktop shortcut creation, so repair the stale
  ; shortcut in place instead of leaving a blank shell icon.
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend
