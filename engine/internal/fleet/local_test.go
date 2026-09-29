package fleet

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// onMac pretends this machine is an Apple silicon Mac with its build tools.
func onMac(t *testing.T) {
	pretendLocal(t, Platform{GOOS: "darwin", GOARCH: "arm64"}, nil)
}

// onWindows pretends this machine runs Windows with its build tools.
func onWindows(t *testing.T) {
	pretendLocal(t, Platform{GOOS: "windows", GOARCH: "arm64"}, nil)
}

// pretendLocal fixes this machine's platform and which build tools it lacks,
// so a test never depends on what the real machine has installed.
func pretendLocal(t *testing.T, p Platform, lacks []string) {
	oldPlatform, oldTool := localPlatform, localToolFound
	localPlatform = func() Platform { return p }
	localToolFound = func(name string) bool { return !slices.Contains(lacks, name) }
	t.Cleanup(func() { localPlatform, localToolFound = oldPlatform, oldTool })
}

// A fleet manager on Windows runs its own commands (a relay key command, a
// local host's scripts, a terminal hand-off) in PowerShell, not sh.
func TestLocalShell_PerOS(t *testing.T) {
	onMac(t)
	if cmd := localCommand(context.Background(), "echo hi"); !strings.HasSuffix(cmd.Path, "sh") || strings.Join(cmd.Args[1:], " ") != "-c echo hi" {
		t.Errorf("mac: %s %v", cmd.Path, cmd.Args)
	}
	if p := localHostPlatform(); p.LoginShell != ShellPOSIX {
		t.Errorf("mac local host = %+v", p)
	}
	onWindows(t)
	if cmd := localCommand(context.Background(), "echo hi"); !strings.Contains(strings.ToLower(filepath.Base(cmd.Path)), "powershell") || cmd.Args[len(cmd.Args)-1] != "echo hi" || cmd.Args[len(cmd.Args)-2] != "-Command" {
		t.Errorf("windows: %s %v", cmd.Path, cmd.Args)
	}
	if p := localHostPlatform(); p != (Platform{GOOS: "windows", GOARCH: "arm64", LoginShell: ShellPowerShell}) {
		t.Errorf("windows local host = %+v", p)
	}
	spec := terminalCommand(Host{SSH: LocalSSH}, "echo hi")
	if !strings.Contains(strings.ToLower(spec.Name), "powershell") || !spec.Interactive {
		t.Errorf("a local terminal hand-off on Windows = %+v", spec)
	}
	if p, err := (ExecRunner{}).Platform(context.Background(), Host{Name: "me", SSH: LocalSSH}); err != nil || !p.Windows() {
		t.Errorf("the local host is this machine, with no probe: %+v %v", p, err)
	}
}

func TestCopyLocal_RelativeIsUnderHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	src := filepath.Join(t.TempDir(), "Ion-Setup-1.0.0-arm64.exe")
	if err := os.WriteFile(src, []byte("installer"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := copyLocal(src, ".ion/fleet-incoming/Ion-Setup-1.0.0-arm64.exe"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(home, ".ion", "fleet-incoming", "Ion-Setup-1.0.0-arm64.exe"))
	if err != nil || string(data) != "installer" {
		t.Fatalf("copied = %q %v", data, err)
	}
	back := filepath.Join(t.TempDir(), "back.exe")
	if err := copyLocal(".ion/fleet-incoming/Ion-Setup-1.0.0-arm64.exe", back); err != nil {
		t.Fatal(err)
	}
}
