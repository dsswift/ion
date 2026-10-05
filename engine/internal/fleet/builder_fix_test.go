package fleet

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// checkoutWithVersions is a fake checkout whose manifests name its tools.
func checkoutWithVersions(t *testing.T) string {
	t.Helper()
	dir := fakeCheckout(t)
	if err := os.WriteFile(filepath.Join(dir, "engine", "go.mod"), []byte("module x\n\ngo 1.26.0\n\ntoolchain go1.27.1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "scripts", "package-studio-server.sh"), []byte("NODE_VERSION=\"${ION_NODE_VERSION:-v22.23.2}\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// Excluding a Windows host's build folder from Defender is one script, and
// the host is asked again afterwards whether it can build.
func TestPrepareBuilder_ExcludesTheBuildFolderFromDefender(t *testing.T) {
	onMac(t)
	h := Host{Name: "win", SSH: "win", Kind: KindDesktop, BuildDir: `C:\dev\ion-build`}
	cfg := Config{Hosts: []Host{h}}
	excluded := false
	f, d := builderFixture(t, cfg, nil)
	f.platform["win"] = "Windows arm64"
	base := f.runner.answer
	f.runner.answer = func(host Host, script, stdin string) ([]byte, []byte, error) {
		switch {
		case strings.Contains(script, "Add-MpPreference -ExclusionPath"):
			if !strings.Contains(script, `$d = 'C:\dev\ion-build'`) {
				t.Errorf("the host's own build folder is the one excluded:\n%s", script)
			}
			excluded = true
			return []byte("excluded\n"), nil, nil
		case strings.Contains(script, "Get-Command $t") && !excluded:
			return []byte("defender:C:\\dev\\ion-build\\\n"), nil, nil
		}
		return base(host, script, stdin)
	}
	var steps []string
	check, err := d.PrepareBuilder(context.Background(), h, BuilderFix{ExcludeBuildDir: true}, "", io.Discard, func(s string) { steps = append(steps, s) })
	if err != nil || !check.OK() || !excluded {
		t.Fatalf("check = %+v, err = %v, excluded = %v", check, err, excluded)
	}
	if joined := strings.Join(steps, "\n"); !strings.Contains(joined, "exclude win's build folder from Microsoft Defender") || !strings.Contains(joined, "check win again") {
		t.Errorf("steps = %v", steps)
	}
}

// On Windows the build tools come from the shipped checkout's own setup.
func TestPrepareBuilder_WindowsToolsComeFromTheCheckoutsSetup(t *testing.T) {
	onMac(t)
	h := Host{Name: "win", SSH: "win", Kind: KindDesktop}
	cfg := Config{Hosts: []Host{h}}
	installed := false
	f, d := builderFixture(t, cfg, nil)
	f.platform["win"] = "Windows arm64"
	base := f.runner.answer
	f.runner.answer = func(host Host, script, stdin string) ([]byte, []byte, error) {
		switch {
		case strings.Contains(script, `-File .\make.ps1 setup -Arch arm64`):
			installed = true
			return []byte("OK  make setup complete\n"), nil, nil
		case strings.Contains(script, "Get-Command $t") && !installed:
			return []byte("go\nnode\nnpm\n"), nil, nil
		}
		return base(host, script, stdin)
	}
	check, err := d.PrepareBuilder(context.Background(), h, BuilderFix{Tools: true}, checkoutWithVersions(t), io.Discard, nil)
	if err != nil || !check.OK() || !installed {
		t.Fatalf("check = %+v, err = %v, installed = %v", check, err, installed)
	}
	if scripts := strings.Join(f.scriptsFor("win"), "\n"); !strings.Contains(scripts, "-> .ion/fleet-build/src.tgz") {
		t.Errorf("the checkout must ship before its setup runs:\n%s", scripts)
	}
	if d.archivePath != "" {
		t.Error("the checkout archive must be removed afterwards")
	}
}

// On macOS and Linux only Go and Node are installed, at the versions the
// checkout names, under the fleet's own folder; a host that lacks anything
// else is told so, and nothing is installed.
func TestPrepareBuilder_PosixInstallsGoAndNodeAtTheCheckoutsVersions(t *testing.T) {
	onMac(t)
	h := Host{Name: "pi", SSH: "pi", Kind: KindServer}
	cfg := Config{Hosts: []Host{h}}
	lacks := "go\nnpm\n"
	var install string
	f, d := builderFixture(t, cfg, nil)
	f.platform["pi"] = "Linux aarch64"
	base := f.runner.answer
	f.runner.answer = func(host Host, script, stdin string) ([]byte, []byte, error) {
		switch {
		case strings.Contains(script, "fleet-build/tools") && strings.Contains(script, "curl -fsSL"):
			install, lacks = script, ""
			return []byte("installed\n"), nil, nil
		case strings.Contains(script, "command -v $t"):
			if !strings.Contains(script, ".ion/fleet-build/tools/go/bin") {
				t.Error("the check must look in the fleet's own tools folder")
			}
			return []byte(lacks), nil, nil
		}
		return base(host, script, stdin)
	}
	checkout := checkoutWithVersions(t)
	check, err := d.PrepareBuilder(context.Background(), h, BuilderFix{Tools: true}, checkout, io.Discard, nil)
	if err != nil || !check.OK() {
		t.Fatalf("check = %+v, err = %v", check, err)
	}
	for _, want := range []string{"go1.27.1.$OS-$GA.tar.gz", "https://nodejs.org/dist/v22.23.2/", "checksum mismatch"} {
		if !strings.Contains(install, want) {
			t.Errorf("install script lacks %q:\n%s", want, install)
		}
	}

	lacks, install = "curl\ngo\n", ""
	if _, err := d.PrepareBuilder(context.Background(), h, BuilderFix{Tools: true}, checkout, io.Discard, nil); err == nil || !strings.Contains(err.Error(), "the fleet installs only go, node, and npm") || install != "" {
		t.Errorf("err = %v, install ran = %v", err, install != "")
	}
}

func TestRemoteBuildScripts_UseTheFleetsTools(t *testing.T) {
	stamp := checkoutStamp{Commit: "0123456789abcdef", DesktopVersion: "9.9.9"}
	win, _ := remoteBuildScript(BuildPlan{Component: ComponentDesktop, GOOS: "windows", GOARCH: "amd64"}, defaultBuildDir, stamp)
	if !strings.Contains(win, psFreshPath) {
		t.Error("a Windows build must read PATH again: its tools may have been installed since the session's PATH was set")
	}
	linux, _ := remoteBuildScript(BuildPlan{Component: ComponentServer, GOOS: "linux", GOARCH: "arm64"}, defaultBuildDir, stamp)
	if !strings.Contains(linux, ".ion/fleet-build/tools/go/bin") {
		t.Error("a POSIX build must find the Go and Node the fleet installed")
	}
}

// A failed setup says the error its script printed, not only that it exited.
func TestPrepareBuilder_SaysWhyTheSetupFailed(t *testing.T) {
	onMac(t)
	h := Host{Name: "win", SSH: "win", Kind: KindDesktop}
	f, d := builderFixture(t, Config{Hosts: []Host{h}}, map[string]string{"win": "go\n"})
	f.platform["win"] = "Windows arm64"
	base := f.runner.answer
	f.runner.answer = func(host Host, script, stdin string) ([]byte, []byte, error) {
		if strings.Contains(script, `-File .\make.ps1 setup`) {
			return []byte("16:42:18      target architecture: x64 (GOARCH=amd64)\r\n16:42:18  ERROR  make setup failed: Security error.\r\n"), []byte("make.ps1 setup exited 1\n"), errors.New("exit status 1")
		}
		return base(host, script, stdin)
	}
	_, err := d.PrepareBuilder(context.Background(), h, BuilderFix{Tools: true}, checkoutWithVersions(t), io.Discard, nil)
	if err == nil || err.Error() != "installing the build tools on win failed: make setup failed: Security error." {
		t.Fatalf("err = %v", err)
	}
	if got := scriptFailure([]byte("building\n"), []byte("first\nmake.ps1 installer exited 1\n")); got != "make.ps1 installer exited 1" {
		t.Errorf("with no error line printed, the last line of stderr is the reason: %q", got)
	}
	if got := scriptFailure(nil, nil); got != "" {
		t.Errorf("nothing printed is no reason: %q", got)
	}
}
