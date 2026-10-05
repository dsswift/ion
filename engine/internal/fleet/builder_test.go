package fleet

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// builderFixture is a deploy fixture whose hosts answer a tools check and a
// build, for builds that happen on a host.
func builderFixture(t *testing.T, cfg Config, lacking map[string]string) (*deployFixture, *Deployer) {
	f, d := newDeployFixture(t, cfg)
	d.Artifacts.ArtifactsDir = t.TempDir()
	base := f.runner.answer
	f.runner.answer = func(h Host, script, stdin string) ([]byte, []byte, error) {
		switch {
		case strings.Contains(script, "Get-Command $t") || strings.Contains(script, "command -v $t"):
			if !strings.Contains(script, psDefenderScans) && strings.Contains(script, "Get-Command") {
				return nil, nil, errors.New("a Windows builder must be checked for Defender")
			}
			return []byte(lacking[h.Name]), nil, nil
		case strings.Contains(script, "make.ps1 installer -Arch arm64"):
			return []byte("building\r\nARTIFACT=desktop/release/Ion-Setup-9.9.9-arm64.exe\r\n"), nil, nil
		case strings.Contains(script, "package-studio-server.sh linux arm64"):
			return []byte("ARTIFACT=build/deploy/ion-studio-server-linux-arm64.tar.gz\n"), nil, nil
		case strings.Contains(script, psInstalledDesktop):
			return []byte("9.9.9|C:\\Program Files\\Ion\n"), nil, nil
		case strings.Contains(script, psIsAdmin):
			return []byte("yes\n"), nil, nil
		case strings.Contains(script, psDesktopState):
			return []byte("absent\n"), nil, nil
		}
		return base(h, script, stdin)
	}
	exec := d.Artifacts.Exec
	d.Artifacts.Exec = func(ctx context.Context, spec ExecSpec) error {
		switch {
		case spec.Name == "git" && spec.Args[0] == "ls-files":
			if strings.Join(spec.Args, " ") != "ls-files -z --cached --others --exclude-standard -- "+strings.Join(buildRoots, " ") {
				return errors.New("unexpected ls-files " + strings.Join(spec.Args, " "))
			}
			_, err := io.WriteString(spec.Stdout, "engine/go.mod\x00desktop/package.json\x00scripts/gone.sh\x00")
			return err
		case spec.Name == "git" && spec.Args[0] == "rev-parse":
			_, err := io.WriteString(spec.Stdout, "0123456789abcdef\n")
			return err
		case spec.Name == "git" && spec.Args[0] == "status":
			_, err := io.WriteString(spec.Stdout, " M engine/go.mod\n")
			return err
		case spec.Name == "git" && spec.Args[0] == "describe":
			_, err := io.WriteString(spec.Stdout, "engine-v1.2.3-4-g0123456-dirty\n")
			return err
		case spec.Name == "node" && spec.Args[0] == "desktop/scripts/desktop-version.js":
			_, err := io.WriteString(spec.Stdout, "9.9.9\n")
			return err
		}
		return exec(ctx, spec)
	}
	return f, d
}

func TestPlanBuilds_HereWhenItCanElseTheFirstHostWithTheTools(t *testing.T) {
	onMac(t)
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{
		{Name: "win1", SSH: "win1", Kind: KindDesktop},
		{Name: "win2", SSH: "win2", Kind: KindDesktop},
		{Name: "mac", SSH: "mac", Kind: KindDesktop},
		{Name: "pi1", SSH: "pi1", Kind: KindServer},
		{Name: "pi2", SSH: "pi2", Kind: KindServer},
		{Name: "intel", SSH: "intel", Kind: KindServer},
	}}
	f, d := builderFixture(t, cfg, map[string]string{"win1": "node\n"})
	f.platform["win1"], f.platform["win2"] = "Windows arm64", "Windows arm64"
	f.platform["mac"] = "Darwin arm64"
	f.platform["pi1"], f.platform["pi2"] = "Linux aarch64", "Linux aarch64"
	f.platform["intel"] = "Darwin x86_64"
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	builders := map[string]string{}
	for _, b := range p.Builds {
		builders[b.Key] = "here"
		if b.Builder != nil {
			builders[b.Key] = b.Builder.Name
		}
	}
	want := map[string]string{
		"desktop/windows/arm64": "win2", // win1 lacks node
		"desktop/darwin/arm64":  "here",
		"server/linux/arm64":    "pi1",
		"server/darwin/amd64":   "here", // any Mac builds either CPU's bundle
	}
	for k, v := range want {
		if builders[k] != v {
			t.Errorf("%s builds on %q, want %q (all: %v)", k, builders[k], v, builders)
		}
	}
	plan := strings.Join(p.PlanLines(), "\n")
	if !strings.Contains(plan, "the Windows desktop for arm64 builds once on win2 (this checkout is shipped there, and the result fetched back), for win1, win2") {
		t.Errorf("plan:\n%s", plan)
	}
}

// A build folder Defender scans stops the host building; the host is not
// deployed, and the plan names the command that fixes it.
func TestPlanBuilds_RefusesABuildFolderDefenderScans(t *testing.T) {
	onMac(t)
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{{Name: "win", SSH: "win", Kind: KindDesktop}}}
	f, d := builderFixture(t, cfg, map[string]string{"win": "defender:C:\\Users\\Some User\\.ion\\fleet-build\\ion\\\r\n"})
	f.platform["win"] = "Windows arm64"
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(p.Targets[0].Refusal, "nothing can build the Windows desktop for arm64") || !strings.Contains(p.Targets[0].Refusal, "which Microsoft Defender scans") {
		t.Fatalf("refusal = %q", p.Targets[0].Refusal)
	}
	candidates := p.Builds[0].Candidates
	if len(candidates) != 2 || candidates[0].Problems[0].Code != ProblemWrongPlatform || candidates[1].Host != "win" {
		t.Fatalf("candidates = %+v", candidates)
	}
	problem := candidates[1].Problems[0]
	if problem.Code != ProblemDefender || !problem.Fixable || problem.Dir != `C:\Users\Some User\.ion\fleet-build\ion\` {
		t.Errorf("problem = %+v", problem)
	}
	plan := strings.Join(p.PlanLines(), "\n")
	for _, want := range []string{"Not deployed:", "win: nothing can build the Windows desktop for arm64", "`ion fleet builder win --exclude-build-dir`", "--release-for win"} {
		if !strings.Contains(plan, want) {
			t.Errorf("plan lacks %q:\n%s", want, plan)
		}
	}
	if got := psBuildDir(`C:\dev\ion-fleet`); got != `'C:\dev\ion-fleet'` {
		t.Errorf("an absolute Windows folder = %s", got)
	}
	if got := psBuildDir(defaultBuildDir); got != `(Join-Path $env:USERPROFILE '.ion\fleet-build\ion')` {
		t.Errorf("a folder under home = %s", got)
	}
}

// Missing tools stop a host building. On Windows winget installs them, so the
// problem is one the fleet can fix; without winget it is not.
func TestPlanBuilds_NothingCanBuild(t *testing.T) {
	onMac(t)
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{{Name: "win", SSH: "win", Kind: KindDesktop}, {Name: "bare", SSH: "bare", Kind: KindDesktop}}}
	f, d := builderFixture(t, cfg, map[string]string{"win": "go\nnode\n", "bare": "npm\nnowinget\n"})
	f.platform["win"], f.platform["bare"] = "Windows arm64", "Windows arm64"
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range p.Targets {
		if !strings.Contains(target.Refusal, "win lacks go, node") || !strings.Contains(target.Refusal, "bare lacks npm") {
			t.Errorf("%s refusal = %q", target.Host.Name, target.Refusal)
		}
	}
	win, bare := p.Builds[0].Candidates[1].Problems[0], p.Builds[0].Candidates[2].Problems[0]
	if win.Code != ProblemMissingTools || !win.Fixable || strings.Join(win.Tools, ",") != "go,node" {
		t.Errorf("win = %+v", win)
	}
	if bare.Fixable || strings.Join(bare.Tools, ",") != "npm" {
		t.Errorf("a host with no winget cannot be fixed from here: %+v", bare)
	}
	if plan := strings.Join(p.PlanLines(), "\n"); !strings.Contains(plan, "`ion fleet builder win --install-tools` installs them") || strings.Contains(plan, "ion fleet builder bare") {
		t.Errorf("plan:\n%s", plan)
	}
}

// When this machine is the right platform but lacks a tool, a host of that
// platform builds instead.
func TestPlanBuilds_AHostBuildsWhenThisMachineLacksATool(t *testing.T) {
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{{Name: "mac", SSH: "mac", Kind: KindServer}}}
	f, d := builderFixture(t, cfg, nil)
	f.platform["mac"] = "Darwin arm64"
	pretendLocal(t, Platform{GOOS: "darwin", GOARCH: "arm64"}, []string{"npm"})
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	if b := p.Builds[0]; b.Builder == nil || b.Builder.Name != "mac" || b.Refusal != "" || p.Targets[0].Refusal != "" {
		t.Fatalf("build = %+v", b)
	}
}

// A host that is not a target builds when no target can: it only builds, and
// installs nothing.
func TestPlanBuilds_AnyHostOfThePlatformBuilds(t *testing.T) {
	onMac(t)
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{
		{Name: "win1", SSH: "win1", Kind: KindDesktop},
		{Name: "spare", SSH: "spare", Kind: KindDesktop},
		{Name: "intel", SSH: "intel", Kind: KindDesktop},
	}}
	f, d := builderFixture(t, cfg, map[string]string{"win1": "go\n", "intel": ""})
	f.platform["win1"], f.platform["spare"], f.platform["intel"] = "Windows arm64", "Windows arm64", "Windows arm64"
	report := func(arch string) *studiostatus.Report {
		return &studiostatus.Report{SchemaVersion: 1, Kind: studiostatus.KindDesktop, Platform: "win32", Arch: arch}
	}
	known := []HostStatus{{Host: cfg.Hosts[0], Report: report("arm64")}, {Host: cfg.Hosts[1], Report: report("arm64")}, {Host: cfg.Hosts[2], Report: report("x64")}}
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts[:1], Source: SourceDev, Checkout: cfg.Checkout, Known: known})
	if err != nil {
		t.Fatal(err)
	}
	if b := p.Builds[0]; b.Builder == nil || b.Builder.Name != "spare" || p.Targets[0].Refusal != "" {
		t.Fatalf("build = %+v, target = %+v", b, p.Targets[0])
	}
	if len(f.scriptsFor("intel")) != 0 {
		t.Error("a host of another CPU must not be asked to build")
	}
	if plan := strings.Join(p.PlanLines(), "\n"); !strings.Contains(plan, "builds once on spare") {
		t.Errorf("plan:\n%s", plan)
	}
}

// The first Windows host builds; the installer comes back here once and
// goes to every Windows host from here.
func TestDeploy_BuildsOnceOnAHostAndInstallsEverywhere(t *testing.T) {
	onMac(t)
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{
		{Name: "win1", SSH: "win1", Kind: KindDesktop},
		{Name: "win2", SSH: "win2", Kind: KindDesktop},
	}}
	f, d := builderFixture(t, cfg, nil)
	f.platform["win1"], f.platform["win2"] = "Windows arm64", "Windows arm64"
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout, Install: InstallOptions{QuitIon: true}})
	if err != nil {
		t.Fatal(err)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		if !r.OK {
			t.Errorf("%s: %s", r.Host, r.Error)
		}
	}
	win1, win2 := strings.Join(f.scriptsFor("win1"), "\n"), strings.Join(f.scriptsFor("win2"), "\n")
	if strings.Count(win1, `-File .\make.ps1 installer`) != 1 || strings.Contains(win2, "make.ps1") {
		t.Errorf("one build, on win1 only")
	}
	if !strings.Contains(win1, copyToScript) || !strings.Contains(win1, "-> .ion/fleet-build/src.tgz") || strings.Contains(win2, "src.tgz") {
		t.Errorf("the checkout ships to the builder only:\n%s", win1)
	}
	fetched := filepath.Join(d.Artifacts.ArtifactsDir, "desktop-windows-arm64", "Ion-Setup-9.9.9-arm64.exe")
	if !strings.Contains(win1, copyFromScript+defaultBuildDir+"/desktop/release/Ion-Setup-9.9.9-arm64.exe -> "+fetched) {
		t.Errorf("the installer must come back to %s:\n%s", fetched, win1)
	}
	for name, scripts := range map[string]string{"win1": win1, "win2": win2} {
		if !strings.Contains(scripts, copyToScript+fetched+" -> .ion/fleet-incoming/Ion-Setup-9.9.9-arm64.exe") {
			t.Errorf("%s must install the fetched build", name)
		}
	}
	if d.archivePath != "" {
		t.Error("the checkout archive must be removed after the deploy")
	}
}

func TestRemoteBuildScripts_VersionTheShippedTree(t *testing.T) {
	stamp := checkoutStamp{Commit: "0123456789abcdef", Dirty: true, DesktopVersion: "9.9.9-dev.0123", EngineVersion: "engine-v1.2.3-dirty"}
	win, isWin := remoteBuildScript(BuildPlan{Component: ComponentDesktop, GOOS: "windows", GOARCH: "amd64"}, `C:\dev\ion-fleet`, stamp)
	if !isWin || !strings.HasPrefix(win, "$d = 'C:\\dev\\ion-fleet'\n") || !strings.Contains(win, "$env:ION_DESKTOP_VERSION = '9.9.9-dev.0123'") || !strings.Contains(win, "make.ps1 installer -Arch x64") || !strings.Contains(win, "Ion-Setup-*-x64.exe") {
		t.Errorf("windows:\n%s", win)
	}
	server, _ := remoteBuildScript(BuildPlan{Component: ComponentServer, GOOS: "linux", GOARCH: "arm64"}, defaultBuildDir, stamp)
	if !strings.HasPrefix(server, `exec "${SHELL:-/bin/sh}" -lc `) || !strings.Contains(server, `D="$HOME/"'\''.ion/fleet-build/ion'\''`) || !strings.Contains(server, "export ION_BUILD_COMMIT='\\''012345678'\\''") || !strings.Contains(server, "export ION_BUILD_DIRTY='\\''1'\\''") || !strings.Contains(server, "npm ci --no-audit") {
		t.Errorf("server:\n%s", server)
	}
	mac, _ := remoteBuildScript(BuildPlan{Component: ComponentDesktop, GOOS: "darwin", GOARCH: "arm64"}, "/srv/ion-build", stamp)
	if !strings.Contains(mac, `D='\''/srv/ion-build'\''`) || !strings.Contains(mac, "export ION_ENGINE_VERSION='\\''engine-v1.2.3-dirty'\\''") || !strings.Contains(mac, "make desktop-pkg") || !strings.Contains(mac, "ARCHS=") {
		t.Errorf("mac:\n%s", mac)
	}
}

func TestWriteArchive_TrackedFilesAndTheStamp(t *testing.T) {
	checkout := t.TempDir()
	for _, rel := range []string{"engine/go.mod", "desktop/package.json"} {
		if err := writeEmpty(filepath.Join(checkout, rel)); err != nil {
			t.Fatal(err)
		}
	}
	_, d := builderFixture(t, Config{}, nil)
	stamp, err := d.Artifacts.readStamp(context.Background(), checkout)
	if err != nil || stamp.Commit != "0123456789abcdef" || !stamp.Dirty || stamp.DirtyFiles[0] != "engine/go.mod" || stamp.DesktopVersion != "9.9.9" {
		t.Fatalf("stamp = %+v err = %v", stamp, err)
	}
	var buf bytes.Buffer
	n, err := d.Artifacts.writeArchive(context.Background(), checkout, stamp, &buf)
	if err != nil || n != 2 {
		t.Fatalf("n = %d err = %v", n, err)
	}
	gz, err := gzip.NewReader(&buf)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	var names []string
	var written checkoutStamp
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, hdr.Name)
		if hdr.Name == ".ion-sync-stamp.json" {
			if err := json.NewDecoder(tr).Decode(&written); err != nil {
				t.Fatal(err)
			}
		}
	}
	// A tracked file deleted in the working tree is not shipped.
	if strings.Join(names, ",") != "engine/go.mod,desktop/package.json,.ion-sync-stamp.json" {
		t.Errorf("names = %v", names)
	}
	if written.Commit != stamp.Commit || written.DesktopVersion != "9.9.9" || !written.Dirty {
		t.Errorf("stamp in the archive = %+v", written)
	}
}

func TestNoBuild_UsesTheLastFetchedBuild(t *testing.T) {
	onMac(t)
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{{Name: "win", SSH: "win", Kind: KindDesktop}}}
	f, d := builderFixture(t, cfg, nil)
	f.platform["win"] = "Windows arm64"
	fetched := filepath.Join(d.Artifacts.ArtifactsDir, "desktop-windows-arm64", "Ion-Setup-9.9.9-arm64.exe")
	if err := writeEmpty(fetched); err != nil {
		t.Fatal(err)
	}
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout, NoBuild: true})
	if err != nil {
		t.Fatal(err)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil || !results[0].OK {
		t.Fatalf("%+v %v", results, err)
	}
	if all := strings.Join(f.scriptsFor("win"), "\n"); strings.Contains(all, "make.ps1") || !strings.Contains(all, copyToScript+fetched) {
		t.Errorf("--no-build installs the fetched build without building:\n%s", all)
	}
	if err := os.Remove(fetched); err != nil {
		t.Fatal(err)
	}
	if results, _ := d.Run(context.Background(), p); results[0].OK || !strings.Contains(results[0].Error, "no desktop/windows/arm64 build has been fetched yet") { //nolint:errcheck // asserted by the result
		t.Errorf("result = %+v", results[0])
	}
}
