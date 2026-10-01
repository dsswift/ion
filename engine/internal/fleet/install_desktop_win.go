package fleet

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strings"
)

// windowsIncoming is where an installer lands on a Windows host, under the
// user's home.
const windowsIncoming = `.ion\fleet-incoming`

// windowsSetupName reads a Windows installer's version and CPU from its
// name, Ion-Setup-<version>-<arch>.exe.
var windowsSetupName = regexp.MustCompile(`^Ion-Setup-(.+)-(arm64|x64)\.exe$`)

// psIsAdmin prints yes when the ssh session may install for every user.
const psIsAdmin = `$p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'yes' } else { 'no' }
`

// psDesktopState prints absent, yes, or no: whether the desktop is installed
// and running.
const psDesktopState = psFindDesktop + `$desktop = Find-IonDesktop
if (-not $desktop) { 'absent'; exit 0 }
$exe = Join-Path $desktop 'Ion.exe'
if (Get-Process -Name Ion -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) { 'yes' } else { 'no' }
`

// psQuitDesktopOrFail quits a running Ion and exits 7 when it is still up.
const psQuitDesktopOrFail = psDesktopExe + psStartInUserSession + psQuitDesktop + `if (Get-Ion) { [Console]::Error.WriteLine('Ion is still running after a forced stop'); exit 7 }
`

// psBackup copies ~\.ion aside and prints "dest|source count|copy count", or
// none.
const psBackup = `$src = Join-Path $env:USERPROFILE '.ion'
if (-not (Test-Path -LiteralPath $src)) { 'none'; exit 0 }
$dst = Join-Path $env:USERPROFILE ('.ion-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue
function Count-Conversations($dir) {
  $c = Join-Path $dir 'conversations'
  if (Test-Path -LiteralPath $c) { @(Get-ChildItem -LiteralPath $c -Force).Count } else { 0 }
}
"$dst|$(Count-Conversations $src)|$(Count-Conversations $dst)"
`

// windowsInstallMinutes bounds a silent desktop install. A normal one takes a
// minute or two, even under x86 emulation on ARM64.
const windowsInstallMinutes = "10"

// psInstallDesktop runs a copied installer silently for every user and
// removes it. Set $name first. An installer still running at the bound exits
// 6 and names every process under it, so a hung child (an uninstaller step, a
// cleanup script) is reported instead of waited on forever. It is left
// running: killing an installer mid-write can leave a half-installed app.
//
// Windows holds the installer's file for a moment after it exits, so the
// removal retries, and a file that stays locked is a note, not a failure.
// The script ends in an explicit exit 0: PowerShell run with a command exits
// 1 when its last statement failed, even one that failed silently.
const psInstallDesktop = `$setup = Join-Path (Join-Path $env:USERPROFILE '` + windowsIncoming + `') $name
$minutes = ` + windowsInstallMinutes + `
function Get-Descendant([int] $id) {
  foreach ($c in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction SilentlyContinue)) {
    $c
    Get-Descendant $c.ProcessId
  }
}
$p = Start-Process -FilePath $setup -ArgumentList '/S', '/allusers' -PassThru
$null = $p.Handle
if (-not $p.WaitForExit($minutes * 60 * 1000)) {
  $stuck = @(Get-Descendant $p.Id | ForEach-Object { "$($_.Name) (pid $($_.ProcessId)): $($_.CommandLine)" })
  [Console]::Error.WriteLine("the installer (pid $($p.Id)) is still running after $minutes minutes; under it: $(if ($stuck) { $stuck -join ' | ' } else { 'nothing' })")
  exit 6
}
$code = $p.ExitCode
$removed = $false
for ($i = 0; $i -lt 20 -and -not $removed; $i++) {
  try { Remove-Item -LiteralPath $setup -Force -ErrorAction Stop; $removed = $true } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $removed) { [Console]::Error.WriteLine("note: could not remove $setup; it is safe to delete") }
if ($code -ne 0) { [Console]::Error.WriteLine("the installer exited $code"); exit 5 }
exit 0
`

// psInstalledDesktop prints "version|folder" for the installed desktop.
const psInstalledDesktop = psFindDesktop + `$desktop = Find-IonDesktop
if (-not $desktop) { [Console]::Error.WriteLine('Ion.exe is missing after the install'); exit 5 }
$version = ''
foreach ($hive in 'HKLM:', 'HKCU:') {
  $e = Get-ItemProperty -LiteralPath (Join-Path $hive '` + windowsUninstallKey + `') -ErrorAction SilentlyContinue
  if ($e -and $e.DisplayVersion) { $version = $e.DisplayVersion; break }
}
"$version|$desktop"
`

// InstallWindowsDesktop installs a desktop installer (Ion-Setup-<v>-<arch>.exe)
// on a Windows host for every user, and checks what landed.
func InstallWindowsDesktop(ctx context.Context, r Runner, h Host, setup string, o InstallOptions, w io.Writer) (Receipt, error) {
	log := newInstallLog(w, h.Name, o)
	rec := Receipt{Host: h.Name, RelayApplied: true}
	if err := o.checkRelay(); err != nil {
		return rec, err
	}
	name := filepath.Base(setup)
	m := windowsSetupName.FindStringSubmatch(name)
	if m == nil {
		return rec, fmt.Errorf("%s is not a Windows desktop installer (Ion-Setup-<version>-<arch>.exe)", name)
	}
	wantVersion, setupArch := m[1], m[2]
	log.step("preflight: %s", h.Name)
	plat, err := r.Platform(ctx, h)
	if err != nil {
		return rec, fmt.Errorf("cannot reach %s over ssh (key authentication is required): %w", h.Name, err)
	}
	if !plat.Windows() {
		return rec, fmt.Errorf("%s runs %s; %s is for Windows", h.Name, plat.GOOS, name)
	}
	if !archRunsOn(setupArch, plat.GOARCH) {
		return rec, fmt.Errorf("%s is built for %s and %s is %s", name, setupArch, h.Name, plat.GOARCH)
	}
	if admin, err := hostCmd(ctx, r, h, true, psIsAdmin, nil, log); err != nil || strings.TrimSpace(string(admin)) != "yes" {
		return rec, fmt.Errorf("the ssh session on %s is not an administrator's; the desktop installs for every user and needs one", h.Name)
	}
	log.note("host: %s, installer: %s", plat, setup)

	state, err := hostCmd(ctx, r, h, true, psDesktopState, nil, log)
	if err != nil {
		return rec, err
	}
	rec.WasRunning = strings.TrimSpace(string(state)) == "yes"
	if rec.WasRunning {
		if !o.QuitIon {
			return rec, fmt.Errorf("the desktop is running on %s and the installer will not replace a live app; quit it there, or pass --quit-ion", h.Name)
		}
		log.step("quit Ion on %s", h.Name)
		if _, err := hostCmd(ctx, r, h, true, psQuitDesktopOrFail, nil, log); err != nil {
			return rec, fmt.Errorf("the desktop on %s would not quit; quit it there by hand and deploy again: %w", h.Name, err)
		}
	}
	if o.Backup {
		log.step("back up ~\\.ion on %s", h.Name)
		out, err := hostCmd(ctx, r, h, true, psBackup, nil, log)
		if err != nil {
			return rec, fmt.Errorf("the backup command failed on %s: %w", h.Name, err)
		}
		if rec.Backup, err = checkBackup(h, strings.TrimSpace(string(out)), log); err != nil {
			return rec, err
		}
	}

	log.step("copy to %s", h.Name)
	if _, err := hostCmd(ctx, r, h, true, "New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE '"+windowsIncoming+"') | Out-Null\n", nil, log); err != nil {
		return rec, fmt.Errorf("could not make the incoming folder on %s: %w", h.Name, err)
	}
	if err := r.CopyTo(ctx, h, setup, strings.ReplaceAll(windowsIncoming, `\`, "/")+"/"+name); err != nil {
		return rec, fmt.Errorf("copy to %s failed: %w", h.Name, err)
	}
	log.step("install on %s", h.Name)
	if _, err := hostCmd(ctx, r, h, true, "$name = "+psQuote(name)+"\n"+psInstallDesktop, nil, log); err != nil {
		return rec, fmt.Errorf("the installer failed on %s: %w", h.Name, err)
	}

	log.step("verify")
	out, err := hostCmd(ctx, r, h, true, psInstalledDesktop, nil, log)
	if err != nil {
		return rec, fmt.Errorf("verify on %s: %w", h.Name, err)
	}
	version, dir, _ := strings.Cut(strings.TrimSpace(string(out)), "|")
	rec.Version, rec.Archs = version, setupArch
	if version != wantVersion {
		return rec, fmt.Errorf("%s reports desktop %q after installing %s", h.Name, version, wantVersion)
	}
	log.note("installed: Ion %s [%s] in %s", version, setupArch, dir)

	if o.Relay != "" {
		if err := windowsDesktopRelay(ctx, r, h, dir, o, &rec, log); err != nil {
			return rec, err
		}
	}
	// A silent install does not start Ion, where the Mac package relaunches
	// it; start it again when it was running, or when asked to.
	if rec.WasRunning || o.Open || o.Pair != "" {
		log.step("launch Ion on %s", h.Name)
		if _, err := hostCmd(ctx, r, h, true, psDesktopExe+psStartInUserSession+"Start-InUserSession $exe ''\n", nil, log); err == nil {
			rec.Opened = true
		} else {
			log.note("could not launch Ion (is someone signed in on %s?): %v", h.Name, err)
		}
	}
	if o.Pair != "" {
		if !rec.Opened {
			return rec, fmt.Errorf("a pairing link needs Ion running on %s, and it could not be launched", h.Name)
		}
		script := psDesktopExe + "$env:ELECTRON_RUN_AS_NODE = '1'\n& $exe (Join-Path $desktop 'resources\\app.asar.unpacked\\dist\\server\\pair.js') '--label' " + psQuote(o.Pair) + " 2>$null\nexit $LASTEXITCODE\n"
		if rec.PairingLink, err = waitForPairingLink(ctx, func() ([]byte, error) { return hostCmd(ctx, r, h, true, script, nil, log) }); err != nil {
			return rec, fmt.Errorf("the desktop's server did not come up on %s within a minute; open Ion there and mint a link from Settings", h.Name)
		}
		log.note("pairing link (treat it as a password): %s", rec.PairingLink)
	}
	rec.OK = true
	return rec, nil
}

// windowsDesktopRelay writes the relay with the installed desktop's engine.
// The desktop is not running yet unless it was already: it starts after this
// step and reads the relay then.
func windowsDesktopRelay(ctx context.Context, r Runner, h Host, dir string, o InstallOptions, rec *Receipt, log installLog) error {
	log.step("relay: %s", o.Relay)
	ion := psQuote(dir + `\resources\engine\ion.exe`)
	if _, err := hostCmd(ctx, r, h, true, "& "+ion+" studio relay list | Out-Null\nexit $LASTEXITCODE\n", nil, log); err != nil {
		return fmt.Errorf("the Ion installed on %s has no 'ion studio relay' command: its engine predates it; deploy a newer build", h.Name)
	}
	args, stdin := o.relayArgs(true)
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = psQuote(a)
	}
	out, err := hostCmd(ctx, r, h, true, "& "+ion+" "+strings.Join(quoted, " ")+"\nexit $LASTEXITCODE\n", stdin, log)
	log.output(out)
	if err != nil {
		return fmt.Errorf("could not set the relay on %s: %w", h.Name, err)
	}
	rec.Relay = o.Relay
	return nil
}
