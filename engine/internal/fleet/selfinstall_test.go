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
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// fakeLink is a host's Studio connection as a self-install uses it.
type fakeLink struct {
	host *fakeSelfHost
}

// fakeSelfHost is a host that installs on itself.
type fakeSelfHost struct {
	mu        sync.Mutex
	actions   []string
	artifacts []string
	// refuse answers an action with a refusal; restartErr ends the wait
	// for the host to go down.
	refuse     *studioclient.ActionError
	restartErr error
	// down is how many opens fail now; an install sets it to downFor and
	// the version to next, as a host going down and coming back updated.
	down    int
	downFor int
	next    string
	version string
	desktop string
	opens   int
	// predatesSelfInstall is a host whose server does not say whether it
	// can install on itself; cannotNow is one that says it cannot, and why.
	predatesSelfInstall bool
	cannotNow           string
}

func (h *fakeSelfHost) open(context.Context, Host) (HostLink, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.opens++
	if h.down > 0 {
		h.down--
		return nil, errors.New("connection refused")
	}
	return &fakeLink{host: h}, nil
}

func (l *fakeLink) Action(_ context.Context, action string, _ ...any) (json.RawMessage, error) {
	h := l.host
	h.mu.Lock()
	defer h.mu.Unlock()
	h.actions = append(h.actions, action)
	if action == "environment.server.info" {
		info := map[string]any{"serverVersion": h.version}
		if !h.predatesSelfInstall {
			info["hostInstall"] = map[string]any{"available": h.cannotNow == "", "code": h.cannotNow}
		}
		if h.desktop != "" {
			info["hostApp"] = map[string]any{"name": "desktop", "version": h.desktop}
		}
		return json.Marshal(info)
	}
	if h.refuse != nil {
		return nil, h.refuse
	}
	h.installed()
	return json.RawMessage(`{"scheduled":true}`), nil
}

func (l *fakeLink) InstallArtifact(_ context.Context, path string) error {
	l.host.mu.Lock()
	defer l.host.mu.Unlock()
	l.host.artifacts = append(l.host.artifacts, filepath.Base(path))
	l.host.installed()
	return nil
}

// installed is the host going down for an install. The lock is held.
func (h *fakeSelfHost) installed() {
	h.down = h.downFor
	if h.next != "" {
		h.version = h.next
	}
}

func (l *fakeLink) AwaitRestart(context.Context) error { return l.host.restartErr }
func (l *fakeLink) Close()                             {}

func fastSelfInstall(t *testing.T) {
	t.Helper()
	prevPoll, prevWithin := hostReturnPoll, hostReturnsWithin
	hostReturnPoll, hostReturnsWithin = time.Millisecond, 2*time.Second
	t.Cleanup(func() { hostReturnPoll, hostReturnsWithin = prevPoll, prevWithin })
}

var pairedEntry = &Entry{Kind: EntryPaired, Label: "x", CredentialRef: "env-x", EnvironmentID: "env-x"}

// A host restarts itself when it answers on its Studio connection, and is
// restarted over SSH when it does not or when asked.
func TestRestart_SelfThenSSH(t *testing.T) {
	runner := &fakeRunner{answer: func(Host, string, string) ([]byte, []byte, error) { return nil, nil, nil }}
	host := &fakeSelfHost{}
	h := Host{Name: "s", SSH: "s", Kind: KindServer, Entry: pairedEntry}

	if err := (Ops{Runner: runner, Open: host.open}).Restart(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	if strings.Join(host.actions, ",") != "environment.server.restart" || len(runner.scripts) != 0 {
		t.Errorf("self restart: actions %v, ssh scripts %v", host.actions, runner.scripts)
	}

	// The host refuses (system services need a sudo password): SSH does it.
	host.refuse = &studioclient.ActionError{Action: "environment.server.restart", Code: "needs_sudo", Message: "needs sudo", Refused: true}
	if err := (Ops{Runner: runner, Open: host.open}).Restart(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	if len(runner.scripts) != 1 || !strings.Contains(runner.scripts[0], `'studio' 'restart'`) {
		t.Errorf("ssh fallback scripts = %v", runner.scripts)
	}

	// Asked for SSH: the host is never asked.
	host.refuse, host.actions = nil, nil
	if err := (Ops{Runner: runner, Open: host.open, ForceSSH: true}).Restart(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	if len(host.actions) != 0 || len(runner.scripts) != 2 {
		t.Errorf("forced ssh: actions %v, scripts %d", host.actions, len(runner.scripts))
	}

	// No SSH target: the host's own refusal is the answer.
	host.refuse = &studioclient.ActionError{Action: "environment.server.restart", Code: "no_bundle", Message: "started by hand", Refused: true}
	noSSH := Host{Name: "r", Entry: pairedEntry}
	if err := (Ops{Runner: runner, Open: host.open}).Restart(context.Background(), noSSH); err == nil || !strings.Contains(err.Error(), "started by hand") {
		t.Errorf("a refusal with no ssh target = %v", err)
	}
	// Neither a pairing nor an SSH target.
	if err := (Ops{Runner: runner}).Restart(context.Background(), Host{Name: "n"}); err == nil || !strings.Contains(err.Error(), "no SSH target") {
		t.Errorf("an unreachable host = %v", err)
	}
}

// With no kind in the catalog, a restart over SSH asks the host what it runs.
func TestRestart_ReadsTheKindFromTheHost(t *testing.T) {
	report, err := json.Marshal(studiostatus.Report{SchemaVersion: 1, Kind: studiostatus.KindDesktop})
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{answer: func(_ Host, script string, _ string) ([]byte, []byte, error) {
		if strings.Contains(script, "'studio' 'status'") {
			return report, nil, nil
		}
		return nil, nil, nil
	}}
	if err := (Ops{Runner: runner}).Restart(context.Background(), Host{Name: "d", SSH: "d"}); err != nil {
		t.Fatal(err)
	}
	if last := runner.scripts[len(runner.scripts)-1]; !strings.Contains(last, "pkill -USR2") {
		t.Errorf("a desktop host restarts its app: %s", last)
	}
}

// A release deploy to a host that answers on its Studio connection is one
// command to the host: nothing is built, copied, or run over SSH.
func TestDeploy_SelfInstallRelease(t *testing.T) {
	fastSelfInstall(t)
	hosts := []Host{{Name: "a", SSH: "a.example.org", Kind: KindServer, Entry: pairedEntry}}
	cfg := Config{Hosts: hosts}
	f, d := newDeployFixture(t, cfg)
	host := &fakeSelfHost{version: "0.2.0", next: "0.3.0", downFor: 2}
	d.OpenLink = host.open
	d.Latest = func(context.Context) (Latest, error) { return Latest{Server: "0.3.0"}, nil }

	p, err := d.Prepare(context.Background(), Request{Hosts: hosts, Source: SourceRelease})
	if err != nil {
		t.Fatal(err)
	}
	if !p.Targets[0].Self {
		t.Fatalf("target = %+v, want a self-install", p.Targets[0])
	}
	if lines := strings.Join(p.PlanLines(), "\n"); !strings.Contains(lines, "the host installs it on itself") {
		t.Errorf("plan:\n%s", lines)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].OK {
		t.Fatalf("result = %+v", results[0])
	}
	if !contains(host.actions, "environment.server.update") {
		t.Errorf("actions = %v", host.actions)
	}
	for _, s := range f.scriptsFor("a") {
		if strings.Contains(s, "'studio' 'update'") || strings.HasPrefix(s, copyToScript) {
			t.Errorf("a self-install ran over ssh: %s", s)
		}
	}
}

// A dev deploy builds as usual and sends the build to the host.
func TestDeploy_SelfInstallDevSendsTheBuild(t *testing.T) {
	fastSelfInstall(t)
	hosts := []Host{{Name: "a", Kind: KindServer, Entry: pairedEntry}}
	cfg := Config{Checkout: fakeCheckout(t), Hosts: hosts}
	f, d := newDeployFixture(t, cfg)
	host := &fakeSelfHost{version: "0.4.0"}
	d.OpenLink = host.open
	// The host has no SSH target, so its platform comes from its own report.
	d.Collector = Collector{ReadStudio: func(context.Context, Host) (studioclient.Status, string, error) {
		return studioclient.Status{Info: studioclient.ServerInfo{Hostname: "a", Platform: "darwin", Arch: "arm64"}}, ViaRelay, nil
	}}

	p, err := d.Prepare(context.Background(), Request{Hosts: hosts, Source: SourceDev, Checkout: cfg.Checkout})
	if err != nil {
		t.Fatal(err)
	}
	if t0 := p.Targets[0]; !t0.Self || t0.GOOS != "darwin" || t0.GOARCH != "arm64" {
		t.Fatalf("target = %+v", t0)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].OK {
		t.Fatalf("result = %+v", results[0])
	}
	if strings.Join(f.builds, ",") != "darwin/arm64" || strings.Join(host.artifacts, ",") != "ion-studio-server-darwin-arm64.tar.gz" {
		t.Errorf("builds %v, sent %v", f.builds, host.artifacts)
	}
	if len(f.runner.scripts) != 0 {
		t.Errorf("a host with no ssh target was reached over ssh: %v", f.runner.scripts)
	}
}

// A host that says it will not install, with no SSH target to fall back
// on, fails the deploy with its reason.
func TestDeploy_SelfInstallRefused(t *testing.T) {
	fastSelfInstall(t)
	hosts := []Host{{Name: "a", Kind: KindServer, Entry: pairedEntry}}
	_, d := newDeployFixture(t, Config{Hosts: hosts})
	host := &fakeSelfHost{version: "0.1.0", restartErr: errors.New("the host did not install: updates are turned off on this machine")}
	d.OpenLink = host.open
	d.Latest = func(context.Context) (Latest, error) { return Latest{Server: "0.3.0"}, nil }
	d.Collector = Collector{ReadStudio: func(context.Context, Host) (studioclient.Status, string, error) {
		return studioclient.Status{Info: studioclient.ServerInfo{Hostname: "a", Platform: "darwin", Arch: "arm64"}}, ViaRelay, nil
	}}
	p, err := d.Prepare(context.Background(), Request{Hosts: hosts, Source: SourceRelease})
	if err != nil {
		t.Fatal(err)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if results[0].OK || !strings.Contains(results[0].Error, "updates are turned off") || results[0].FellBack != "" {
		t.Fatalf("result = %+v", results[0])
	}
}

// A host that fails to install on itself, and has an SSH target, is
// installed over SSH instead, and the result says why.
func TestDeploy_SelfInstallFallsBackToSSH(t *testing.T) {
	fastSelfInstall(t)
	hosts := []Host{{Name: "a", SSH: "a.example.org", Kind: KindServer, Entry: pairedEntry}}
	f, d := newDeployFixture(t, Config{Hosts: hosts})
	host := &fakeSelfHost{version: "0.1.0", restartErr: errors.New("the host did not install: updates are turned off on this machine")}
	d.OpenLink = host.open
	d.Latest = func(context.Context) (Latest, error) { return Latest{Server: "0.3.0"}, nil }
	p, err := d.Prepare(context.Background(), Request{Hosts: hosts, Source: SourceRelease})
	if err != nil {
		t.Fatal(err)
	}
	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	r := results[0]
	if !r.OK || !strings.Contains(r.FellBack, "updates are turned off") || !strings.HasSuffix(filepath.Base(r.LogPath), ".log") || !strings.Contains(r.LogPath, "a-over-ssh-") {
		t.Fatalf("result = %+v", r)
	}
	if !strings.Contains(strings.Join(f.scriptsFor("a"), "\n"), "'studio' 'update'") {
		t.Errorf("no ssh update ran: %v", f.scriptsFor("a"))
	}
}

// A Mac desktop release that fails to install on itself is downloaded here
// and installed over SSH. Ion there was already quitting for the
// self-install, so the SSH install quits a running one instead of refusing.
func TestDeploy_DesktopSelfInstallFallsBackToSSH(t *testing.T) {
	fastSelfInstall(t)
	hosts := []Host{{Name: "m", SSH: "m", Kind: KindDesktop, Entry: pairedEntry}}
	f, d := newDeployFixture(t, Config{Hosts: hosts})
	answer := f.answer
	f.runner.answer = func(h Host, script, stdin string) ([]byte, []byte, error) {
		if script == macIonRunning {
			return []byte("yes\n"), nil, nil
		}
		return answer(h, script, stdin)
	}
	host := &fakeSelfHost{desktop: "0.2.0"}
	d.OpenLink = host.open
	content := []byte("pkg")
	sum := sha256.Sum256(content)
	latest := Latest{Desktop: "0.3.0", DesktopAssets: []ReleaseAsset{{Name: "Ion-0.3.0.pkg", URL: "https://example.org/Ion-0.3.0.pkg", Digest: "sha256:" + hex.EncodeToString(sum[:])}}}
	d.Latest = func(context.Context) (Latest, error) { return latest, nil }
	d.Artifacts.CacheDir = t.TempDir()
	d.Artifacts.Download = func(_ context.Context, _, dest string) error { return os.WriteFile(dest, content, 0o644) }
	p, err := d.Prepare(context.Background(), Request{Hosts: hosts, Source: SourceRelease})
	if err != nil {
		t.Fatal(err)
	}
	if !p.Targets[0].Self {
		t.Fatalf("target = %+v", p.Targets[0])
	}
	// The host answered while planning, and is gone by the time it is asked to install.
	host.mu.Lock()
	host.down = 1
	host.mu.Unlock()

	results, err := d.Run(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	r := results[0]
	if !r.OK || r.FellBack == "" || r.Receipt == nil || !r.Receipt.WasRunning {
		t.Fatalf("result = %+v", r)
	}
	all := strings.Join(f.scriptsFor("m"), "\n")
	if !strings.Contains(all, "pkill -USR2") || !strings.Contains(all, copyToScript+filepath.Join(d.Artifacts.CacheDir, "desktop-0.3.0", "Ion-0.3.0.pkg")) || !strings.Contains(all, "sudo -n installer -pkg") {
		t.Errorf("scripts:\n%s", all)
	}
}

// Which hosts install on themselves: a Windows host never does (its
// installer needs an administrator), a host that does not answer deploys
// over SSH, and --over-ssh forces it.
func TestDeploy_WhoInstallsOnItself(t *testing.T) {
	hosts := []Host{
		{Name: "win", SSH: "win.example.org", Kind: KindDesktop, Entry: pairedEntry},
		{Name: "quiet", SSH: "quiet.example.org", Kind: KindServer, Entry: pairedEntry},
		{Name: "plain", SSH: "plain.example.org", Kind: KindServer},
	}
	f, d := newDeployFixture(t, Config{Hosts: hosts})
	f.platform["win"] = "Windows arm64"
	d.OpenLink = func(_ context.Context, h Host) (HostLink, error) {
		if h.Name == "quiet" {
			return nil, errors.New("connection refused")
		}
		return &fakeLink{host: &fakeSelfHost{}}, nil
	}
	d.Latest = func(context.Context) (Latest, error) { return Latest{Server: "0.3.0", Desktop: "1.0.0"}, nil }
	p, err := d.Prepare(context.Background(), Request{Hosts: hosts, Source: SourceRelease})
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range p.Targets {
		if target.Self {
			t.Errorf("%s must deploy over ssh: %+v", target.Host.Name, target)
		}
	}
	answers := []Host{{Name: "ok", SSH: "ok.example.org", Kind: KindServer, Entry: pairedEntry}}
	f.platform["ok"] = "Darwin arm64"
	d.Config.Hosts = answers
	forced, err := d.Prepare(context.Background(), Request{Hosts: answers, Source: SourceRelease, ForceSSH: true})
	if err != nil || forced.Targets[0].Self {
		t.Fatalf("--over-ssh: %+v, %v", forced, err)
	}
	// A host that answers installs on itself, unless its Ion predates doing
	// so or it says it cannot right now: then SSH carries the install.
	for name, host := range map[string]*fakeSelfHost{"ok": {}, "old": {predatesSelfInstall: true}, "sudo": {cannotNow: "needs_sudo"}} {
		one := []Host{{Name: name, SSH: name + ".example.org", Kind: KindServer, Entry: pairedEntry}}
		f.platform[name] = "Darwin arm64"
		d.Config.Hosts = one
		d.OpenLink = func(context.Context, Host) (HostLink, error) { return &fakeLink{host: host}, nil }
		prepared, err := d.Prepare(context.Background(), Request{Hosts: one, Source: SourceRelease})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got, want := prepared.Targets[0].Self, name == "ok"; got != want {
			t.Errorf("%s installs on itself = %v, want %v", name, got, want)
		}
	}
	// With no SSH target and no answer, there is no way to deploy.
	d.Config.Hosts = []Host{{Name: "gone", Kind: KindServer, Entry: pairedEntry}}
	d.OpenLink = func(context.Context, Host) (HostLink, error) { return nil, errors.New("connection refused") }
	gone, err := d.Prepare(context.Background(), Request{Hosts: d.Config.Hosts, Source: SourceRelease})
	if err != nil || gone.Targets[0].Refusal == "" {
		t.Errorf("a host that neither answers nor has an ssh target is refused: %+v, %v", gone, err)
	}
}

// The app updater installs a zip that holds Ion.app; a Mac desktop build is
// packed into one from the app the checkout built.
func TestUpdateArchive(t *testing.T) {
	checkout := t.TempDir()
	release := filepath.Join(checkout, "desktop", "release")
	if err := os.MkdirAll(filepath.Join(release, "mac-arm64", "Ion.app"), 0o755); err != nil {
		t.Fatal(err)
	}
	pkg := filepath.Join(release, "Ion-9.9.9.pkg")
	if err := os.WriteFile(pkg, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	var ran []ExecSpec
	a := Artifacts{Exec: func(_ context.Context, spec ExecSpec) error { ran = append(ran, spec); return nil }}
	zip, err := a.UpdateArchive(context.Background(), checkout, pkg, os.Stderr)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(zip) != "Ion-9.9.9-update.zip" || len(ran) != 1 || ran[0].Name != "ditto" {
		t.Fatalf("zip %s, ran %+v", zip, ran)
	}
	if got := strings.Join(ran[0].Args, " "); got != "-c -k --keepParent "+filepath.Join(release, "mac-arm64", "Ion.app")+" "+zip {
		t.Errorf("ditto args = %s", got)
	}
}
