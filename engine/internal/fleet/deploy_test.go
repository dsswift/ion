package fleet

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// deployFixture fakes every edge of a deploy: the hosts (platform, status,
// and every install step) and the checkout's builds.
type deployFixture struct {
	t        *testing.T
	platform map[string]string // host -> "Darwin x86_64"
	mu       sync.Mutex
	builds   []string
	order    []string
	running  atomic.Int32
	peak     atomic.Int32
	failHost string
	terminal []ExecSpec
	runner   *fakeRunner
}

func (f *deployFixture) answer(h Host, script, _ string) ([]byte, []byte, error) {
	switch {
	case strings.HasPrefix(script, copyToScript):
		n := f.running.Add(1)
		defer f.running.Add(-1)
		for {
			p := f.peak.Load()
			if n <= p || f.peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		f.mu.Lock()
		f.order = append(f.order, h.Name)
		f.mu.Unlock()
		if h.Name == f.failHost {
			return nil, nil, errors.New("lost connection")
		}
	case strings.Contains(script, "studio' 'status'"):
		return reportJSON(f.t, "3"), nil, nil
	case strings.HasSuffix(script, "sh -s"):
		return []byte("==> installing\n{\"ok\":true,\"version\":\"0.2.0\"}\n"), nil, nil
	case strings.Contains(script, "CFBundleShortVersionString"):
		return []byte("9.9.9\n"), nil, nil
	case strings.HasPrefix(script, "lipo"):
		return []byte("arm64\n"), nil, nil
	case script == macIonRunning:
		return []byte("no\n"), nil, nil
	}
	return nil, nil, nil
}

func (f *deployFixture) artifactExec(_ context.Context, spec ExecSpec) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case spec.Name == "go":
		return json.NewEncoder(spec.Stdout).Encode(map[string]any{"formats": []compat.Format{{ID: "conversation-file", Owner: "engine", Version: "2", Rule: compat.RuleHostStorage}}})
	case spec.Name == "node":
		return json.NewEncoder(spec.Stdout).Encode(map[string]any{"formats": []compat.Format{{ID: "transfer-archive", Owner: "server", Version: "3", Rule: compat.RuleExact}}})
	case spec.Name == "bash" && strings.Contains(spec.Args[0], "package-studio-server"):
		f.builds = append(f.builds, spec.Args[1]+"/"+spec.Args[2])
		return writeEmpty(filepath.Join(spec.Dir, spec.Args[3], "ion-studio-server-"+spec.Args[1]+"-"+spec.Args[2]+".tar.gz"))
	case spec.Name == "make":
		f.builds = append(f.builds, "desktop")
		return writeEmpty(filepath.Join(spec.Dir, "desktop", "release", "Ion-9.9.9.pkg"))
	}
	return nil
}

// terminalExec stands in for this terminal: the runs a host's sudo prompts in.
func (f *deployFixture) terminalExec(ctx context.Context, spec ExecSpec) error {
	f.mu.Lock()
	f.terminal = append(f.terminal, spec)
	f.mu.Unlock()
	host := spec.Args[len(spec.Args)-2]
	_, _, err := f.answer(Host{Name: host, SSH: host}, spec.Args[len(spec.Args)-1], "")
	return err
}

func writeEmpty(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, nil, 0o644)
}

// newDeployFixture's hosts are Apple silicon Macs, like this machine is made
// to be, so what they take builds here.
func newDeployFixture(t *testing.T, cfg Config) (*deployFixture, *Deployer) {
	onMac(t)
	f := &deployFixture{t: t, platform: map[string]string{}}
	for _, h := range cfg.Hosts {
		f.platform[h.Name] = "Darwin arm64"
	}
	f.runner = &fakeRunner{answer: f.answer, platform: func(h Host) (Platform, error) {
		if f.platform[h.Name] == "Windows arm64" {
			return Platform{GOOS: "windows", GOARCH: "arm64", LoginShell: ShellPowerShell}, nil
		}
		return parseUname([]byte(f.platform[h.Name]))
	}}
	d := &Deployer{
		Config:    cfg,
		Runner:    f.runner,
		Collector: Collector{Runner: f.runner},
		Exec:      f.terminalExec,
		Latest:    func(context.Context) (Latest, error) { return Latest{}, nil },
		Artifacts: Artifacts{Exec: f.artifactExec},
		LogDir:    t.TempDir(),
	}
	return f, d
}

// scriptsFor are the scripts the fake ran on one host.
func (f *deployFixture) scriptsFor(host string) []string {
	f.runner.mu.Lock()
	defer f.runner.mu.Unlock()
	var out []string
	for i, s := range f.runner.scripts {
		if f.runner.hosts[i] == host {
			out = append(out, s)
		}
	}
	return out
}

func serverHosts(names ...string) []Host {
	var out []Host
	for _, n := range names {
		out = append(out, Host{Name: n, SSH: n + ".example.org", Kind: KindServer})
	}
	return out
}

func TestDeploy_BuildsOncePerPlatformAndRunsInParallel(t *testing.T) {
	cfg := Config{Checkout: fakeCheckout(t), Concurrency: 2, Hosts: serverHosts("a", "b", "c", "d", "e")}
	f, d := builderFixture(t, cfg, nil)
	f.platform["e"] = "Linux aarch64"
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(f.builds, ",") != "darwin/arm64" {
		t.Errorf("builds here = %v, want the macOS bundle once", f.builds)
	}
	if n := strings.Count(strings.Join(f.scriptsFor("e"), "\n"), "package-studio-server.sh linux arm64"); n != 1 {
		t.Errorf("the Linux bundle builds once, on the Linux host: %d", n)
	}
	if f.peak.Load() > 2 {
		t.Errorf("peak concurrency = %d, want at most 2", f.peak.Load())
	}
	for _, r := range results {
		if !r.OK || r.Receipt == nil || r.Receipt.Version != "0.2.0" || r.After == nil {
			t.Errorf("result = %+v", r)
		}
	}
	scripts := strings.Join(f.scriptsFor("e"), "\n")
	if !strings.Contains(scripts, copyToScript+filepath.Join(d.Artifacts.ArtifactsDir, "server-linux-arm64", "ion-studio-server-linux-arm64.tar.gz")+" -> .ion/studio-server/incoming/") {
		t.Errorf("the linux host must get the bundle it built:\n%s", scripts)
	}
}

func TestDeploy_SudoHostsRunLastOnTheTerminal(t *testing.T) {
	cfg := Config{Hosts: []Host{
		{Name: "m1", SSH: "m1", Kind: KindDesktop, AskSudo: true},
		{Name: "m2", SSH: "m2", Kind: KindDesktop},
		{Name: "m3", SSH: "m3", Kind: KindDesktop},
	}}
	cfg.Checkout = fakeCheckout(t)
	f, d := newDeployFixture(t, cfg)
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout, Terminal: true, Install: InstallOptions{QuitIon: true}})
	if err != nil {
		t.Fatal(err)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.order) != 3 || f.order[2] != "m1" {
		t.Fatalf("order = %v, want the sudo host last", f.order)
	}
	if strings.Join(f.builds, ",") != "desktop" {
		t.Errorf("builds = %v, want one desktop package", f.builds)
	}
	for _, r := range results {
		if !r.OK {
			t.Errorf("%s: %s", r.Host, r.Error)
		}
	}
	// Only the sudo host's installer runs on the terminal, and without -n so
	// sudo can ask.
	if len(f.terminal) != 1 || f.terminal[0].Args[len(f.terminal[0].Args)-2] != "m1" || !strings.Contains(f.terminal[0].Args[len(f.terminal[0].Args)-1], "sudo -p 'Password for %u on m1 (ion fleet install): ' installer -pkg") || !strings.Contains(f.terminal[0].Banner, "on m1") {
		t.Errorf("terminal runs = %+v", f.terminal)
	}
	if strings.Contains(strings.Join(f.scriptsFor("m1"), "\n"), "sudo -n true") {
		t.Error("an askSudo host must not need passwordless sudo")
	}
	if !strings.Contains(strings.Join(f.scriptsFor("m2"), "\n"), "sudo -n installer -pkg") {
		t.Error("a passwordless host installs with sudo -n")
	}
}

func TestDeploy_PasswordSudoWithoutAskSudoNamesTheFleetRemedy(t *testing.T) {
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{{Name: "m", SSH: "m", Kind: KindDesktop}}}
	f, d := newDeployFixture(t, cfg)
	answer := f.runner.answer
	f.runner.answer = func(h Host, script, stdin string) ([]byte, []byte, error) {
		if script == "sudo -n true" {
			return nil, []byte("sudo: a password is required"), errors.New("exit status 1")
		}
		return answer(h, script, stdin)
	}
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if results[0].OK || !strings.Contains(results[0].Error, `set "askSudo": true on host "m"`) {
		t.Errorf("error = %q", results[0].Error)
	}
}

func TestDeploy_RelayKeyTravelsOnStdinOnly(t *testing.T) {
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{{Name: "g", SSH: "g", Kind: KindServer, Profile: "home"}},
		Profiles: map[string]Profile{"home": {Relay: "wss://relay.example.org", RelayKeyCommand: "echo the-secret", Args: []string{"--label", "devbox"}}}}
	f, d := newDeployFixture(t, cfg)
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil || !results[0].OK {
		t.Fatalf("%+v %v", results, err)
	}
	scripts := strings.Join(f.scriptsFor("g"), "\n")
	if strings.Contains(scripts, "the-secret") || !strings.Contains(scripts, "'studio' 'relay' 'set' 'wss://relay.example.org' '--key-stdin'") {
		t.Errorf("scripts:\n%s", scripts)
	}
	if !strings.Contains(scripts, "ION_STUDIO_INSTALL_ARGS='--label devbox'") {
		t.Errorf("the profile's args must reach the installer:\n%s", scripts)
	}
	f.runner.mu.Lock()
	defer f.runner.mu.Unlock()
	if !contains(f.runner.stdins, "the-secret\n") {
		t.Errorf("the key must arrive on stdin: %q", f.runner.stdins)
	}
}

func TestDeploy_OneFailureDoesNotStopTheOthers(t *testing.T) {
	cfg := Config{Checkout: fakeCheckout(t), Hosts: serverHosts("a", "b", "c")}
	f, d := newDeployFixture(t, cfg)
	f.failHost = "b"
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].OK || results[1].OK || !results[2].OK {
		t.Errorf("results = %+v", results)
	}
	if !strings.Contains(results[1].Error, "copy to b failed: lost connection; see ") {
		t.Errorf("the failure must carry its reason: %q", results[1].Error)
	}
	if data, err := os.ReadFile(results[1].LogPath); err != nil || !strings.Contains(string(data), "==> ship") {
		t.Errorf("the failed host's log must hold its steps: %q %v", data, err)
	}
}

func TestDeploy_RefusesWhatCannotWork(t *testing.T) {
	cfg := Config{Hosts: serverHosts("a")}
	f, d := newDeployFixture(t, cfg)
	if _, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev}); err == nil || !strings.Contains(err.Error(), "--source PATH") {
		t.Errorf("a dev deploy without a checkout must say how to give one: %v", err)
	}
	refusal := func(req Request) string {
		t.Helper()
		p, err := d.Prepare(context.Background(), req)
		if err != nil {
			t.Fatalf("a host that cannot be deployed is a refused target, not an error: %v", err)
		}
		return p.Targets[0].Refusal
	}
	if got := refusal(Request{Hosts: cfg.Hosts, Source: SourceRelease}); !strings.Contains(got, "no Studio Server release") {
		t.Errorf("a release deploy with nothing published must say so: %q", got)
	}
	if got := refusal(Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: t.TempDir(), Component: ComponentDesktop}); !strings.Contains(got, "it takes the server component") {
		t.Errorf("a server host must not take the desktop component: %q", got)
	}
	f.platform["a"] = "Windows arm64"
	if got := refusal(Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: t.TempDir()}); !strings.Contains(got, "no Studio Server bundle") {
		t.Errorf("a Windows host must not take a server bundle: %q", got)
	}
}

// fakeCheckout makes a directory that passes IsCheckout.
func fakeCheckout(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, rel := range checkoutMarkers {
		if err := os.MkdirAll(filepath.Join(dir, filepath.Dir(rel)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, rel), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestResolveSource(t *testing.T) {
	bench := fakeCheckout(t)
	if _, _, err := ResolveSource(SourceDev, Config{}); err == nil || !strings.Contains(err.Error(), "--source .") {
		t.Errorf("dev without a checkout must point at --source PATH: %v", err)
	}
	if kind, co, err := ResolveSource(SourceDev, Config{Checkout: bench}); err != nil || kind != SourceDev || co != bench {
		t.Errorf("dev = %s %s %v", kind, co, err)
	}
	if kind, co, err := ResolveSource(bench, Config{Checkout: "/elsewhere"}); err != nil || kind != SourceDev || co != bench {
		t.Errorf("a path overrides the fleet file's checkout: %s %s %v", kind, co, err)
	}
	t.Chdir(bench)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if kind, co, err := ResolveSource(".", Config{}); err != nil || kind != SourceDev || co != cwd {
		t.Errorf(". = %s %s %v, want %s", kind, co, err, cwd)
	}
	if kind, co, err := ResolveSource(SourceRelease, Config{}); err != nil || kind != SourceRelease || co != "" {
		t.Errorf("a release builds nothing and needs no checkout: %s %s %v", kind, co, err)
	}
	if _, _, err := ResolveSource(t.TempDir(), Config{}); err == nil || !strings.Contains(err.Error(), "not the top folder of an Ion checkout") {
		t.Errorf("a folder that is not a checkout must be refused: %v", err)
	}
	t.Setenv("HOME", filepath.Dir(bench))
	if kind, co, err := ResolveSource("~/"+filepath.Base(bench), Config{}); err != nil || kind != SourceDev || co != bench {
		t.Errorf("~ is the home folder: %s %s %v", kind, co, err)
	}
	if _, _, err := ResolveSource("", Config{}); err == nil {
		t.Error("no source must be refused")
	}
}

// A remembered checkout that was removed (a retired bench) must say the
// folder is gone, not name a marker file the operator cannot act on.
func TestIsCheckout_NamesWhatIsWrong(t *testing.T) {
	gone := filepath.Join(t.TempDir(), "ion-removed-bench")
	if err := IsCheckout(gone); err == nil || !strings.Contains(err.Error(), "no longer exists") || strings.Contains(err.Error(), "scripts/") {
		t.Errorf("a missing folder: %v", err)
	}
	file := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := IsCheckout(file); err == nil || !strings.Contains(err.Error(), "is a file") {
		t.Errorf("a file: %v", err)
	}
	inside := filepath.Join(fakeCheckout(t), "engine")
	if err := IsCheckout(inside); err == nil || !strings.Contains(err.Error(), "not a folder inside it") {
		t.Errorf("a folder inside a checkout: %v", err)
	}
	if err := IsCheckout(fakeCheckout(t)); err != nil {
		t.Errorf("a checkout: %v", err)
	}
}

func TestDeploy_BuildsAndShipsFromTheRequestedCheckout(t *testing.T) {
	cfg := Config{Checkout: "/fleet-file-checkout", Hosts: serverHosts("a")}
	f, d := newDeployFixture(t, cfg)
	bench := fakeCheckout(t)
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: bench})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Run(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(f.scriptsFor("a"), "\n"), copyToScript+filepath.Join(bench, "build", "deploy")+string(filepath.Separator)) || !strings.Contains(strings.Join(p.PlanLines(), "\n"), "dev build of "+bench) {
		t.Errorf("scripts = %v, plan = %v", f.scriptsFor("a"), p.PlanLines())
	}
}

func TestLastReceipt(t *testing.T) {
	if r := lastReceipt([]byte("==> step\n{\"ok\":true,\"version\":\"0.2\"}\n")); r["ok"] != true {
		t.Errorf("server receipt = %v", r)
	}
	if r := lastReceipt([]byte("no receipt here\n")); r != nil {
		t.Errorf("no receipt = %v", r)
	}
}

func TestComputePreflight(t *testing.T) {
	transfer := func(v string) compat.Format {
		return compat.Format{ID: "transfer-archive", Owner: "server", Version: v, Rule: compat.RuleExact}
	}
	wire := func(v string) compat.Format {
		return compat.Format{ID: "studio-wire", Owner: "server", Version: v, Rule: compat.RuleAcceptsPrevious}
	}
	store := func(v string) compat.Format {
		return compat.Format{ID: "conversation-file", Owner: "engine", Version: v, Rule: compat.RuleHostStorage}
	}
	statuses := []HostStatus{
		hostWith("mac", true, transfer("3"), wire("2"), store("2")),
		hostWith("devbox", false, transfer("3"), wire("2"), store("2")),
		hostWith("pi", false, transfer("2"), wire("2"), store("2")),
	}
	// devbox moves to transfer 4, studio wire 4, and a lower stored format; pi to transfer 3.
	pf := ComputePreflight(statuses, map[string][]compat.Format{
		"devbox": {transfer("4"), wire("4"), store("1")},
		"pi":     {transfer("3"), wire("2"), store("2")},
		"other":  nil,
	})
	has := func(format FormatRef, from, to string, broken bool) bool {
		for _, c := range pf.Changes {
			if c.Format == format && c.From == from && c.To == to && c.Broken == broken {
				return true
			}
		}
		return false
	}
	if !has(TransferFormat, "mac", "devbox", true) || !has(TransferFormat, "mac", "pi", false) {
		t.Errorf("transfer changes = %+v", pf.Changes)
	}
	if !has(StudioWireFormat, "mac", "devbox", true) {
		t.Errorf("the mac's desktop drops out of devbox's studio wire window: %+v", pf.Changes)
	}
	if len(pf.Downgrades) != 1 || pf.Downgrades[0].Host != "devbox" || !pf.Blocks() {
		t.Errorf("downgrades = %+v", pf.Downgrades)
	}
	unknown := ComputePreflight(statuses, map[string][]compat.Format{"pi": nil})
	if len(unknown.Unknown) != 1 || unknown.Unknown[0] != "pi" || len(unknown.Changes) != 0 {
		t.Errorf("unknown = %+v", unknown)
	}
	legacy := ComputePreflight([]HostStatus{{Host: Host{Name: "old"}, Report: &studiostatus.Report{}}}, map[string][]compat.Format{"old": {transfer("3")}})
	if len(legacy.Unreadable) != 1 || !strings.Contains(strings.Join(legacy.Lines(), "\n"), "old runs an Ion too old to report its formats") {
		t.Errorf("a target without formats must be named, not counted as unchanged: %+v", legacy)
	}
	if lines := (Preflight{}).Lines(); len(lines) != 0 {
		t.Errorf("nothing to compare and nothing changed says nothing: %v", lines)
	}
	if lines := (Preflight{Compared: 2}).Lines(); len(lines) != 1 || !strings.Contains(lines[0], "unchanged") {
		t.Errorf("an unchanged fleet must say so plainly: %v", lines)
	}
	if lines := strings.Join(pf.Lines(), "\n"); !strings.Contains(lines, "mac can no longer send conversations to devbox") || !strings.Contains(lines, "BLOCKED: this would move devbox's stored conversation-file back from version 2 to 1") {
		t.Errorf("lines =\n%s", lines)
	}
}

func TestComputePreflight_NamesOnlyTargetsItCannotRead(t *testing.T) {
	transfer := compat.Format{ID: "transfer-archive", Owner: "server", Version: "3", Rule: compat.RuleExact}
	down := HostStatus{Host: Host{Name: "win"}, Via: ViaNone, Error: "ssh: unreachable"}
	statuses := []HostStatus{hostWith("mac", true, transfer), hostWith("devbox", false, transfer), down}

	pf := ComputePreflight(statuses, map[string][]compat.Format{"devbox": {transfer}})
	if lines := strings.Join(pf.Lines(), "\n"); len(pf.Unreadable) != 0 || strings.Contains(lines, "win") {
		t.Errorf("a down host outside the deploy must not be named:\n%s", lines)
	}

	pf = ComputePreflight(statuses, map[string][]compat.Format{"win": {transfer}})
	if lines := strings.Join(pf.Lines(), "\n"); !strings.Contains(lines, "win isn't answering (ssh: unreachable), so the deploy will probably fail there") || strings.Contains(lines, "too old") {
		t.Errorf("a down target must say it is not answering, not that it is old:\n%s", lines)
	}
}

func TestPrepare_ReadsOnlyHostsItDoesNotKnow(t *testing.T) {
	cfg := Config{Hosts: serverHosts("a", "b", "c")}
	f, d := newDeployFixture(t, cfg)
	reads := func(host string) int {
		return strings.Count(strings.Join(f.scriptsFor(host), "\n"), "studio' 'status'")
	}
	known := []HostStatus{{Host: cfg.Hosts[0], Via: ViaSSH, Report: &studiostatus.Report{}}, {Host: cfg.Hosts[1], Via: ViaNone, Error: "down"}}
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts[:1], Source: SourceDev, Checkout: fakeCheckout(t), Known: known})
	if err != nil {
		t.Fatal(err)
	}
	if reads("a") != 0 || reads("b") != 0 || reads("c") != 1 {
		t.Errorf("reads a=%d b=%d c=%d, want only the unknown host c read", reads("a"), reads("b"), reads("c"))
	}
	if len(p.Statuses) != 3 || p.Statuses[1].Error != "down" || p.Statuses[2].Report == nil {
		t.Errorf("statuses = %+v", p.Statuses)
	}
	if _, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts[:1], Source: SourceDev, Checkout: fakeCheckout(t), Known: p.Statuses}); err != nil {
		t.Fatal(err)
	}
	if reads("c") != 1 {
		t.Errorf("a fully known fleet must read no host: c read %d times", reads("c"))
	}
}

func TestVerifyDigest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Ion.pkg")
	if err := os.WriteFile(path, []byte("package"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("package"))
	if err := verifyDigest(path, "sha256:"+hex.EncodeToString(sum[:])); err != nil {
		t.Errorf("a matching digest must pass: %v", err)
	}
	if err := verifyDigest(path, "sha256:00"); err == nil {
		t.Error("a mismatch must fail")
	}
	if err := verifyDigest(path, ""); err == nil {
		t.Error("a release without a digest must be refused")
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestPlanLines_SayWhetherIonQuits(t *testing.T) {
	desk := Target{Host: Host{Name: "m", Kind: KindDesktop}, Component: ComponentDesktop, GOOS: "darwin", GOARCH: "arm64"}
	quits := (&Prepared{Request: Request{Source: SourceRelease, Install: InstallOptions{QuitIon: true}}, Targets: []Target{desk}}).PlanLines()
	stays := (&Prepared{Request: Request{Source: SourceRelease}, Targets: []Target{desk}}).PlanLines()
	if !strings.Contains(quits[1], "Ion there quits") || !strings.Contains(stays[1], "--quit-ion quits it") {
		t.Errorf("quits = %q, stays = %q", quits[1], stays[1])
	}
}
