package fleet

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"
	"unicode/utf16"
)

// decodePowerShell reverses encodePowerShell.
func decodePowerShell(t *testing.T, encoded string) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	units := make([]uint16, len(raw)/2)
	for i := range units {
		units[i] = uint16(raw[2*i]) | uint16(raw[2*i+1])<<8
	}
	return string(utf16.Decode(units))
}

// scriptOf returns the script a powerShellCommand line carries.
func scriptOf(t *testing.T, line string) string {
	t.Helper()
	const flag = "-EncodedCommand "
	i := strings.Index(line, flag)
	if i < 0 {
		t.Fatalf("no encoded command in %q", line)
	}
	encoded := strings.Fields(line[i+len(flag):])[0]
	return decodePowerShell(t, strings.TrimSuffix(encoded, ";"))
}

type probeAnswer struct {
	out string
	err error
}

// probeRun answers each probe command in order and records what ran.
func probeRun(answers ...probeAnswer) (rawRun, *[]string) {
	var ran []string
	return func(_ context.Context, _ Host, command string, _ io.Reader) ([]byte, []byte, error) {
		ran = append(ran, command)
		a := answers[len(ran)-1]
		return []byte(a.out), nil, a.err
	}, &ran
}

func TestProbePlatform(t *testing.T) {
	failed := errors.New("exit 1")
	h := Host{Name: "w", SSH: "w"}

	run, ran := probeRun(probeAnswer{out: "Darwin\narm64\n"})
	p, err := probePlatform(context.Background(), run, h)
	if err != nil || p != (Platform{GOOS: "darwin", GOARCH: "arm64", LoginShell: ShellPOSIX}) || len(*ran) != 1 {
		t.Fatalf("mac: %+v %v ran %v", p, err, *ran)
	}

	// A Windows host whose ssh starts PowerShell: uname fails, the edition
	// prints, and the CPU comes from an encoded script whose exit code the
	// outer PowerShell hands on.
	run, ran = probeRun(probeAnswer{err: failed}, probeAnswer{out: "Desktop\r\n"}, probeAnswer{out: "Arm64\r\n"})
	p, err = probePlatform(context.Background(), run, h)
	if err != nil || p != (Platform{GOOS: "windows", GOARCH: "arm64", LoginShell: ShellPowerShell}) {
		t.Fatalf("windows powershell: %+v %v", p, err)
	}
	third := (*ran)[2]
	if !strings.HasPrefix(third, "powershell -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ") || !strings.HasSuffix(third, "; exit $LASTEXITCODE") {
		t.Errorf("arch probe line = %q", third)
	}
	if got := scriptOf(t, third); got != psPrelude+probeWindowsArch {
		t.Errorf("arch probe script = %q", got)
	}

	// cmd as the login shell does not expand the edition and passes the exit
	// code on by itself.
	run, ran = probeRun(probeAnswer{err: failed}, probeAnswer{out: "$PSVersionTable.PSEdition\r\n"}, probeAnswer{out: "X64\r\n"})
	p, err = probePlatform(context.Background(), run, h)
	if err != nil || p != (Platform{GOOS: "windows", GOARCH: "amd64", LoginShell: ShellCmd}) || strings.Contains((*ran)[2], "LASTEXITCODE") {
		t.Fatalf("windows cmd: %+v %v ran %v", p, err, *ran)
	}
}

func TestProbePlatform_UnreachableStopsAtUname(t *testing.T) {
	run, ran := probeRun(probeAnswer{err: sshExit255(t)})
	if _, err := probePlatform(context.Background(), run, Host{Name: "w", SSH: "w"}); err == nil || !strings.Contains(err.Error(), "unreachable") {
		t.Fatalf("err = %v", err)
	}
	if len(*ran) != 1 {
		t.Errorf("an unreachable host was probed again: %v", *ran)
	}
}

func TestEncodePowerShell_NonASCII(t *testing.T) {
	script := "'relay — ✓'"
	if got := decodePowerShell(t, encodePowerShell(script)); got != script {
		t.Fatalf("round trip = %q", got)
	}
}

func windowsRunner(answer func(script, stdin string) ([]byte, []byte, error)) *fakeRunner {
	return &fakeRunner{
		answer: func(_ Host, script, stdin string) ([]byte, []byte, error) { return answer(script, stdin) },
		platform: func(Host) (Platform, error) {
			return Platform{GOOS: "windows", GOARCH: "arm64", LoginShell: ShellPowerShell}, nil
		},
	}
}

func TestRunIon_Windows(t *testing.T) {
	r := windowsRunner(func(string, string) ([]byte, []byte, error) { return []byte("{}"), nil, nil })
	if _, err := runIon(context.Background(), r, Host{Name: "w", SSH: "w"}, []string{"studio", "pair", "--label", "ion fleet on o'brien"}, nil); err != nil {
		t.Fatal(err)
	}
	script := r.scripts[0]
	if !strings.HasPrefix(script, psScript+psFindIon) {
		t.Fatalf("script does not find ion.exe first: %s", script)
	}
	if !strings.Contains(script, `& $ion 'studio' 'pair' '--label' 'ion fleet on o''brien'`+"\nexit $LASTEXITCODE") {
		t.Errorf("script = %s", script)
	}
}

func TestRestart_WindowsDesktop(t *testing.T) {
	r := windowsRunner(func(string, string) ([]byte, []byte, error) { return nil, nil, nil })
	if err := (Ops{Runner: r}).Restart(context.Background(), Host{Name: "w", SSH: "w", Kind: KindDesktop}); err != nil {
		t.Fatal(err)
	}
	script := r.scripts[0]
	for _, want := range []string{psScript, "Start-InUserSession $exe '--ion-force-quit'", "Get-Ion | Stop-Process -Force", "Start-InUserSession $exe ''", "-LogonType Interactive"} {
		if !strings.Contains(script, want) {
			t.Errorf("restart script lacks %q", want)
		}
	}
	if strings.Contains(script, "pkill") {
		t.Error("a Windows restart ran the Mac script")
	}
}

func TestSetRelay_WindowsDesktopRestartsARunningIon(t *testing.T) {
	r := windowsRunner(func(script, _ string) ([]byte, []byte, error) {
		switch {
		case strings.Contains(script, "& $ion"):
			return []byte("==> relay wss://r saved (pre-shared key)\n"), nil, nil
		case strings.HasSuffix(script, psDesktopRunning):
			return []byte("yes\r\n"), nil, nil
		}
		return nil, nil, nil
	})
	p := Profile{Relay: "wss://r", RelayKeyCommand: "echo the-key"}
	if err := SetRelay(context.Background(), r, Host{Name: "w", SSH: "w", Kind: KindDesktop}, p); err != nil {
		t.Fatal(err)
	}
	if len(r.scripts) != 3 || !strings.HasSuffix(r.scripts[1], psDesktopRunning) || !strings.HasSuffix(r.scripts[2], psRestartDesktop) {
		t.Fatalf("scripts = %d, want relay set, running check, restart", len(r.scripts))
	}
	if r.stdins[0] != "the-key\n" || strings.Contains(strings.Join(r.scripts, " "), "the-key") {
		t.Errorf("the key must travel on stdin only: stdin %q", r.stdins[0])
	}
}

// A launch task with the default settings stays Queued on a laptop running on
// battery and never starts Ion, and the launch used to report success anyway.
func TestStartDesktop_RunsOnBatteryAndWaitsForIon(t *testing.T) {
	for _, want := range []string{
		"New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
		"-Settings $settings",
		"(Get-ScheduledTask -TaskName $name).State -eq 'Queued'",
		"throw \"Windows did not start $program",
	} {
		if !strings.Contains(psStartInUserSession, want) {
			t.Errorf("Start-InUserSession lacks %q", want)
		}
	}
	for name, script := range map[string]string{"start": psStartDesktop, "restart": psRestartDesktop} {
		if !strings.HasSuffix(script, psAwaitDesktop) {
			t.Errorf("the %s script does not wait for Ion to be running", name)
		}
	}
	if !strings.Contains(psAwaitDesktop, "if (-not (Get-Ion))") || !strings.Contains(psAwaitDesktop, "exit 9") {
		t.Errorf("the wait does not fail when Ion is not running:\n%s", psAwaitDesktop)
	}
}
