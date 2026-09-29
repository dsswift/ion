package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestResolveWindowsDesktop pins how a Windows desktop is found: the uninstall
// key's InstallLocation, else its DisplayIcon's folder (the installer leaves
// InstallLocation empty), else the per-machine and per-user folders.
func TestResolveWindowsDesktop(t *testing.T) {
	root := t.TempDir()
	perMachine := filepath.Join(root, "Program Files", "Ion")
	perUser := filepath.Join(root, "AppData", "Local", "Programs", "Ion")
	for _, dir := range []string{perMachine, perUser} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	has := map[string]bool{}
	exists := func(p string) bool { return has[p] }
	candidates := []string{perMachine, perUser}

	if got := resolveWindowsDesktop(nil, candidates, exists); got != nil {
		t.Fatalf("no key and no Ion.exe is no desktop: %+v", got)
	}
	has[filepath.Join(perUser, "Ion.exe")] = true
	if got := resolveWindowsDesktop(nil, candidates, exists); got == nil || got.Root != perUser || got.Version != "" {
		t.Fatalf("a per-user install without a key: %+v", got)
	}
	has[filepath.Join(perMachine, "Ion.exe")] = true
	icon := &uninstallEntry{DisplayVersion: "1.101.0-dev.abc", DisplayIcon: filepath.Join(perMachine, "Ion.exe") + ",0"}
	got := resolveWindowsDesktop(icon, nil, exists)
	if got == nil || got.Root != perMachine || got.Version != "1.101.0-dev.abc" || got.GOOS != "windows" {
		t.Fatalf("DisplayIcon's folder: %+v", got)
	}
	if got.engineBin() != filepath.Join(perMachine, "resources", "engine", "ion.exe") ||
		got.serverFile("compat.json") != filepath.Join(perMachine, "resources", "app.asar.unpacked", "dist", "server", "compat.json") ||
		got.executable() != filepath.Join(perMachine, "Ion.exe") {
		t.Errorf("windows paths: %s %s %s", got.engineBin(), got.serverFile("compat.json"), got.executable())
	}
	located := &uninstallEntry{DisplayVersion: "2", InstallLocation: `"` + perUser + `"`, DisplayIcon: filepath.Join(perMachine, "Ion.exe")}
	if got := resolveWindowsDesktop(located, nil, exists); got == nil || got.Root != perUser {
		t.Fatalf("InstallLocation wins over DisplayIcon: %+v", got)
	}
}

func TestWindowsEngineService(t *testing.T) {
	task := `Ion Engine (S-1-5-21-1)`
	cases := map[string]struct {
		out  string
		code int
		want string
	}{
		"running":  {`"\Ion Engine (S-1-5-21-1)","N/A","Running"`, 0, "running"},
		"ready":    {`"\Ion Engine (S-1-5-21-1)","N/A","Ready"`, 0, "stopped"},
		"disabled": {`"\Ion Engine (S-1-5-21-1)","N/A","Disabled"`, 0, "disabled"},
		"missing":  {"ERROR: The system cannot find the file specified.", 1, "not-installed"},
	}
	for name, c := range cases {
		r := &fakeRunner{results: map[string]fakeResult{"schtasks /Query /TN " + task: {out: c.out, code: c.code}}}
		got := windowsEngineService(r, task)
		if got.State != c.want || got.Label != task {
			t.Errorf("%s: %+v, want %s", name, got, c.want)
		}
		if !r.called("schtasks /Query /TN " + task + " /FO CSV /NH") {
			t.Errorf("%s: calls = %v", name, r.calls)
		}
	}
}

func TestStudioServerCLI_WindowsDesktop(t *testing.T) {
	root := t.TempDir()
	inst := &desktopInstall{GOOS: "windows", Root: root, Version: "1"}
	if err := os.MkdirAll(filepath.Dir(inst.serverFile("pair.js")), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(inst.serverFile("pair.js"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	bin, script, env, err := studioServerCLI(studioLayout{current: filepath.Join(root, "none")}, inst, "pair.js")
	if err != nil || bin != filepath.Join(root, "Ion.exe") || script != inst.serverFile("pair.js") || !strings.Contains(strings.Join(env, " "), "ELECTRON_RUN_AS_NODE=1") {
		t.Fatalf("bin=%s script=%s env=%v err=%v", bin, script, env, err)
	}
}
