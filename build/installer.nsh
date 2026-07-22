; Windows upgrades must release every executable bundled under $INSTDIR before
; electron-builder's NSIS uninstaller swaps the old application directory. The
; stock macro detects processes under the directory, but only terminates
; Mia.exe; Mia Core is a separate mia-core.exe process and can otherwise keep
; resources\bundled-mia-core\... locked during an in-app update.
;
; This macro is consumed by electron-builder's CHECK_APP_RUNNING hook for both
; interactive installs and silent electron-updater installs.
!macro customCheckAppRunning
  ; Prefer an executable-path scoped sweep so an unrelated Mia/Core installation
  ; is not touched. Double dollar signs preserve PowerShell variables through
  ; NSIS preprocessing.
  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "param([string]$$root); $$root = [IO.Path]::GetFullPath($$root).TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 600" "$INSTDIR"`
  Pop $0

  ; Windows 10/11 normally has PowerShell. Keep a narrow image-name fallback
  ; for policy-restricted hosts so a lingering Core cannot block an upgrade.
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /T /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" >NUL 2>&1`
  Pop $0
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /T /F /IM "mia-core.exe" /FI "USERNAME eq %USERNAME%" >NUL 2>&1`
  Pop $0
  Sleep 800
!macroend
