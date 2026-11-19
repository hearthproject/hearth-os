!macro NSIS_HOOK_PREINSTALL
  ; Keep application files out of %LOCALAPPDATA%\Hearth, which is the data root.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Hearth"
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
!macroend
