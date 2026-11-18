!macro customInstall
  CreateShortCut "$DESKTOP\Hearth.lnk" "$INSTDIR\Hearth.exe" "" "$INSTDIR\Hearth.exe" 0 "" "" "Hearth"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Hearth.lnk"
  nsExec::ExecToLog 'taskkill /IM Hearth.exe /T /F'
!macroend
