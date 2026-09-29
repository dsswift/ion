package fleet

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// macApp and the paths inside it.
const (
	macAppExe    = desktopApp + "/Contents/MacOS/Ion"
	macAppIon    = desktopApp + "/Contents/Resources/engine/ion"
	macAppPairJS = desktopApp + "/Contents/Resources/app.asar.unpacked/dist/server/pair.js"
)

// macIonRunning prints yes or no. Only the app's own process counts: the
// Studio server child runs the same executable with a script argument, so
// the pattern is anchored at the end of the command line.
const macIonRunning = `pgrep -f '` + macAppExe + `$' >/dev/null 2>&1 && echo yes || echo no`

// macQuitIon quits Ion without its quit dialog (SIGUSR2: nobody is there to
// answer one; its sessions and engine stop), kills one still running after
// 30 seconds, and exits 7 when even that did not end it.
const macQuitIon = `PAT='` + macAppExe + `$'
pkill -USR2 -f "$PAT" 2>/dev/null
i=0; while pgrep -f "$PAT" >/dev/null 2>&1 && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
if pgrep -f "$PAT" >/dev/null 2>&1; then
  echo "Ion did not exit after SIGUSR2; killing it" >&2
  pkill -KILL -f "$PAT"
  i=0; while pgrep -f "$PAT" >/dev/null 2>&1 && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
fi
if pgrep -f "$PAT" >/dev/null 2>&1; then echo "Ion is still running after SIGKILL" >&2; exit 7; fi
`

// macBackup copies ~/.ion aside (`cp -c` clones on APFS) and prints
// "dest|conversations in the source|conversations in the copy", or "none".
// cp exits non-zero for a socket it rightly skips, so the copy is judged by
// what it holds.
const macBackup = `set -u; src="$HOME/.ion"; [ -d "$src" ] || { echo "none"; exit 0; }
dst="$HOME/.ion-backup-$(date +%Y%m%d-%H%M%S)"
cp -Rc "$src" "$dst" 2>/dev/null || cp -R "$src" "$dst" 2>/dev/null || true
count() { [ -d "$1/conversations" ] && ls "$1/conversations" | wc -l | tr -d " " || echo 0; }
echo "$dst|$(count "$src")|$(count "$dst")"`

// pairWait is how long an install waits for a desktop's server to mint a
// pairing link.
var pairWait = 30 * (2 * time.Second)

// InstallMacDesktop installs a desktop installer package on a Mac and checks
// what landed. pkgArchs are the package's CPUs when known; a package that
// would not run on the host is refused before anything is copied.
func InstallMacDesktop(ctx context.Context, r Runner, h Host, pkg, pkgArchs string, o InstallOptions, w io.Writer) (Receipt, error) {
	log := installLog{w: w, host: h.Name}
	rec := Receipt{Host: h.Name, RelayApplied: true}
	if err := o.checkRelay(); err != nil {
		return rec, err
	}
	log.step("preflight: %s", h.Name)
	plat, err := r.Platform(ctx, h)
	if err != nil {
		return rec, fmt.Errorf("cannot reach %s over ssh (key authentication is required): %w", h.Name, err)
	}
	if plat.GOOS != "darwin" {
		return rec, fmt.Errorf("%s runs %s; the Ion desktop package is for macOS", h.Name, plat.GOOS)
	}
	if o.AskSudo {
		if !o.Interactive {
			return rec, fmt.Errorf("%s asks for its sudo password, and there is no terminal here to type it into", h.Name)
		}
	} else if _, err := hostCmd(ctx, r, h, false, "sudo -n true", nil, log); err != nil {
		hint := o.SudoHint
		if hint == "" {
			hint = "pass --ask-sudo from a terminal to be asked for the password instead"
		}
		return rec, fmt.Errorf("%s needs passwordless sudo for the installer (it writes /Applications); %s", h.Name, hint)
	}
	if pkgArchs != "" && !archRunsOn(pkgArchs, plat.GOARCH) {
		return rec, fmt.Errorf("this package is built for [%s] and %s is %s; build it on a Mac with that CPU", pkgArchs, h.Name, plat.GOARCH)
	}
	log.note("host: %s, package: %s", plat, pkg)

	running, err := hostCmd(ctx, r, h, false, macIonRunning, nil, log)
	if err != nil {
		return rec, err
	}
	rec.WasRunning = strings.TrimSpace(string(running)) == "yes"
	if rec.WasRunning {
		if !o.QuitIon {
			return rec, fmt.Errorf("the desktop is running on %s and the package will not replace a live app; quit it there, or pass --quit-ion", h.Name)
		}
		log.step("quit Ion on %s", h.Name)
		if _, err := hostCmd(ctx, r, h, false, macQuitIon, nil, log); err != nil {
			return rec, fmt.Errorf("the desktop on %s would not quit; quit it there by hand and deploy again: %w", h.Name, err)
		}
	}
	if o.Backup {
		if rec.Backup, err = macBackupIon(ctx, r, h, log); err != nil {
			return rec, err
		}
	}

	log.step("copy to %s", h.Name)
	remote := "/tmp/" + incomingName("ion-desktop", ".pkg")
	if err := r.CopyTo(ctx, h, pkg, remote); err != nil {
		return rec, fmt.Errorf("copy to %s failed: %w", h.Name, err)
	}
	log.step("install on %s", h.Name)
	if o.AskSudo {
		banner := macSudoBanner(h)
		log.note("%s", banner)
		err = r.RunTerminal(ctx, h, "sudo -p "+shellQuote(macSudoPrompt(h))+" installer -pkg '"+remote+"' -target /; rc=$?; rm -f '"+remote+"'; exit $rc", banner, w)
	} else {
		_, err = hostCmd(ctx, r, h, false, "sudo -n installer -pkg '"+remote+"' -target / >&2; rc=$?; rm -f '"+remote+"'; exit $rc", nil, log)
	}
	if err != nil {
		return rec, fmt.Errorf("the installer failed on %s: %w", h.Name, err)
	}

	log.step("verify")
	version, _ := hostCmd(ctx, r, h, false, "defaults read '"+desktopApp+"/Contents/Info' CFBundleShortVersionString 2>/dev/null", nil, log) //nolint:errcheck // an unreadable version is checked below
	rec.Version = strings.TrimSpace(string(version))
	if rec.Version == "" {
		return rec, fmt.Errorf("%s is missing on %s after the install", desktopApp, h.Name)
	}
	archs, _ := hostCmd(ctx, r, h, false, "lipo -archs '"+macAppExe+"' 2>/dev/null", nil, log) //nolint:errcheck // lipo is optional; an empty answer skips the check
	rec.Archs = strings.TrimSpace(string(archs))
	if rec.Archs != "" && !archRunsOn(rec.Archs, plat.GOARCH) {
		return rec, fmt.Errorf("installed Ion %s is built for [%s] and will not run on %s (%s)", rec.Version, rec.Archs, h.Name, plat.GOARCH)
	}
	log.note("installed: Ion %s [%s]", rec.Version, rec.Archs)

	if o.Relay != "" {
		if err := macDesktopRelay(ctx, r, h, o, &rec, log); err != nil {
			return rec, err
		}
	}
	if o.Open || o.Pair != "" {
		log.step("launch Ion on %s", h.Name)
		if _, err := hostCmd(ctx, r, h, false, "open -a '"+desktopApp+"'", nil, log); err == nil {
			rec.Opened = true
		} else {
			log.note("could not launch Ion (no logged-in GUI session on %s?)", h.Name)
		}
	}
	if o.Pair != "" {
		if !rec.Opened {
			return rec, fmt.Errorf("a pairing link needs Ion running on %s, and it could not be launched", h.Name)
		}
		script := `[ -S "$HOME/.ion/studio.sock" ] && ELECTRON_RUN_AS_NODE=1 '` + macAppExe + `' '` + macAppPairJS + `' --label ` + shellQuote(o.Pair) + ` 2>/dev/null`
		if rec.PairingLink, err = waitForPairingLink(ctx, func() ([]byte, error) { return hostCmd(ctx, r, h, false, script, nil, log) }); err != nil {
			return rec, fmt.Errorf("the desktop's server did not come up on %s within a minute; open Ion there and mint a link from Settings", h.Name)
		}
		log.note("pairing link (treat it as a password): %s", rec.PairingLink)
	}
	rec.OK = true
	return rec, nil
}

func macBackupIon(ctx context.Context, r Runner, h Host, log installLog) (string, error) {
	log.step("back up ~/.ion on %s", h.Name)
	out, err := hostCmd(ctx, r, h, false, macBackup, nil, log)
	if err != nil {
		return "", fmt.Errorf("the backup command failed on %s: %w", h.Name, err)
	}
	return checkBackup(h, strings.TrimSpace(string(out)), log)
}

// checkBackup reads a backup step's "dest|source count|copy count" answer.
func checkBackup(h Host, answer string, log installLog) (string, error) {
	if answer == "none" {
		log.note("nothing to back up: %s has no ~/.ion", h.Name)
		return "", nil
	}
	parts := strings.Split(answer, "|")
	if len(parts) != 3 {
		return "", fmt.Errorf("the backup on %s answered %q", h.Name, answer)
	}
	src, errSrc := strconv.Atoi(parts[1])
	dst, errDst := strconv.Atoi(parts[2])
	if errSrc != nil || errDst != nil || parts[0] == "" || dst < src {
		return "", fmt.Errorf("the backup at %s holds %s of %s conversation files; nothing was installed", parts[0], parts[2], parts[1])
	}
	log.note("backup: %s (%d conversation files)", parts[0], dst)
	return parts[0], nil
}

// macDesktopRelay writes the relay with the app's own engine and restarts a
// running Ion when the relay changed: Ion reads server.json only when it
// starts, and the installer has already relaunched it.
func macDesktopRelay(ctx context.Context, r Runner, h Host, o InstallOptions, rec *Receipt, log installLog) error {
	log.step("relay: %s", o.Relay)
	// An engine older than `ion studio relay` prints its general help, which
	// reads like a failure of the relay itself; probe first.
	if _, err := hostCmd(ctx, r, h, false, "'"+macAppIon+"' studio relay list >/dev/null 2>&1", nil, log); err != nil {
		return fmt.Errorf("the Ion installed on %s has no 'ion studio relay' command: its engine predates it; deploy a newer build", h.Name)
	}
	args, stdin := o.relayArgs(true)
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = shellQuote(a)
	}
	out, err := hostCmd(ctx, r, h, false, "'"+macAppIon+"' "+strings.Join(quoted, " "), stdin, log)
	log.output(out)
	if err != nil {
		return fmt.Errorf("could not set the relay on %s: %w", h.Name, err)
	}
	rec.Relay = o.Relay
	if !relaySaved(out) {
		return nil
	}
	running, err := hostCmd(ctx, r, h, false, macIonRunning, nil, log)
	if err != nil || strings.TrimSpace(string(running)) != "yes" {
		log.note("Ion is not running on %s; it reads the relay when it starts", h.Name)
		return nil
	}
	log.step("restart Ion on %s so the relay takes effect", h.Name)
	if _, err := hostCmd(ctx, r, h, false, macQuitIon+"open -a '"+desktopApp+"'\n", nil, log); err != nil {
		rec.RelayApplied = false
		log.note("could not restart Ion on %s; the relay takes effect when Ion next starts", h.Name)
	}
	return nil
}

// waitForPairingLink retries mint until it prints a link, for a minute.
func waitForPairingLink(ctx context.Context, mint func() ([]byte, error)) (string, error) {
	deadline := time.Now().Add(pairWait)
	for {
		if out, err := mint(); err == nil {
			if link := strings.TrimSpace(string(out)); link != "" {
				return link, nil
			}
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("no pairing link")
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// macSudoBanner tells the person at the terminal whose password the Mac
// installer's sudo is about to ask for, and why.
func macSudoBanner(h Host) string {
	return fmt.Sprintf("ion fleet is installing the Ion desktop on %s. Its installer needs sudo.\nType your password on %s at the prompt below. The deploy goes on once the install finishes.", h.Name, h.Name)
}

// macSudoPrompt is sudo's own prompt, naming the host so it cannot be
// mistaken for this machine's. %u is sudo's escape for the remote user; a
// literal % in the host name is doubled.
func macSudoPrompt(h Host) string {
	return "Password for %u on " + strings.ReplaceAll(h.Name, "%", "%%") + " (ion fleet install): "
}
