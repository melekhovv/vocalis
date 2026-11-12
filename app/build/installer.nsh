!macro customInstall
  CreateDirectory "$SMPROGRAMS\Vocalis"
  CreateShortCut "$SMPROGRAMS\Vocalis\Удалить Vocalis.lnk" "$INSTDIR\Uninstall Vocalis.exe" "" "$INSTDIR\Uninstall Vocalis.exe" 0
!macroend

!macro customUnInit
  nsExec::ExecToLog 'taskkill /F /IM "Vocalis.exe" /T'
  nsExec::ExecToLog `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath -like ('*' + $$env:LOCALAPPDATA + '\Vocalis\runtime*') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Vocalis\Удалить Vocalis.lnk"
  RMDir "$SMPROGRAMS\Vocalis"

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.vocalis"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Vocalis"

  IfSilent skip_deps
  MessageBox MB_YESNO|MB_ICONQUESTION "Удалить загруженные зависимости (Python, PyTorch, базовые нейросети), кэш и настройки приложения?$\r$\n$\r$\nЭто освободит несколько гигабайт на диске. Ваши голосовые модели в папке voices останутся нетронутыми." IDNO skip_deps
    RMDir /r "$LOCALAPPDATA\Vocalis\runtime"
    RMDir /r "$LOCALAPPDATA\Vocalis\rvc"
    RMDir /r "$LOCALAPPDATA\Vocalis\cache"
    RMDir /r "$LOCALAPPDATA\Vocalis\previews"
    RMDir /r "$LOCALAPPDATA\Vocalis\applio"
    Delete "$LOCALAPPDATA\Vocalis\engine-settings.json"
    RMDir /r "$APPDATA\Vocalis"
    IfFileExists "$LOCALAPPDATA\Vocalis\voices\*.*" skip_deps
      RMDir /r "$LOCALAPPDATA\Vocalis"
  skip_deps:
!macroend
