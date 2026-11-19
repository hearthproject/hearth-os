!macro NSIS_HOOK_PREINSTALL
  ; Keep application files out of %LOCALAPPDATA%\Hearth, which is the data root.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Hearth"
  CreateDirectory "$INSTDIR"
  ; Hashed web assets change every build; remove the old set before extracting.
  RMDir /r "$INSTDIR\resources\web"
  SetOutPath "$INSTDIR"
!macroend
