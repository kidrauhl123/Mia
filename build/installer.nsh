; Windows upgrades must release every executable bundled under $INSTDIR before
; electron-builder's NSIS uninstaller swaps the old application directory. The
; stock macro detects processes under the directory, but only terminates
; Mia.exe; Mia Core is a separate mia-core.exe process and can otherwise keep
; resources\bundled-mia-core\... locked during an in-app update.
;
; This macro is consumed by electron-builder's CHECK_APP_RUNNING hook for both
; interactive installs and silent electron-updater installs.

; electron-builder runs the *old* uninstaller during an update. Its atomic
; removal routine stages the old files beneath $PLUGINSDIR. When TEMP is on a
; different drive, Windows turns that operation into a copy. Endpoint scanners
; can then open a freshly copied DLL (for example dxcompiler.dll) before the
; old uninstaller has finished with it, causing a transient sharing violation
; that old NSIS uninstallers treat as fatal. Keep the updater's temporary files
; on the install volume so this remains an atomic rename instead.
;
; SetEnvironmentVariable only changes this installer process and its children;
; it does not persistently change the user's TEMP/TMP settings.
;
; The incoming installer invokes the installed version's uninstaller as a
; child process. Set TEMP/TMP before that call so even releases that predate
; customUnInit inherit a same-volume staging directory. `customInit` runs
; after electron-builder resolves $INSTDIR in both the regular installer and
; its UAC-elevated inner instance. Restrict this to an upgrade in the installer
; build: a normal uninstaller must not create its temporary directory inside
; the folder it is about to remove.
!macro prepareLegacyUninstallerTemp
  !ifndef BUILD_UNINSTALLER
    ${If} ${FileExists} "$INSTDIR\Uninstall ${PRODUCT_NAME}.exe"
      StrCpy $R9 "$INSTDIR.__mia_update_tmp"
      ClearErrors
      CreateDirectory "$R9"
      ${IfNot} ${Errors}
        System::Call 'Kernel32::SetEnvironmentVariable(t "TEMP", t "$R9") i.r2'
        System::Call 'Kernel32::SetEnvironmentVariable(t "TMP", t "$R9") i.r2'
        DetailPrint "Using same-volume temporary directory for the legacy uninstaller: $R9"
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro customInit
  !insertmacro prepareLegacyUninstallerTemp
!macroend

; New uninstallers repeat the protection while handling --updated directly.
; This is defense in depth; it cannot repair an already-installed historical
; uninstaller, which is why the incoming installer hook above is required.
!macro customUnInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $R9 "$INSTDIR.__mia_update_tmp"
    ClearErrors
    CreateDirectory "$R9"
    ${IfNot} ${Errors}
      System::Call 'Kernel32::SetEnvironmentVariable(t "TEMP", t "$R9") i.r2'
      System::Call 'Kernel32::SetEnvironmentVariable(t "TMP", t "$R9") i.r2'
      DetailPrint "Using same-volume temporary directory for the update: $R9"
    ${EndIf}
  ${EndIf}
!macroend

!macro customCheckAppRunning
  ; Prefer an executable-path scoped sweep so an unrelated Mia/Core installation
  ; is not touched. Double dollar signs preserve PowerShell variables through
  ; NSIS preprocessing.
  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { param([string]$$root); $$root = [IO.Path]::GetFullPath($$root).TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 600 }" "$INSTDIR"`
  Pop $0

  ; Windows 10/11 normally has PowerShell. Keep a narrow image-name fallback
  ; for policy-restricted hosts so a lingering Core cannot block an upgrade.
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /T /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" >NUL 2>&1`
  Pop $0
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /T /F /IM "mia-core.exe" /FI "USERNAME eq %USERNAME%" >NUL 2>&1`
  Pop $0
  Sleep 800
!macroend
