!include "LogicLib.nsh"
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

; Apply to both the installer and generated uninstaller, including nsDialogs.
!macro customHeader
  SetFont "Microsoft YaHei UI" 9
!macroend

!define Z_PATH_SCRIPT "JABFAHIAcgBvAHIAQQBjAHQAaQBvAG4AUAByAGUAZgBlAHIAZQBuAGMAZQA9ACcAUwB0AG8AcAAnAAoAJABzAGMAbwBwAGUAPQAkAGUAbgB2ADoAWQBBAE4AXwBBAEcARQBOAFQAXwBQAEEAVABIAF8AUwBDAE8AUABFAAoAJABkAGkAcgA9AFsASQBPAC4AUABhAHQAaABdADoAOgBHAGUAdABGAHUAbABsAFAAYQB0AGgAKAAkAGUAbgB2ADoAWQBBAE4AXwBBAEcARQBOAFQAXwBQAEEAVABIAF8ARABJAFIAKQAuAFQAcgBpAG0ARQBuAGQAKAAnAFwAJwApAAoAJABhAGMAdABpAG8AbgA9ACQAZQBuAHYAOgBZAEEATgBfAEEARwBFAE4AVABfAFAAQQBUAEgAXwBBAEMAVABJAE8ATgAKACQAYwB1AHIAcgBlAG4AdAA9AFsARQBuAHYAaQByAG8AbgBtAGUAbgB0AF0AOgA6AEcAZQB0AEUAbgB2AGkAcgBvAG4AbQBlAG4AdABWAGEAcgBpAGEAYgBsAGUAKAAnAFAAYQB0AGgAJwAsACQAcwBjAG8AcABlACkACgAkAGkAdABlAG0AcwA9AEAAKAAkAGMAdQByAHIAZQBuAHQAIAAtAHMAcABsAGkAdAAgACcAOwAnACAAfAAgAFcAaABlAHIAZQAtAE8AYgBqAGUAYwB0ACAAewAgAC0AbgBvAHQAIABbAHMAdAByAGkAbgBnAF0AOgA6AEkAcwBOAHUAbABsAE8AcgBXAGgAaQB0AGUAUwBwAGEAYwBlACgAJABfACkAIAB9ACkACgAkAG0AYQB0AGMAaABlAHMAPQBAACgAJABpAHQAZQBtAHMAIAB8ACAAVwBoAGUAcgBlAC0ATwBiAGoAZQBjAHQAIAB7ACAAJABfAC4AVAByAGkAbQAoACkALgBUAHIAaQBtACgAJwAiACcAKQAuAFQAcgBpAG0ARQBuAGQAKAAnAFwAJwApACAALQBpAGUAcQAgACQAZABpAHIAIAB9ACkACgBpAGYAKAAkAGEAYwB0AGkAbwBuACAALQBlAHEAIAAnAGEAZABkACcAIAAtAGEAbgBkACAAJABtAGEAdABjAGgAZQBzAC4AQwBvAHUAbgB0ACAALQBlAHEAIAAwACkAewAKACAAIAAkAG4AZQB4AHQAPQBpAGYAKABbAHMAdAByAGkAbgBnAF0AOgA6AEkAcwBOAHUAbABsAE8AcgBXAGgAaQB0AGUAUwBwAGEAYwBlACgAJABjAHUAcgByAGUAbgB0ACkAKQB7ACQAZABpAHIAfQBlAGwAcwBlAHsAJABjAHUAcgByAGUAbgB0AC4AVAByAGkAbQBFAG4AZAAoACcAOwAnACkAKwAnADsAJwArACQAZABpAHIAfQAKACAAIABbAEUAbgB2AGkAcgBvAG4AbQBlAG4AdABdADoAOgBTAGUAdABFAG4AdgBpAHIAbwBuAG0AZQBuAHQAVgBhAHIAaQBhAGIAbABlACgAJwBQAGEAdABoACcALAAkAG4AZQB4AHQALAAkAHMAYwBvAHAAZQApAAoAfQBlAGwAcwBlAGkAZgAoACQAYQBjAHQAaQBvAG4AIAAtAGUAcQAgACcAcgBlAG0AbwB2AGUAJwAgAC0AYQBuAGQAIAAkAG0AYQB0AGMAaABlAHMALgBDAG8AdQBuAHQAIAAtAGcAdAAgADAAKQB7AAoAIAAgACQAbgBlAHgAdAA9AEAAKAAkAGkAdABlAG0AcwAgAHwAIABXAGgAZQByAGUALQBPAGIAagBlAGMAdAAgAHsAIAAkAF8ALgBUAHIAaQBtACgAKQAuAFQAcgBpAG0AKAAnACIAJwApAC4AVAByAGkAbQBFAG4AZAAoACcAXAAnACkAIAAtAGkAbgBlACAAJABkAGkAcgAgAH0AKQAgAC0AagBvAGkAbgAgACcAOwAnAAoAIAAgAFsARQBuAHYAaQByAG8AbgBtAGUAbgB0AF0AOgA6AFMAZQB0AEUAbgB2AGkAcgBvAG4AbQBlAG4AdABWAGEAcgBpAGEAYgBsAGUAKAAnAFAAYQB0AGgAJwAsACQAbgBlAHgAdAAsACQAcwBjAG8AcABlACkACgB9AA=="

!macro RunZPathUpdateForScope ACTION SCOPE
  System::Call 'Kernel32::SetEnvironmentVariable(t "Z_AGENT_PATH_SCOPE", t "${SCOPE}") i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "Z_AGENT_PATH_DIR", t "$INSTDIR") i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "Z_AGENT_PATH_ACTION", t "${ACTION}") i.r0'
  nsExec::ExecToLog 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Z_PATH_SCRIPT}'
  Pop $R9
!macroend

!macro RunZPathUpdate ACTION
  !insertmacro RunZPathUpdateForScope "${ACTION}" "User"
  !insertmacro RunZPathUpdateForScope "${ACTION}" "Machine"

  System::Call 'Kernel32::SetEnvironmentVariable(t "Z_AGENT_PATH_SCOPE", p 0) i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "Z_AGENT_PATH_DIR", p 0) i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "Z_AGENT_PATH_ACTION", p 0) i.r0'
  System::Call 'User32::SendMessageTimeout(i ${HWND_BROADCAST}, i ${WM_SETTINGCHANGE}, i 0, t "Environment", i 0x0002, i 5000, *i .r0)'
!macroend

!ifndef BUILD_UNINSTALLER
  Var ZAddToPathCheckbox
  Var ZAddToPathRequested

  !macro customInit
    StrCpy $ZAddToPathRequested "1"
    ClearErrors
    ReadRegDWORD $R8 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "AddToPath"
    ${IfNot} ${Errors}
      StrCpy $ZAddToPathRequested $R8
    ${EndIf}
  !macroend

  !macro customPageAfterChangeDir
    Page custom ZPathPageCreate ZPathPageLeave
  !macroend

  Function ZPathPageCreate
    !insertmacro MUI_HEADER_TEXT "环境配置" "让 IDE 和终端能够找到 Z"
    nsDialogs::Create 1018
    Pop $R8
    ${If} $R8 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 22u "选择是否将 Z 的安装目录同时加入用户与系统 PATH。"
    Pop $R8
    ${NSD_CreateCheckbox} 0 32u 100% 18u "加入 PATH（推荐）"
    Pop $ZAddToPathCheckbox
    ${If} $ZAddToPathRequested == "1"
      ${NSD_Check} $ZAddToPathCheckbox
    ${EndIf}
    ${NSD_CreateLabel} 18u 54u 94% 34u "启用后，IDE、PowerShell 和命令提示符可以直接定位并启动 Z。安装程序将请求管理员权限，新终端窗口会自动生效。"
    Pop $R8

    nsDialogs::Show
  FunctionEnd

  Function ZPathPageLeave
    ${NSD_GetState} $ZAddToPathCheckbox $R8
    ${If} $R8 == ${BST_CHECKED}
      StrCpy $ZAddToPathRequested "1"
    ${Else}
      StrCpy $ZAddToPathRequested "0"
    ${EndIf}
  FunctionEnd

  !macro customInstall
    WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "AddToPath" $ZAddToPathRequested
    ${If} $ZAddToPathRequested == "1"
      !insertmacro RunZPathUpdate "add"
    ${Else}
      !insertmacro RunZPathUpdate "remove"
    ${EndIf}
  !macroend
!else
  Var ZClearDataCheckbox
  Var ZClearDataRequested
  Var ZClearDataFailed

  !macro customUnInit
    StrCpy $ZClearDataRequested "0"
    StrCpy $ZClearDataFailed "0"
  !macroend

  !macro customUnWelcomePage
    UninstPage custom un.ZDataPageCreate un.ZDataPageLeave
  !macroend

  Function un.ZDataPageCreate
    !insertmacro MUI_HEADER_TEXT "卸载选项" "选择是否同时清除本机保存的 Z 数据"
    nsDialogs::Create 1018
    Pop $R8
    ${If} $R8 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 34u "普通卸载会保留配置、会话、技能和媒体缓存，方便以后重新安装后继续使用。"
    Pop $R8
    ${NSD_CreateCheckbox} 0 46u 100% 18u "清除当前 Windows 用户的 Z 数据"
    Pop $ZClearDataCheckbox
    ${If} $ZClearDataRequested == "1"
      ${NSD_Check} $ZClearDataCheckbox
    ${Else}
      ${NSD_Uncheck} $ZClearDataCheckbox
    ${EndIf}
    ${NSD_CreateLabel} 18u 70u 94% 56u "勾选后删除当前 Windows 用户的 Z 配置、会话、浏览器缓存、运行时和技能存储。保留工作区、其他应用及共享临时缓存；若使用另一管理员账号运行，请在原账号下卸载。"
    Pop $R8

    nsDialogs::Show
  FunctionEnd

  Function un.ZDataPageLeave
    ${NSD_GetState} $ZClearDataCheckbox $R8
    ${If} $R8 == ${BST_CHECKED}
      StrCpy $ZClearDataRequested "1"
    ${Else}
      StrCpy $ZClearDataRequested "0"
    ${EndIf}
  FunctionEnd

  Function un.ZStopProcesses
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $R8
    Sleep 500
  FunctionEnd

  Function un.ZRemoveDataPath
    Exch $R0
    Push $R1
    Push $R2
    System::Call 'Kernel32::GetFileAttributes(t "$R0") i.R1'
    ${If} $R1 == -1
      DetailPrint "目录不存在，跳过：$R0"
      Goto z_remove_done
    ${EndIf}
    StrCpy $R2 0
    z_remove_retry:
      ClearErrors
      RMDir /r "$R0"
      System::Call 'Kernel32::GetFileAttributes(t "$R0") i.R1'
      ${If} $R1 == -1
        DetailPrint "已清除：$R0"
        Goto z_remove_done
      ${EndIf}
      IntOp $R2 $R2 + 1
      ${If} $R2 < 3
        Sleep 500
        Goto z_remove_retry
      ${EndIf}
      StrCpy $ZClearDataFailed "1"
      DetailPrint "清理失败，仍有残留：$R0"
    z_remove_done:
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  Function un.ZClearData
    Call un.ZStopProcesses

    ; Electron data is per-user even when the application is installed for
    ; all users. In 'all' context APPDATA resolves to ProgramData instead.
    SetShellVarContext current
    StrCpy $ZClearDataFailed "0"

    ; Z retains these pre-rename fork profiles. Never remove upstream Z
    ; profiles or shared temporary caches, which may belong to another app.
    Push "$APPDATA\wd-agent"
    Call un.ZRemoveDataPath
    Push "$APPDATA\WD Agent"
    Call un.ZRemoveDataPath
    Push "$LOCALAPPDATA\wd-agent"
    Call un.ZRemoveDataPath
    Push "$LOCALAPPDATA\WD Agent"
    Call un.ZRemoveDataPath

    ${If} $ZClearDataFailed == "1"
      SetErrorLevel 1
      MessageBox MB_OK|MB_ICONEXCLAMATION "部分 Z 数据未能删除，可能仍被其他进程占用。请在卸载详情中查看残留路径。" /SD IDOK
    ${Else}
      DetailPrint "Z 本机数据清理完成。"
    ${EndIf}
  FunctionEnd

  !macro customUnInstall
    !insertmacro RunZPathUpdate "remove"
    ${If} $ZClearDataRequested == "1"
      Call un.ZClearData
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
    ${EndIf}
  !macroend
!endif
