package fleet

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// macHost is a scripted Mac: whether Ion runs, how it answers a quit, what
// its sudo allows, and what the install leaves behind.
type macHost struct {
	arch           string // uname -m
	sudoOK         bool
	running        bool
	quitFails      bool
	installedArchs string
	backupAnswer   string
	relayListFails bool
	relayResult    string // "saved" or "already set"
	restartFails   bool
	postinstallRun bool // the package relaunches Ion
}

func (m *macHost) runner() *fakeRunner {
	return &fakeRunner{
		platform: func(Host) (Platform, error) {
			return Platform{GOOS: "darwin", GOARCH: m.arch, LoginShell: ShellPOSIX}, nil
		},
		answer: func(_ Host, script, _ string) ([]byte, []byte, error) {
			switch {
			case script == "sudo -n true":
				if !m.sudoOK {
					return nil, []byte("sudo: a password is required"), errors.New("exit status 1")
				}
			case script == macIonRunning:
				if m.running {
					return []byte("yes\n"), nil, nil
				}
				return []byte("no\n"), nil, nil
			case strings.HasPrefix(script, macQuitIon) && strings.Contains(script, "open -a"):
				if m.restartFails {
					return nil, []byte("Ion is still running after SIGKILL"), errors.New("exit status 7")
				}
			case script == macQuitIon:
				if m.quitFails {
					return nil, []byte("Ion is still running after SIGKILL"), errors.New("exit status 7")
				}
				m.running = false
			case script == macBackup:
				return []byte(m.backupAnswer + "\n"), nil, nil
			case strings.Contains(script, "installer -pkg"):
				m.running = m.postinstallRun
			case strings.Contains(script, "CFBundleShortVersionString"):
				return []byte("9.9.9\n"), nil, nil
			case strings.HasPrefix(script, "lipo"):
				return []byte(m.installedArchs + "\n"), nil, nil
			case strings.Contains(script, "studio relay list"):
				if m.relayListFails {
					return nil, nil, errors.New("exit status 1")
				}
			case strings.Contains(script, "'studio' 'relay' 'set'"):
				result := m.relayResult
				if result == "" {
					result = "saved"
				}
				return []byte("==> relay wss://relay.example.org " + result + " (oidc)\n"), nil, nil
			case strings.HasPrefix(script, "open -a"):
				m.running = true
			}
			return nil, nil, nil
		},
	}
}

func joined(r *fakeRunner) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.scripts, "\n")
}

func copied(r *fakeRunner) bool {
	return strings.Contains(joined(r), copyToScript)
}

var mac = Host{Name: "mac", SSH: "user@mac.example.org"}

func TestInstallMacDesktop_InstallsAndReports(t *testing.T) {
	m := &macHost{arch: "arm64", sudoOK: true, running: true, installedArchs: "arm64"}
	r := m.runner()
	rec, err := InstallMacDesktop(context.Background(), r, mac, "/tmp/Ion-9.9.9.pkg", "arm64", InstallOptions{QuitIon: true}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rec, Receipt{OK: true, Host: "mac", Version: "9.9.9", Archs: "arm64", WasRunning: true, RelayApplied: true}) {
		t.Errorf("receipt = %+v", rec)
	}
	all := joined(r)
	if !strings.Contains(all, copyToScript+"/tmp/Ion-9.9.9.pkg -> /tmp/ion-desktop-") || !strings.Contains(all, "sudo -n installer -pkg '/tmp/ion-desktop-") ||
		!strings.Contains(all, `-target / >&2 && sudo -n chown -R "$(id -un)" '/Applications/Ion.app'`) {
		t.Errorf("scripts:\n%s", all)
	}
}

// A desktop host is meant to be there after a restart: a deploy turns on
// "Open Ion at login" where nobody has chosen, unless told to leave it.
func TestInstallMacDesktop_TurnsOnOpenAtLoginUnlessToldNotTo(t *testing.T) {
	const step = "studio open-at-login on --if-unset"
	m := &macHost{arch: "arm64", sudoOK: true, installedArchs: "arm64"}
	r := m.runner()
	if _, err := InstallMacDesktop(context.Background(), r, mac, "/tmp/Ion-9.9.9.pkg", "arm64", InstallOptions{}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(joined(r), "'"+macAppIon+"' "+step) {
		t.Errorf("open at login was not set with the host's own engine:\n%s", joined(r))
	}

	m = &macHost{arch: "arm64", sudoOK: true, installedArchs: "arm64"}
	r = m.runner()
	if _, err := InstallMacDesktop(context.Background(), r, mac, "/tmp/Ion-9.9.9.pkg", "arm64", InstallOptions{NoOpenAtLogin: true}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(joined(r), step) {
		t.Errorf("--no-open-at-login must leave the setting alone:\n%s", joined(r))
	}
}

func TestParseInstallArgs_NoOpenAtLogin(t *testing.T) {
	o, rest, err := ParseInstallArgs([]string{"--no-open-at-login"}, InstallOptions{})
	if err != nil || !o.NoOpenAtLogin || len(rest) != 0 {
		t.Fatalf("o=%+v rest=%v err=%v", o, rest, err)
	}
}

// Ion's package will not replace a live app. A running Ion stops the install
// before anything is copied, unless it may be quit: by SIGUSR2 (the forced
// quit, no dialog), then SIGKILL; one that survives both is refused.
func TestInstallMacDesktop_RunningIon(t *testing.T) {
	m := &macHost{arch: "arm64", sudoOK: true, running: true, installedArchs: "arm64"}
	r := m.runner()
	if _, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "--quit-ion") {
		t.Fatalf("err = %v", err)
	}
	if copied(r) {
		t.Error("nothing may be copied while Ion runs")
	}
	if !strings.Contains(macQuitIon, `PAT='/Applications/Ion.app/Contents/MacOS/Ion$'`) || !strings.Contains(macQuitIon, `pkill -USR2 -f "$PAT"`) || !strings.Contains(macQuitIon, `pkill -KILL -f "$PAT"`) || strings.Contains(macQuitIon, "osascript") {
		t.Errorf("the quit must signal only Ion's main process, SIGUSR2 then SIGKILL, never the dialog:\n%s", macQuitIon)
	}
	m = &macHost{arch: "arm64", sudoOK: true, running: true, quitFails: true}
	r = m.runner()
	if _, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{QuitIon: true}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "still running after SIGKILL") {
		t.Fatalf("err = %v", err)
	}
	if copied(r) {
		t.Error("nothing may be copied when Ion would not quit")
	}
}

func TestInstallMacDesktop_RefusesUnsuitableHosts(t *testing.T) {
	linux := &fakeRunner{platform: func(Host) (Platform, error) { return Platform{GOOS: "linux", GOARCH: "amd64"}, nil }, answer: func(Host, string, string) ([]byte, []byte, error) { return nil, nil, nil }}
	if _, err := InstallMacDesktop(context.Background(), linux, mac, "/p.pkg", "", InstallOptions{}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "for macOS") || copied(linux) {
		t.Errorf("a Linux host: %v", err)
	}
	m := &macHost{arch: "arm64"}
	if _, err := InstallMacDesktop(context.Background(), m.runner(), mac, "/p.pkg", "", InstallOptions{}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "passwordless sudo") || !strings.Contains(err.Error(), "--ask-sudo") {
		t.Errorf("sudo that asks: %v", err)
	}
	if _, err := InstallMacDesktop(context.Background(), m.runner(), mac, "/p.pkg", "", InstallOptions{SudoHint: "set askSudo in the fleet file"}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "set askSudo in the fleet file") || strings.Contains(err.Error(), "--ask-sudo") {
		t.Errorf("a caller's remedy replaces the default: %v", err)
	}
	if _, err := InstallMacDesktop(context.Background(), m.runner(), mac, "/p.pkg", "", InstallOptions{AskSudo: true}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "no terminal") {
		t.Errorf("--ask-sudo without a terminal: %v", err)
	}
	intel := &macHost{arch: "amd64", sudoOK: true}
	if _, err := InstallMacDesktop(context.Background(), intel.runner(), mac, "/p.pkg", "arm64", InstallOptions{}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "built for [arm64]") {
		t.Errorf("an arm64 package on Intel is refused before copying: %v", err)
	}
}

func TestInstallMacDesktop_AskSudoRunsOnTheTerminal(t *testing.T) {
	m := &macHost{arch: "arm64", installedArchs: "arm64"}
	r := m.runner()
	if _, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{AskSudo: true, Interactive: true}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	all := joined(r)
	if !strings.Contains(all, terminalScript+"trap ") && strings.Contains(all, "sudo -p 'Password for %u on mac (ion fleet install): ' installer -pkg") || strings.Contains(all, "sudo -n") {
		t.Errorf("the installer must run on the terminal without -n, prompting with the host's name, and no passwordless check:\n%s", all)
	}
	if len(r.banners) != 1 || !strings.Contains(r.banners[0], "installing the Ion desktop on mac.") || !strings.Contains(r.banners[0], "your password on mac") {
		t.Errorf("the terminal run must say whose password it asks for: %q", r.banners)
	}
}

func TestMacSudoPrompt_EscapesPercentInTheHostName(t *testing.T) {
	if got := macSudoPrompt(Host{Name: "lab%1"}); got != "Password for %u on lab%%1 (ion fleet install): " {
		t.Errorf("prompt = %q", got)
	}
}

func TestInstallMacDesktop_Backup(t *testing.T) {
	m := &macHost{arch: "arm64", sudoOK: true, installedArchs: "arm64", backupAnswer: "/Users/u/.ion-backup-20260101-000000|7|7"}
	rec, err := InstallMacDesktop(context.Background(), m.runner(), mac, "/p.pkg", "", InstallOptions{Backup: true}, &bytes.Buffer{})
	if err != nil || rec.Backup != "/Users/u/.ion-backup-20260101-000000" {
		t.Fatalf("rec = %+v err = %v", rec, err)
	}
	m = &macHost{arch: "arm64", sudoOK: true, backupAnswer: "/Users/u/.ion-backup-x|7|3"}
	r := m.runner()
	if _, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{Backup: true}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "holds 3 of 7") {
		t.Fatalf("a short backup: %v", err)
	}
	if copied(r) {
		t.Error("nothing may be copied after a failed backup")
	}
}

func TestInstallMacDesktop_Relay(t *testing.T) {
	const ion = "'/Applications/Ion.app/Contents/Resources/engine/ion' "
	m := &macHost{arch: "arm64", sudoOK: true, installedArchs: "arm64"}
	r := m.runner()
	rec, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{Relay: "wss://relay.example.org", RelayOIDC: true}, &bytes.Buffer{})
	if err != nil || rec.Relay != "wss://relay.example.org" || !rec.RelayApplied {
		t.Fatalf("rec = %+v err = %v", rec, err)
	}
	if !strings.Contains(joined(r), ion+"'studio' 'relay' 'set' 'wss://relay.example.org' '--oidc' '--no-restart'") {
		t.Errorf("scripts:\n%s", joined(r))
	}

	r = (&macHost{arch: "arm64", sudoOK: true, installedArchs: "arm64"}).runner()
	if _, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{Relay: "wss://relay.example.org", RelayKey: "the-secret-key"}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(joined(r), "the-secret-key") || !contains(r.stdins, "the-secret-key\n") || !strings.Contains(joined(r), "'--key-stdin' '--no-restart'") {
		t.Errorf("the key travels on stdin only: %q", r.stdins)
	}

	r = (&macHost{arch: "arm64", sudoOK: true}).runner()
	if _, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{Relay: "wss://relay.example.org"}, &bytes.Buffer{}); !errors.Is(err, errRelayAuth) || len(r.scripts) != 0 {
		t.Errorf("a relay with no auth is refused before the host is touched: %v %v", err, r.scripts)
	}

	r = (&macHost{arch: "arm64", sudoOK: true, installedArchs: "arm64", relayListFails: true}).runner()
	if _, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{Relay: "wss://relay.example.org", RelayOIDC: true}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "no 'ion studio relay' command") || strings.Contains(joined(r), "'relay' 'set'") {
		t.Errorf("an engine without the relay command: %v", err)
	}
}

// Ion reads server.json only when it starts, and the package relaunches it:
// a relay that changed restarts it, one already set leaves it, and a restart
// that fails leaves the install good with the relay pending.
func TestInstallMacDesktop_RelayRestartsARunningIon(t *testing.T) {
	m := &macHost{arch: "arm64", sudoOK: true, installedArchs: "arm64", postinstallRun: true}
	r := m.runner()
	rec, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{Relay: "wss://relay.example.org", RelayOIDC: true}, &bytes.Buffer{})
	all := joined(r)
	set := strings.Index(all, "'relay' 'set'")
	restart := strings.LastIndex(all, `pkill -USR2 -f "$PAT"`)
	if err != nil || !rec.RelayApplied || set < 0 || restart < set || !strings.Contains(all[restart:], "open -a '/Applications/Ion.app'") {
		t.Fatalf("rec = %+v err = %v\n%s", rec, err, all)
	}

	r = (&macHost{arch: "arm64", sudoOK: true, installedArchs: "arm64", postinstallRun: true, relayResult: "already set"}).runner()
	if _, err := InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{Relay: "wss://relay.example.org", RelayOIDC: true}, &bytes.Buffer{}); err != nil || strings.Contains(joined(r), "pkill") {
		t.Errorf("an unchanged relay must not restart Ion: %v", err)
	}

	r = (&macHost{arch: "arm64", sudoOK: true, installedArchs: "arm64", postinstallRun: true, restartFails: true}).runner()
	var log bytes.Buffer
	rec, err = InstallMacDesktop(context.Background(), r, mac, "/p.pkg", "", InstallOptions{Relay: "wss://relay.example.org", RelayOIDC: true}, &log)
	if err != nil || rec.RelayApplied || !strings.Contains(log.String(), "takes effect when Ion next starts") {
		t.Errorf("a failed restart: rec = %+v err = %v", rec, err)
	}
}

func TestInstallMacDesktop_VerifiesTheInstalledCPU(t *testing.T) {
	m := &macHost{arch: "amd64", sudoOK: true, installedArchs: "arm64"}
	if _, err := InstallMacDesktop(context.Background(), m.runner(), mac, "/p.pkg", "", InstallOptions{}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "will not run on") {
		t.Errorf("an arm64 app on Intel: %v", err)
	}
	m = &macHost{arch: "arm64", sudoOK: true, installedArchs: "x86_64"}
	if _, err := InstallMacDesktop(context.Background(), m.runner(), mac, "/p.pkg", "", InstallOptions{}, &bytes.Buffer{}); err != nil {
		t.Errorf("an Intel app runs on Apple silicon: %v", err)
	}
}

// winHost is a scripted Windows host.
type winHost struct {
	notAdmin  bool
	state     string // absent, yes, no
	installed string // DisplayVersion after the install
	quitFails bool
	// launchFails: Ion is not running after the launch, as on a laptop on
	// battery before the launch task allowed batteries.
	launchFails bool
}

func (w *winHost) runner() *fakeRunner {
	return &fakeRunner{
		platform: func(Host) (Platform, error) {
			return Platform{GOOS: "windows", GOARCH: "arm64", LoginShell: ShellPowerShell}, nil
		},
		answer: func(_ Host, script, _ string) ([]byte, []byte, error) {
			ps := strings.TrimPrefix(script, psScript)
			switch {
			case ps == psIsAdmin:
				if w.notAdmin {
					return []byte("no\n"), nil, nil
				}
				return []byte("yes\n"), nil, nil
			case ps == psDesktopState:
				return []byte(w.state + "\n"), nil, nil
			case ps == psQuitDesktopOrFail:
				if w.quitFails {
					return nil, []byte("Ion is still running after a forced stop"), errors.New("exit status 7")
				}
			case ps == psStartDesktop:
				if w.launchFails {
					return nil, []byte("Ion did not start within 30 seconds of its launch"), errors.New("exit status 9")
				}
			case ps == psInstalledDesktop:
				return []byte(w.installed + `|C:\Program Files\Ion` + "\n"), nil, nil
			case strings.Contains(ps, "'studio' 'relay' 'set'"):
				return []byte("==> relay saved (oidc)\n"), nil, nil
			}
			return nil, nil, nil
		},
	}
}

var win = Host{Name: "win", SSH: "user@win.example.org"}

func TestInstallWindowsDesktop_InstallsQuitsAndRelaunches(t *testing.T) {
	w := &winHost{state: "yes", installed: "1.101.0-dev.abc"}
	r := w.runner()
	rec, err := InstallWindowsDesktop(context.Background(), r, win, "/out/Ion-Setup-1.101.0-dev.abc-arm64.exe", InstallOptions{QuitIon: true, Relay: "wss://relay.example.org", RelayOIDC: true}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if !rec.OK || !rec.WasRunning || !rec.Opened || rec.Version != "1.101.0-dev.abc" || rec.Relay != "wss://relay.example.org" {
		t.Errorf("receipt = %+v", rec)
	}
	all := joined(r)
	for _, want := range []string{
		psScript + psQuitDesktopOrFail,
		copyToScript + "/out/Ion-Setup-1.101.0-dev.abc-arm64.exe -> .ion/fleet-incoming/Ion-Setup-1.101.0-dev.abc-arm64.exe",
		"$name = 'Ion-Setup-1.101.0-dev.abc-arm64.exe'\n" + psInstallDesktop,
		`& 'C:\Program Files\Ion\resources\engine\ion.exe' 'studio' 'relay' 'set' 'wss://relay.example.org' '--oidc' '--no-restart'`,
		psScript + psStartDesktop,
	} {
		if !strings.Contains(all, want) {
			t.Errorf("scripts lack %q:\n%s", want, all)
		}
	}
	if !strings.Contains(psInstallDesktop, "'/S', '/allusers'") || !strings.Contains(psInstallDesktop, "Remove-Item -LiteralPath $setup") {
		t.Errorf("the installer runs silently for every user and is removed:\n%s", psInstallDesktop)
	}
	// A hung installer child once held a deploy for most of an hour with no
	// message. The wait is bounded, and what is stuck is named.
	for _, want := range []string{"WaitForExit($minutes * 60 * 1000)", "$minutes = " + windowsInstallMinutes, "Get-Descendant $p.Id", "exit 6"} {
		if !strings.Contains(psInstallDesktop, want) {
			t.Errorf("the install wait lacks %q:\n%s", want, psInstallDesktop)
		}
	}
	if strings.Contains(psInstallDesktop, "-Wait") {
		t.Error("Start-Process -Wait waits without a bound")
	}
	// The installer's file stays locked for a moment after it exits. A silent
	// failed removal as the last statement made PowerShell exit 1, failing an
	// install that had succeeded.
	if !strings.HasSuffix(psInstallDesktop, "\nexit 0\n") {
		t.Errorf("the install script must end in an explicit exit 0:\n%s", psInstallDesktop)
	}
	if !strings.Contains(psInstallDesktop, "Remove-Item -LiteralPath $setup -Force -ErrorAction Stop") || !strings.Contains(psInstallDesktop, "Start-Sleep") {
		t.Error("the installer's removal must retry while its file is still locked")
	}
	// The relay is written before Ion starts again, so it reads it then.
	if strings.Index(all, "'relay' 'set'") > strings.LastIndex(all, "Start-InUserSession $exe ''") {
		t.Error("the relay must be written before Ion is relaunched")
	}
}

func TestInstallWindowsDesktop_Refusals(t *testing.T) {
	cases := []struct {
		name  string
		host  *winHost
		setup string
		opts  InstallOptions
		want  string
	}{
		{"not an installer", &winHost{}, "/out/Ion.pkg", InstallOptions{}, "not a Windows desktop installer"},
		{"an x64-only host gets no arm64 build", nil, "/out/Ion-Setup-1.0.0-arm64.exe", InstallOptions{}, "built for arm64"},
		{"no administrator", &winHost{notAdmin: true}, "/out/Ion-Setup-1.0.0-arm64.exe", InstallOptions{}, "not an administrator"},
		{"running without --quit-ion", &winHost{state: "yes"}, "/out/Ion-Setup-1.0.0-arm64.exe", InstallOptions{}, "--quit-ion"},
		{"would not quit", &winHost{state: "yes", quitFails: true}, "/out/Ion-Setup-1.0.0-arm64.exe", InstallOptions{QuitIon: true}, "would not quit"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var r *fakeRunner
			if c.host == nil {
				r = (&winHost{}).runner()
				r.platform = func(Host) (Platform, error) { return Platform{GOOS: "windows", GOARCH: "amd64"}, nil }
			} else {
				r = c.host.runner()
			}
			if _, err := InstallWindowsDesktop(context.Background(), r, win, c.setup, c.opts, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v", err)
			}
			if copied(r) {
				t.Error("nothing may be copied to a refused host")
			}
		})
	}
	w := &winHost{state: "absent", installed: "0.9.0"}
	if _, err := InstallWindowsDesktop(context.Background(), w.runner(), win, "/out/Ion-Setup-1.0.0-arm64.exe", InstallOptions{}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), `reports desktop "0.9.0" after installing 1.0.0`) {
		t.Errorf("a version that did not land: %v", err)
	}
}

func TestInstallServer(t *testing.T) {
	r := &fakeRunner{
		platform: func(Host) (Platform, error) {
			return Platform{GOOS: "linux", GOARCH: "arm64", LoginShell: ShellPOSIX}, nil
		},
		answer: func(_ Host, script, _ string) ([]byte, []byte, error) {
			switch {
			case strings.HasSuffix(script, "sh -s"):
				return []byte("==> installing\n{\"ok\":true,\"version\":\"0.2.0\"}\n"), nil, nil
			case strings.Contains(script, "studio pair"):
				return []byte("ion-studio://pair?code=x\n"), nil, nil
			}
			return nil, nil, nil
		},
	}
	g := Host{Name: "g", SSH: "g"}
	rec, err := InstallServer(context.Background(), r, g, "/b/ion-studio-server-linux-arm64.tar.gz", []byte("#!/bin/sh"), InstallOptions{Label: "lab", System: true, Relay: "wss://relay.example.org", RelayKey: "k", Pair: "laptop"}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if !rec.OK || rec.Version != "0.2.0" || rec.PairingLink != "ion-studio://pair?code=x" || rec.Install["ok"] != true {
		t.Errorf("receipt = %+v", rec)
	}
	all := joined(r)
	for _, want := range []string{
		`ION_STUDIO_BUNDLE="$HOME/.ion/studio-server/incoming/ion-studio-server-linux-arm64.tar.gz" ION_STUDIO_INSTALL_ARGS='--label lab --system' sh -s`,
		`"$HOME/.ion/studio-server/current/bin/ion" 'studio' 'relay' 'set' 'wss://relay.example.org' '--key-stdin'`,
	} {
		if !strings.Contains(all, want) {
			t.Errorf("scripts lack %q:\n%s", want, all)
		}
	}
	if strings.Contains(all, "--no-restart") || !contains(r.stdins, "#!/bin/sh") {
		t.Errorf("a server restarts itself for its relay, and its installer arrives on stdin: %q", r.stdins)
	}
	if _, err := InstallServer(context.Background(), r, g, "/b/ion-studio-server-darwin-arm64.tar.gz", nil, InstallOptions{}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "takes ion-studio-server-linux-arm64.tar.gz") {
		t.Errorf("a bundle for another platform: %v", err)
	}
	if _, err := InstallServer(context.Background(), r, g, "/b/ion-studio-server-linux-arm64.tar.gz", nil, InstallOptions{Label: "my lab"}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "one word") {
		t.Errorf("a label the installer would split: %v", err)
	}
}

func TestParseInstallArgs(t *testing.T) {
	o, rest, err := ParseInstallArgs([]string{"--quit-ion", "--ask-sudo", "--relay", "wss://r", "--relay-oidc", "--pair", "laptop", "--backup", "--kind", "desktop"}, InstallOptions{})
	if err != nil || !o.QuitIon || !o.AskSudo || o.Relay != "wss://r" || !o.RelayOIDC || o.Pair != "laptop" || !o.Backup || strings.Join(rest, " ") != "--kind desktop" {
		t.Fatalf("o = %+v rest = %v err = %v", o, rest, err)
	}
	if o, _, _ := ParseInstallArgs([]string{"--pair", "--open"}, InstallOptions{}); o.Pair == "" || !o.Open { //nolint:errcheck // asserted by the fields
		t.Errorf("a bare --pair takes this machine's name: %+v", o)
	}
	if _, _, err := ParseInstallArgs([]string{"--relay"}, InstallOptions{}); err == nil {
		t.Error("--relay needs a value")
	}
}

func TestInstallWindowsDesktop_LaunchThatDoesNotStartIsNotOpened(t *testing.T) {
	w := &winHost{state: "no", installed: "1.101.0-dev.abc", launchFails: true}
	rec, err := InstallWindowsDesktop(context.Background(), w.runner(), win, "/out/Ion-Setup-1.101.0-dev.abc-arm64.exe", InstallOptions{Open: true}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if !rec.OK || rec.Opened {
		t.Errorf("an install whose Ion never started must not report it opened: %+v", rec)
	}
}

func TestInstallWindowsDesktop_PairNeedsIonToStart(t *testing.T) {
	w := &winHost{state: "no", installed: "1.101.0-dev.abc", launchFails: true}
	if _, err := InstallWindowsDesktop(context.Background(), w.runner(), win, "/out/Ion-Setup-1.101.0-dev.abc-arm64.exe", InstallOptions{Pair: "phone"}, &bytes.Buffer{}); err == nil {
		t.Fatal("a pairing link was attempted although Ion never started")
	}
}
