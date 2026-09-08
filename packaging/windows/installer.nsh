; installer.nsh — Ion NSIS custom install/uninstall macros.
;
; WinMessages.nsh supplies WM_SETTEXT, which ionPhase uses to write the MUI
; page header. electron-builder's templates do not include it, and an
; undefined constant fails the build rather than degrading quietly.
;
!include WinMessages.nsh
;
; Install log.
;
; NSIS writes no log of its own, and a silent install has no details pane, so
; an MDM deployment that fails leaves nothing behind saying which branch it
; took. Every phase below appends a line to $TEMP\Ion-Setup.log. %TEMP%
; resolves per deploying account, so an Intune install running as SYSTEM lands
; in C:\Windows\Temp where an administrator can collect it, and a
; double-click install lands in the user's own temp directory.
;
; Failure to open the log is ignored on purpose: an installer that cannot write
; its diagnostics must still install.
!macro ionLog Text
  Push $9
  ClearErrors
  FileOpen $9 "$TEMP\Ion-Setup.log" a
  ${IfNot} ${Errors}
    FileSeek $9 0 END
    FileWrite $9 "${Text}$\r$\n"
    FileClose $9
  ${EndIf}
  Pop $9
!macroend

; Name the phase the installer is currently in, on screen and in the log.
;
; Getting text onto this installer took three failed attempts, so the
; measurements are recorded here rather than rediscovered.
;
; What does NOT work, and why:
;
;   - A bare DetailPrint. electron-builder's installSection issues
;     `SetDetailsPrint none` before any custom macro runs, so the call is
;     discarded.
;   - Restoring the mode and printing. The text reaches control 1006, but
;     common.nsh sets `ShowInstDetails nevershow`, and the phases all fire
;     either side of one opaque `installApplicationFiles` block -- so the
;     writes flash past in milliseconds at each end while the 130MB
;     decompression, which is the entire visible duration, shows nothing.
;   - WM_SETTEXT to control 1000. That is the one-click banner; an assisted
;     installer does not use it. Measured: read back empty.
;   - A timer driving live progress. nsDialogs::CreateTimer runs its callback
;     on the message loop, and extraction blocks that thread. Measured: zero
;     ticks during a 3s blocking call.
;
; What works: the MUI page header on the OUTER dialog -- control 1037 (title)
; and 1038 (subtitle). Measured mid-section: both carry WS_VISIBLE and hold
; the text written to them. Crucially the header is NOT redrawn during a
; section, so text set before extraction stays on screen for its whole
; duration, which is exactly the window that was blank.
;
; The status line (1006) is deliberately NOT written. Under
; `ShowInstDetails nevershow` it is normally invisible, but electron-builder's
; assisted installer shows it above the progress bar -- so writing the same
; string to both surfaces rendered every caption twice, once in the header and
; once over the bar. The header is the one that persists for a whole step, so
; it is the one kept.
!macro ionPhase Text Detail
  ${IfNot} ${Silent}
    Push $0
    Push $1
    GetDlgItem $0 $hwndparent 1037
    SendMessage $0 ${WM_SETTEXT} 0 "STR:${Text}"
    GetDlgItem $1 $hwndparent 1038
    SendMessage $1 ${WM_SETTEXT} 0 "STR:${Detail}"
    Pop $1
    Pop $0
  ${EndIf}
  !insertmacro ionLog "phase: ${Text} -- ${Detail}"
!macroend

; Both sides of every branch that decides the outcome are recorded, because the
; question after a failed deployment is always which way it went, not whether
; the happy path happened.
!macro customInit
  !insertmacro ionLog "--- Ion ${VERSION} setup ---"
  ${If} ${Silent}
    !insertmacro ionLog "init: mode=silent"
  ${Else}
    !insertmacro ionLog "init: mode=interactive"
  ${EndIf}
  ${If} ${UAC_IsAdmin}
    !insertmacro ionLog "init: privileges=admin"
  ${Else}
    !insertmacro ionLog "init: privileges=standard"
  ${EndIf}
  ${If} ${UAC_IsInnerInstance}
    !insertmacro ionLog "init: instance=inner (already elevated)"
  ${Else}
    !insertmacro ionLog "init: instance=outer"
  ${EndIf}
  !insertmacro ionLog "init: installMode=$installMode instdir=$INSTDIR"
!macroend

; Per-step status on the install page.
;
; The progress bar fills and restarts once per NSIS step -- the old version is
; removed, the payload is decompressed, the app is registered -- and with one
; static caption that reads as a single phase failing and retrying. Each step
; sets its own caption, so the bar restarting always has a reason next to it.
;
; The caption is the MUI page header (controls 1037/1038 on the OUTER dialog).
; It persists inside a step because nothing redraws it there, which is what
; makes it usable at all: extraction is one call that never yields, so a timer
; cannot repaint during it -- measured, zero callbacks across a 3s blocking
; call. Text set BEFORE a step therefore has to describe that step, and the
; caption for the slow one is set before decompression begins.
;
; ionPhase (below, used inside the install section) writes the same controls
; and is the runtime form; MUI_INSTFILESPAGE_HEADER_* in customHeader sets the
; opening caption, because customHeader is the only hook that runs before the
; page list is built.
!macro customHeader
  ; The caption the page OPENS with, and the only one covering the first
  ; progress cycle.
  ;
  ; That first bar is electron-builder's `uninstallOldVersion`, which runs
  ; before any hook this script can reach: customUnInstallCheck fires AFTER it
  ; completes, so the earliest a macro can speak is already too late. Every
  ; other bar had a caption while this one had none, which read as the
  ; installer starting up broken.
  ;
  ; So this names that step rather than the wizard in general. On a clean
  ; install the uninstall pass finds nothing and completes instantly, and the
  ; caption is replaced by the unpack text a moment later -- honest in both
  ; cases, because "checking for a previous installation" is exactly what runs
  ; either way.
  !define MUI_INSTFILESPAGE_HEADER_TEXT "Installing Ion ${VERSION}"
  !define MUI_INSTFILESPAGE_HEADER_SUBTEXT "Checking for a previous installation..."
!macroend

; Step: the previous version has just been removed.
;
; This hook fires after `uninstallOldVersion`, which on an upgrade is its own
; progress cycle. Setting the caption here labels the NEXT cycle -- the
; payload unpack -- which is the long one and the reason the window looks
; idle.
;
; electron-builder `Return`s immediately after inserting this macro, skipping
; the default failure handling below it. That handling is replicated here so
; a failed uninstall still reports and aborts instead of installing over a
; broken previous version.
!macro customUnInstallCheck
  !insertmacro ionPhase "Installing Ion ${VERSION}" "Unpacking the application (about 130 MB). This takes a minute, and the window may look idle."
  IfErrors ionUninstallCheck_failed
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    !insertmacro ionLog "uninstall: previous version failed, code $R0"
    SetErrorLevel 2
    Quit
  ${EndIf}
  Goto ionUninstallCheck_done
ionUninstallCheck_failed:
  !insertmacro ionLog "uninstall: could not launch the previous uninstaller"
ionUninstallCheck_done:
!macroend

; The same, for a per-user install being replaced by this one.
!macro customUnInstallCheckCurrentUser
  !insertmacro ionPhase "Installing Ion ${VERSION}" "Unpacking the application (about 130 MB). This takes a minute, and the window may look idle."
  IfErrors ionUnCheckCU_failed
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    !insertmacro ionLog "uninstall: previous per-user version failed, code $R0"
    SetErrorLevel 2
    Quit
  ${EndIf}
  Goto ionUnCheckCU_done
ionUnCheckCU_failed:
  !insertmacro ionLog "uninstall: could not launch the previous per-user uninstaller"
ionUnCheckCU_done:
!macroend

; Payload verification.
;
; electron-builder unpacks the app with the bundled nsis7z plugin and never
; inspects the result -- its extract macro pops the $OUTDIR it pushed itself,
; not a status code. An entry the plugin cannot decode is therefore dropped in
; silence, and the install continues on to write its registry keys, create the
; Start Menu shortcut and exit 0, leaving a shortcut aimed at an executable
; that was never written. That is what a "Missing Shortcut" dialog after a
; clean install actually is.
;
; customFiles_<arch> is the one seam that runs after decompression and before
; any of those writes, so a failure caught here costs the user nothing but the
; time already spent. Both architectures are checked: the defect that motivated
; this only affected ARM64, but a check that only guards the arch we know about
; would not have caught it in the first place.
!macro verifyAppPayload
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    !insertmacro ionLog "extract: FAILED -- no $INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Ion: extraction produced no $INSTDIR\${APP_EXECUTABLE_FILENAME}"
    SetErrorLevel 3
    MessageBox MB_OK|MB_ICONSTOP "Ion could not be installed.$\r$\n$\r$\nThe application files did not unpack, so nothing was installed. This installer is not usable on this machine -- please report the build it came from." /SD IDOK
    Quit
  ${EndIf}
  !insertmacro ionLog "extract: ok -- $INSTDIR\${APP_EXECUTABLE_FILENAME} present"
  !insertmacro ionPhase "Installing Ion ${VERSION}" "Verifying the application files..."
!macroend

!macro customFiles_arm64
  !insertmacro verifyAppPayload
!macroend

!macro customFiles_x64
  !insertmacro verifyAppPayload
!macroend

; Runs only for a per-machine install ($installMode == "all", set by the
; electron-builder assisted installer when launched with /allusers or when
; the user chooses "for all users" in the UI). A per-user install never
; touches %ProgramData% at all.
;
; ProgramData ACL: Administrators + SYSTEM full control, Users read and
; execute, inheritance removed -- a standard user must not be able to author
; enterprise policy files under %ProgramData%\Ion (manifest contract C6).
; The well-known SIDs are used instead of names so this works on any
; locale's Windows install:
;   S-1-5-32-544  BUILTIN\Administrators
;   S-1-5-18      NT AUTHORITY\SYSTEM
;   S-1-5-32-545  BUILTIN\Users
;
; A failure here is FATAL, and that is a deliberate change from logging and
; continuing. %ProgramData%\Ion is where enterprise policy lives -- the
; allowed model and provider lists, the permission mode, the operator-identity
; requirement. A directory a standard user can write is a directory on which
; that user can author their own policy and hand it to their own engine, which
; is the whole control the pilot rests on. On a single-user workstation an
; unsecured directory was a warning worth living with. On a multi-session host
; it is the difference between an enforced policy and a suggestion, and an
; install that reports success while leaving it open is worse than one that
; fails: the fleet looks compliant and is not.
;
; Every branch is logged either way, so a deployment that fails here says
; exactly which command failed and with what code.
!macro customInstall
  !insertmacro ionLog "install: files placed in $INSTDIR (installMode=$installMode)"
  !insertmacro ionPhase "Installing Ion ${VERSION}" "Registering Ion for all users..."
  ${if} $installMode == "all"
    ; $PROGRAMDATA is not an NSIS constant. Referencing it emits "unknown
    ; variable/constant ... ignoring", which electron-builder promotes to a
    ; build failure -- and had it not, the path would have expanded to "\Ion"
    ; and the ACL would have been applied to the wrong directory. Read the
    ; environment variable instead, which is defined on every Windows install
    ; and independent of NSIS version.
    ExpandEnvStrings $1 "%ProgramData%"
    CreateDirectory "$1\Ion"
    IfErrors 0 ionAclDirOk
      !insertmacro ionLog "install: FAILED -- could not create $1\Ion"
      SetErrorLevel 4
      MessageBox MB_OK|MB_ICONSTOP "Ion could not be installed.$\r$\n$\r$\nThe enterprise policy directory $1\Ion could not be created, so machine policy cannot be protected from standard users. Nothing was configured." /SD IDOK
      Quit
ionAclDirOk:
    nsExec::ExecToLog 'icacls "$1\Ion" /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" /grant:r "*S-1-5-18:(OI)(CI)F" /grant:r "*S-1-5-32-545:(OI)(CI)RX"'
    Pop $0
    !insertmacro ionLog "install: ProgramData ACL for $1\Ion exit code $0"
    ${If} $0 == 0
      !insertmacro ionPhase "Installing Ion ${VERSION}" "Enterprise policy directory secured."
    ${Else}
      ; Fatal. See the block comment above: an unsecured policy directory on a
      ; shared host means any standard user can author the policy their own
      ; engine reads.
      !insertmacro ionLog "install: FAILED -- could not secure $1\Ion (icacls exit $0)"
      SetErrorLevel 4
      MessageBox MB_OK|MB_ICONSTOP "Ion could not be installed.$\r$\n$\r$\nThe enterprise policy directory $1\Ion could not be secured (icacls exit code $0), so machine policy would be writable by standard users. Nothing was configured.$\r$\n$\r$\nThe install log is at $TEMP\Ion-Setup.log." /SD IDOK
      Quit
    ${EndIf}

    ; The administrator cleanup tool, placed where uninstall can still reach it
    ; after $INSTDIR has been removed and where an administrator can find it
    ; later. It inherits the ACL just applied: readable and runnable by any
    ; user, writable only by administrators and SYSTEM.
    SetOutPath "$1\Ion"
    File "${BUILD_RESOURCES_DIR}\..\..\packaging\windows\Remove-IonEngineTasks.ps1"
    SetOutPath "$INSTDIR"
    !insertmacro ionLog "install: placed Remove-IonEngineTasks.ps1 in $1\Ion"
  ${endif}
  !insertmacro ionPhase "Installing Ion ${VERSION}" "Finishing installation..."
!macroend

; Uninstall: remove every Ion Engine scheduled task on this machine.
;
; Ion registers one scheduled task per interactive account, named
; "Ion Engine (<SID>)" (earlier releases registered a single shared "Ion
; Engine"). Every one of them runs an executable inside $INSTDIR, so an
; uninstall that leaves them behind leaves a task firing at every sign-in
; against a binary that is gone.
;
; The tasks live in C:\Windows\System32\Tasks, not in any user profile, so a
; per-machine uninstall running as SYSTEM or an administrator can enumerate and
; remove all of them -- including tasks belonging to accounts that are signed
; out and to accounts whose FSLogix profile container is not mounted. That is
; what makes this complete on a multi-session host rather than complete only
; for whoever happened to run it.
;
; Nothing inside a user profile is touched. %USERPROFILE%\.ion holds
; conversations, credentials and settings; it is user data and survives
; uninstall. The rendered task XML in there is inert once the task is gone.
;
; The removal itself lives in Remove-IonEngineTasks.ps1 so that the same code
; an uninstall runs is the code an administrator runs to finish the job when an
; uninstall lacked the rights. It is invoked from %ProgramData%\Ion because
; $INSTDIR has already been deleted by the time this macro runs.
;
; A task is removed only when its NAME is one Ion registers AND its registered
; action proves it launches Ion from an installed Ion directory. $INSTDIR is
; passed as -InstallRoot because it is the one thing this uninstaller knows and
; the script cannot rediscover: the directory is already deleted and its
; uninstall registration goes with it, so on a device installed somewhere other
; than %ProgramFiles%\Ion the caller is the only remaining source of the truth.
; Without it such a device's task would fail verification and be skipped --
; which is safe, and is not the same as removed.
;
; A failure never blocks the uninstall: the application still has to come off
; the machine. It is logged with the remediation command, and the standalone
; script remains in place to run it.
!macro customUnInstall
  ; Policy files under %ProgramData%\Ion are administrator-owned
  ; configuration, not application state -- never removed by uninstall.
  ExpandEnvStrings $1 "%ProgramData%"
  ${IfNot} ${FileExists} "$1\Ion\Remove-IonEngineTasks.ps1"
    !insertmacro ionLog "uninstall: WARNING -- $1\Ion\Remove-IonEngineTasks.ps1 is missing; scheduled tasks were NOT removed"
  ${Else}
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$1\Ion\Remove-IonEngineTasks.ps1" -InstallRoot "$INSTDIR"'
    Pop $0
    !insertmacro ionLog "uninstall: Remove-IonEngineTasks.ps1 exit code $0"
    ${If} $0 != 0
      ; $\" is how NSIS escapes a quote. A backslash is not an escape character
      ; to its parser, so the \" this line used to carry ended the macro's only
      ; argument early and !insertmacro saw two arguments where ionLog takes
      ; one -- a compile error that failed the whole installer build.
      !insertmacro ionLog "uninstall: WARNING -- at least one Ion Engine task remains. Run as an administrator: powershell -ExecutionPolicy Bypass -File $\"$1\Ion\Remove-IonEngineTasks.ps1$\""
    ${EndIf}
  ${EndIf}
!macroend
