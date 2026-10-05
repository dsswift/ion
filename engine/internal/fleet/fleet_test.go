package fleet

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/studiostatus"
)

func TestConfig_ValidateLoadSave(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fleet.json")
	empty, err := Load(path)
	if err != nil || len(empty.Hosts) != 0 || len(empty.LegacyHosts) != 0 {
		t.Fatalf("a missing fleet file is an empty fleet: %+v %v", empty, err)
	}
	// The file holds how deploys run, and hosts an earlier fleet file listed.
	c := Config{
		Checkout:    "/src/ion",
		Hosts:       []Host{{Name: "from-the-catalog", SSH: "user@devbox.local"}},
		LegacyHosts: []Host{{Name: "devbox", SSH: "user@devbox.local", Kind: KindServer, Profile: "home"}},
		Profiles:    map[string]Profile{"home": {Relay: "wss://relay.example.org", RelayKeyCommand: "echo k"}},
	}
	if err := Save(path, c); err != nil {
		t.Fatal(err)
	}
	back, err := Load(path)
	if err != nil || back.Checkout != "/src/ion" || len(back.LegacyHosts) != 1 || back.LegacyHosts[0].Name != "devbox" || back.ProfileOf(back.LegacyHosts[0]).Relay != "wss://relay.example.org" {
		t.Fatalf("round trip = %+v %v", back, err)
	}
	if len(back.Hosts) != 0 {
		t.Errorf("the catalog's hosts were written to the fleet file: %+v", back.Hosts)
	}
	// Windows file modes carry only read-only; the profile's ACL keeps it private.
	if info, err := os.Stat(path); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Errorf("the fleet file must be owner-only: %v %v", info.Mode(), err)
	}
	bad := []Config{
		{Hosts: []Host{{Name: "a b", SSH: "x", Kind: KindServer}}},
		{Hosts: []Host{{Name: "a", SSH: "x", Kind: KindServer}, {Name: "a", SSH: "y", Kind: KindServer}}},
		{Hosts: []Host{{Name: "a", SSH: "x", Kind: "laptop"}}},
		{Hosts: []Host{{Name: "a", SSH: "x", Kind: KindServer, Profile: "nope"}}},
		{Profiles: map[string]Profile{"p": {Relay: "wss://r", RelayOIDC: true, RelayKeyCommand: "x"}}},
		{Profiles: map[string]Profile{"p": {RelayOIDC: true}}},
	}
	for i, b := range bad {
		if b.Validate() == nil {
			t.Errorf("config %d must not validate: %+v", i, b)
		}
	}
	// A host the device only talks to over its Studio connection has no SSH
	// target, and one whose kind the catalog does not say has none.
	if err := (Config{Hosts: []Host{{Name: "relay-only"}}}).Validate(); err != nil {
		t.Errorf("a host with no ssh target or kind must validate: %v", err)
	}
	back.Hosts = []Host{{Name: "devbox"}}
	if _, err := back.Select([]string{"nope"}); err == nil {
		t.Error("an unknown host name must be an error")
	}
}

// The fleet's hosts are this machine and every server in Studio's catalog.
func TestUseCatalog(t *testing.T) {
	c := testCatalog(t, `{"environments": [
	  {"kind": "paired", "label": "devbox", "url": "http://devbox.example:7331", "credentialRef": "env-1", "via": "lan", "environmentId": "env-1",
	   "deploy": {"ssh": "user@devbox.example", "kind": "server", "askSudo": true}},
	  {"kind": "paired", "label": "oscar", "url": "http://127.0.0.1:7331", "credentialRef": "env-2", "via": "ssh", "environmentId": "env-2", "ssh": {"destination": "user@oscar.example", "remotePort": 7331}},
	  {"kind": "bearer", "label": "Team Beta (shared)", "url": "https://ion.example.org", "environmentId": "env-3", "manageOnly": true},
	  {"kind": "paired", "label": "Team Beta shared", "url": "http://other.example:7331", "credentialRef": "env-4", "via": "relay", "environmentId": "env-4"}
	]}`)
	var cfg Config
	if err := cfg.UseCatalog(c); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Hosts) != 5 || cfg.Hosts[0].SSH != LocalSSH || cfg.Hosts[0].Entry != nil {
		t.Fatalf("hosts = %+v", cfg.Hosts)
	}
	devbox, oscar, team, twin := cfg.Hosts[1], cfg.Hosts[2], cfg.Hosts[3], cfg.Hosts[4]
	if devbox.Name != "devbox" || devbox.SSH != "user@devbox.example" || devbox.Kind != KindServer || !devbox.AskSudo || devbox.URL != "http://devbox.example:7331" || !devbox.Paired() || devbox.External() {
		t.Errorf("devbox = %+v", devbox)
	}
	// An ssh-reached server deploys over the same SSH target, and its url is
	// its own loopback, which does not answer from here.
	if oscar.SSH != "user@oscar.example" || oscar.URL != "" || oscar.Kind != "" {
		t.Errorf("oscar = %+v", oscar)
	}
	if team.Name != "Team-Beta-shared" || team.Label != "Team Beta (shared)" || !team.ManageOnly || !team.External() || !team.Paired() {
		t.Errorf("team = %+v", team)
	}
	if twin.Name != "Team-Beta-shared-2" {
		t.Errorf("two labels that make one name: second = %q", twin.Name)
	}
	// A server answers to its environment id too.
	if picked, err := cfg.Select([]string{"env-3", "oscar"}); err != nil || len(picked) != 2 || picked[0].Name != "Team-Beta-shared" || picked[1].Name != "oscar" {
		t.Errorf("select by environment id = %+v %v", picked, err)
	}
}

func TestPairings_RoundTrip(t *testing.T) {
	p := OpenPairings(t.TempDir())
	if _, ok, err := p.Get("devbox"); ok || err != nil {
		t.Fatalf("an empty store has no pairing: ok=%v err=%v", ok, err)
	}
	want := studioclient.Pairing{ClientID: "c1", SharedSecret: bytes.Repeat([]byte{7}, 32), Relays: []studioclient.Relay{{URL: "wss://r", Auth: studioclient.RelayAuth{Mode: "psk", Key: "k"}}}}
	if err := p.Put("devbox", want); err != nil {
		t.Fatal(err)
	}
	got, ok, err := p.Get("devbox")
	if err != nil || !ok || got.ClientID != "c1" || !bytes.Equal(got.SharedSecret, want.SharedSecret) || got.Relays[0].Auth.Key != "k" {
		t.Fatalf("got %+v ok=%v err=%v", got, ok, err)
	}
	if err := p.Delete("devbox"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := p.Get("devbox"); ok { //nolint:errcheck // absence is the assertion
		t.Error("a deleted pairing must be gone")
	}
}

// fakeRunner answers scripts per host. A PowerShell script reaches answer
// with the psScript prefix.
type fakeRunner struct {
	mu     sync.Mutex
	answer func(h Host, script string, stdin string) ([]byte, []byte, error)
	// platform answers Platform; nil is a Mac on Apple silicon.
	platform func(h Host) (Platform, error)
	scripts  []string
	stdins   []string
	hosts    []string
	// banners holds what each terminal run said it would ask for.
	banners []string
}

// psScript marks a script the fake ran as PowerShell.
const psScript = "powershell:"

func (f *fakeRunner) Platform(_ context.Context, h Host) (Platform, error) {
	if f.platform == nil {
		return Platform{GOOS: "darwin", GOARCH: "arm64", LoginShell: ShellPOSIX}, nil
	}
	return f.platform(h)
}

func (f *fakeRunner) RunPowerShell(ctx context.Context, h Host, script string, stdin io.Reader) ([]byte, []byte, error) {
	return f.Run(ctx, h, psScript+script, stdin)
}

// A copy or a terminal run reaches answer as a script with these prefixes.
const (
	copyToScript   = "copy-to:"
	copyFromScript = "copy-from:"
	terminalScript = "terminal:"
)

func (f *fakeRunner) CopyTo(ctx context.Context, h Host, local, remote string) error {
	_, _, err := f.Run(ctx, h, copyToScript+local+" -> "+remote, nil)
	return err
}

func (f *fakeRunner) CopyFrom(ctx context.Context, h Host, remote, local string) error {
	_, _, err := f.Run(ctx, h, copyFromScript+remote+" -> "+local, nil)
	return err
}

func (f *fakeRunner) RunLogged(ctx context.Context, h Host, script string, powershell bool, log io.Writer) ([]byte, []byte, error) {
	run := f.Run
	if powershell {
		run = f.RunPowerShell
	}
	out, stderr, err := run(ctx, h, script, nil)
	log.Write(out)    //nolint:errcheck // test capture
	log.Write(stderr) //nolint:errcheck // test capture
	return out, stderr, err
}

func (f *fakeRunner) RunTerminal(ctx context.Context, h Host, script, banner string, out io.Writer) error {
	f.mu.Lock()
	f.banners = append(f.banners, banner)
	f.mu.Unlock()
	stdout, _, err := f.Run(ctx, h, terminalScript+script, nil)
	out.Write(stdout) //nolint:errcheck // test capture
	return err
}

func (f *fakeRunner) Run(_ context.Context, h Host, script string, stdin io.Reader) ([]byte, []byte, error) {
	in := ""
	if stdin != nil {
		b, _ := io.ReadAll(stdin) //nolint:errcheck // test capture
		in = string(b)
	}
	f.mu.Lock()
	f.scripts = append(f.scripts, script)
	f.stdins = append(f.stdins, in)
	f.hosts = append(f.hosts, h.Name)
	answer := f.answer
	f.mu.Unlock()
	return answer(h, script, in)
}

// sshExit255 is the error ssh returns when it cannot reach a host.
func sshExit255(t *testing.T) error {
	cmd := exec.Command("/bin/sh", "-c", "exit 255")
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/c", "exit 255")
	}
	err := cmd.Run()
	if err == nil {
		t.Fatal("expected an exit error")
	}
	return err
}

func reportJSON(t *testing.T, transfer string) []byte {
	t.Helper()
	r := studiostatus.Report{SchemaVersion: 1, Kind: studiostatus.KindServer, Formats: studiostatus.MergeFormats(nil, []compat.Format{{ID: "transfer-archive", Owner: "server", Version: transfer, Rule: compat.RuleExact}})}
	data, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func studioStatus(hostname, transfer string) studioclient.Status {
	return studioclient.Status{
		Info:     studioclient.ServerInfo{Hostname: hostname, Formats: []compat.Format{{ID: "transfer-archive", Owner: "server", Version: transfer, Rule: compat.RuleExact}}},
		Accounts: []studiostatus.Account{{Provider: "anthropic", Backend: "claude-code", Email: "a@example.com", SignedIn: true, LastSeen: 5}},
	}
}

// A host is read over SSH when it has an SSH target; over its Studio
// connection when SSH gives nothing, or it has no SSH target; and is down
// when neither answers.
func TestCollect_SSHThenStudioThenDown(t *testing.T) {
	unreachable := sshExit255(t)
	runner := &fakeRunner{answer: func(h Host, _ string, _ string) ([]byte, []byte, error) {
		if h.Name == "a" {
			return reportJSON(t, "3"), nil, nil
		}
		return nil, []byte("ssh: connect to host: Operation timed out"), unreachable
	}}
	paired := &Entry{Kind: EntryPaired, Label: "x", CredentialRef: "env-x", EnvironmentID: "env-x"}
	var readMu sync.Mutex
	var read []string
	c := Collector{
		Runner: runner,
		ReadStudio: func(_ context.Context, h Host) (studioclient.Status, string, error) {
			readMu.Lock()
			read = append(read, h.Name)
			readMu.Unlock()
			if h.Name == "c" {
				return studioclient.Status{}, "", errors.New("no address, SSH target, or relay answered")
			}
			return studioStatus(h.Name+"-host", "2"), ViaRelay, nil
		},
	}
	got := c.Collect(context.Background(), []Host{
		{Name: "a", SSH: "a", Kind: KindServer, Entry: paired},
		{Name: "b", SSH: "b", Kind: KindServer, Entry: paired},
		{Name: "c", SSH: "c", Kind: KindServer, Entry: paired},
		{Name: "d", Entry: paired},
		{Name: "e", SSH: "e"},
	})
	if got[0].Via != ViaSSH || got[0].Report == nil {
		t.Errorf("a = %+v", got[0])
	}
	if got[1].Via != ViaRelay || got[1].Report == nil || got[1].Report.Hostname != "b-host" || len(got[1].Report.Accounts) != 1 {
		t.Errorf("b = %+v", got[1])
	}
	if got[2].Via != ViaNone || got[2].Report != nil || !strings.Contains(got[2].Error, "ssh: unreachable") || !strings.Contains(got[2].Error, "studio: no address") {
		t.Errorf("c = %+v", got[2])
	}
	// No SSH target: the Studio connection is the only way in, and SSH is never tried.
	if got[3].Via != ViaRelay || got[3].Report == nil {
		t.Errorf("d = %+v", got[3])
	}
	// No pairing: SSH is the only way in.
	if got[4].Via != ViaNone || !strings.Contains(got[4].Error, "ssh: unreachable") || strings.Contains(got[4].Error, "studio") {
		t.Errorf("e = %+v", got[4])
	}
	sort.Strings(read)
	if strings.Join(read, ",") != "b,c,d" {
		t.Errorf("hosts read over a Studio connection = %v", read)
	}
	if !strings.Contains(runner.scripts[0], `"$ION" 'studio' 'status' '--json' '--no-latest'`) {
		t.Errorf("probe script = %s", runner.scripts[0])
	}
}

// A server reached only at its own address still answers anyone with its
// versions and formats when the device's sign-in to it does not work.
func TestCollect_PublicReadWhenTheSignInFails(t *testing.T) {
	c := Collector{
		ReadStudio: func(context.Context, Host) (studioclient.Status, string, error) {
			return studioclient.Status{}, "", errors.New("not signed in")
		},
		Public: func(_ context.Context, base string) (studioclient.Public, error) {
			return studioclient.Public{Ready: true, Auth: studioclient.AuthConfig{Label: "Atlas Beta"}, Versionz: studioclient.Versionz{ServerVersion: "0.1.0"}}, nil
		},
	}
	st := c.One(context.Background(), Host{Name: "atlas", URL: "https://atlas.example.org", Entry: &Entry{Kind: EntryBearer, Label: "atlas", URL: "https://atlas.example.org"}})
	if st.Via != ViaHTTPS || st.Report == nil || st.Report.Hostname != "Atlas Beta" || len(st.Report.Problems) != 1 || !strings.Contains(st.Report.Problems[0], "not signed in") {
		t.Fatalf("status = %+v report = %+v", st, st.Report)
	}
}

func TestDecodeReport_OlderHosts(t *testing.T) {
	old, err := DecodeReport([]byte(`{"dataDir":"/d","installedVersion":"0.1.0","engineVersion":"1.85.2","ready":true,"services":[{"label":"com.ion.engine.josh","state":"running"}]}`))
	if err != nil || old.Kind != studiostatus.KindServer || len(old.Problems) != 1 || !old.Engine.Running || old.Engine.InstalledVersion != "1.85.2" || !Legacy(old) {
		t.Fatalf("old = %+v err = %v", old, err)
	}
	desktopOld, err := DecodeReport([]byte(`{"dataDir":"/d","installedVersion":"","ready":true,"services":[{"label":"com.ion.engine","state":"stopped"}]}`))
	if err != nil || desktopOld.Kind != studiostatus.KindNone || desktopOld.Engine.Running {
		t.Fatalf("desktop old = %+v err = %v", desktopOld, err)
	}
	if flags := HostFlags(HostStatus{Report: old}); len(flags) != 1 || flags[0] != PredatesFullReport {
		t.Errorf("flags = %v", flags)
	}
	if _, err := DecodeReport([]byte("Ion Engine - Headless AI agent runtime\nUsage: ...")); err == nil {
		t.Error("help text from an ion without `studio` must be an error")
	}
	if _, err := DecodeReport([]byte(`{"schemaVersion":99}`)); err == nil {
		t.Error("a newer schema must be refused")
	}
}

// TestFindIon_PrefersTheBundle runs the probe preamble against a fake home.
func TestFindIon_PrefersTheBundle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("findIon is a POSIX preamble for macOS and Linux hosts; it needs /bin/sh")
	}
	home := t.TempDir()
	write := func(rel, word string) {
		path := filepath.Join(home, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("#!/bin/sh\necho "+word+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	run := func() string {
		cmd := exec.Command("/bin/sh", "-c", findIon+`"$ION"`)
		cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "error: " + string(out)
		}
		return strings.TrimSpace(string(out))
	}
	if _, err := os.Stat("/Applications/Ion.app/Contents/Resources/engine/ion"); err == nil {
		t.Skip("this Mac has a desktop install, which sits between the two fake candidates")
	}
	if got := run(); !strings.Contains(got, "no ion binary") {
		t.Errorf("no candidates = %q", got)
	}
	write(".ion/bin/ion", "bin")
	if got := run(); got != "bin" {
		t.Errorf("only ~/.ion/bin = %q", got)
	}
	write(".ion/studio-server/current/bin/ion", "bundle")
	if got := run(); got != "bundle" {
		t.Errorf("bundle and bin = %q, want the bundle", got)
	}
}

func TestJudge(t *testing.T) {
	cases := []struct {
		rule     compat.Rule
		from, to string
		want     Verdict
	}{
		{compat.RuleExact, "3", "3", VerdictOK},
		{compat.RuleExact, "3", "2", VerdictBlocked},
		{compat.RuleExact, "ion-remote-v1", "ion-remote-v1", VerdictOK},
		{compat.RuleExact, "", "3", VerdictUnknown},
		{compat.RuleAcceptsPrevious, "1", "2", VerdictOK},
		{compat.RuleAcceptsPrevious, "2", "2", VerdictOK},
		{compat.RuleAcceptsPrevious, "1", "3", VerdictBlocked},
		{compat.RuleAcceptsPrevious, "3", "2", VerdictBlocked},
		{compat.RuleReaderAtLeast, "4", "5", VerdictOK},
		{compat.RuleReaderAtLeast, "5", "4", VerdictBlocked},
		{compat.RuleReaderAtLeast, "a", "b", VerdictUnknown},
		{compat.RuleHostStorage, "2", "2", VerdictUnknown},
	}
	for _, c := range cases {
		if got, _ := Judge(c.rule, c.from, c.to); got != c.want {
			t.Errorf("Judge(%s, %q, %q) = %s, want %s", c.rule, c.from, c.to, got, c.want)
		}
	}
}

func hostWith(name string, desktop bool, formats ...compat.Format) HostStatus {
	r := &studiostatus.Report{Formats: studiostatus.MergeFormats(nil, formats)}
	if desktop {
		r.Components.Desktop = &studiostatus.DesktopApp{Version: "1"}
	}
	return HostStatus{Host: Host{Name: name}, Report: r}
}

func TestBuildMatrix_TransferAndStudioWire(t *testing.T) {
	transfer := func(v string) compat.Format {
		return compat.Format{ID: "transfer-archive", Owner: "server", Version: v, Rule: compat.RuleExact, Meaning: "m"}
	}
	wire := func(v string) compat.Format {
		return compat.Format{ID: "studio-wire", Owner: "server", Version: v, Rule: compat.RuleAcceptsPrevious}
	}
	statuses := []HostStatus{
		hostWith("a", true, transfer("3"), wire("2")),
		hostWith("b", false, transfer("3"), wire("3")),
		hostWith("c", false, transfer("2"), wire("4")),
		{Host: Host{Name: "d"}},
	}
	if refs := Comparable(statuses); len(refs) != 2 || refs[0] != TransferFormat || refs[1] != StudioWireFormat {
		t.Fatalf("comparable = %v", refs)
	}
	m := BuildMatrix(statuses, TransferFormat)
	if len(m.Rows) != 4 || m.Cells[0][1].Verdict != VerdictOK || m.Cells[0][2].Verdict != VerdictBlocked || m.Cells[0][3].Verdict != VerdictUnknown {
		t.Errorf("transfer matrix = %+v", m.Cells[0])
	}
	w := BuildMatrix(statuses, StudioWireFormat)
	if len(w.Rows) != 1 || w.Rows[0] != "a" {
		t.Fatalf("only desktops connect as clients: rows = %v", w.Rows)
	}
	if w.Cells[0][1].Verdict != VerdictOK || w.Cells[0][2].Verdict != VerdictBlocked {
		t.Errorf("wire row = %+v", w.Cells[0])
	}
	if d := Drift(statuses, TransferFormat); !d["c"] || d["a"] || d["b"] {
		t.Errorf("drift = %v", d)
	}
}

func TestHostFlags(t *testing.T) {
	no := false
	st := HostStatus{Report: &studiostatus.Report{SchemaVersion: 1, Engine: studiostatus.Engine{Version: "1.0.0", MinVersion: "2.0.0", MeetsMin: &no, PendingRestart: true, InstalledVersion: "2.1.0"},
		Formats: []studiostatus.FormatStatus{{Owner: "engine", ID: "conversation-file", Installed: "3", Running: "2", PendingRestart: true}}}}
	if flags := HostFlags(st); len(flags) != 3 {
		t.Errorf("flags = %v", flags)
	}
	// An engine the host could not read has no version to name.
	unread := HostStatus{Report: &studiostatus.Report{SchemaVersion: 1, Engine: studiostatus.Engine{MinVersion: "0.0.0", MeetsMin: &no}}}
	if flags := HostFlags(unread); len(flags) != 1 || flags[0] != "the server does not see an engine that meets its minimum 0.0.0" {
		t.Errorf("flags = %q", flags)
	}
}

func TestLatestReleases(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`[{"tag_name":"desktop-v2.0.0","prerelease":true},{"tag_name":"server-v0.3.0"},{"tag_name":"desktop-v1.9.0","assets":[{"name":"Ion-1.9.0.pkg","browser_download_url":"https://example.org/p"}]},{"tag_name":"server-v0.2.0"}]`)) //nolint:errcheck // test response
	}))
	t.Cleanup(srv.Close)
	old := ReleasesURL
	ReleasesURL = srv.URL
	t.Cleanup(func() { ReleasesURL = old })
	l, err := LatestReleases(context.Background())
	if err != nil || l.Server != "0.3.0" || l.Desktop != "1.9.0" || len(l.DesktopAssets) != 1 {
		t.Fatalf("latest = %+v err = %v", l, err)
	}
}

func TestSetRelay_KeyTravelsOnStdinOnly(t *testing.T) {
	runner := &fakeRunner{answer: func(_ Host, script, _ string) ([]byte, []byte, error) {
		if strings.Contains(script, "pgrep") {
			return []byte("no\n"), nil, nil
		}
		return []byte("==> relay wss://r saved (pre-shared key)\n"), nil, nil
	}}
	// Valid in sh and PowerShell alike: the key command runs in this OS's shell.
	p := Profile{Relay: "wss://r", RelayKeyCommand: "echo the-key; echo ignored"}
	if err := SetRelay(context.Background(), runner, Host{Name: "g", SSH: "g", Kind: KindDesktop}, p); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(runner.scripts[0], `"$ION" 'studio' 'relay' 'set' 'wss://r' '--key-stdin' '--no-restart'`) || strings.Contains(strings.Join(runner.scripts, " "), "the-key") {
		t.Errorf("scripts = %v", runner.scripts)
	}
	if runner.stdins[0] != "the-key\n" {
		t.Errorf("stdin = %q", runner.stdins[0])
	}
	failing := "echo nope >&2; exit 3"
	if runtime.GOOS == "windows" {
		failing = "[Console]::Error.WriteLine('nope'); exit 3"
	}
	if _, err := RelayKey(context.Background(), Profile{RelayKeyCommand: failing}); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Errorf("a failing key command must say why: %v", err)
	}
	if err := SetRelay(context.Background(), runner, Host{Name: "g", SSH: "g", Kind: KindServer}, Profile{}); err == nil {
		t.Error("a profile without a relay must be refused")
	}
}

func TestRestart_PerKind(t *testing.T) {
	runner := &fakeRunner{answer: func(Host, string, string) ([]byte, []byte, error) { return nil, nil, nil }}
	if err := (Ops{Runner: runner}).Restart(context.Background(), Host{Name: "s", SSH: "s", Kind: KindServer}); err != nil {
		t.Fatal(err)
	}
	if err := (Ops{Runner: runner}).Restart(context.Background(), Host{Name: "d", SSH: "d", Kind: KindDesktop}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(runner.scripts[0], `"$ION" 'studio' 'restart'`) || !strings.Contains(runner.scripts[1], "pkill -USR2") || !strings.Contains(runner.scripts[1], "open -a") {
		t.Errorf("scripts = %v", runner.scripts)
	}
	failing := &fakeRunner{answer: func(Host, string, string) ([]byte, []byte, error) { return nil, []byte("boom"), errors.New("exit 1") }}
	if err := (Ops{Runner: failing}).Restart(context.Background(), Host{Name: "d", SSH: "d", Kind: KindDesktop}); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Errorf("a failed restart must carry the host's stderr: %v", err)
	}
}

// Over SSH a host lists every device of its owner, this device's own pairing
// included; the collector marks it so counts match a Studio read.
func TestCollect_MarksThisDevicesOwnPairing(t *testing.T) {
	catalog := testCatalog(t, "")
	if err := catalog.PutPairing("env-m", StoredPairing{Pairing: studioclient.Pairing{ClientID: "fleet-client", SharedSecret: bytes.Repeat([]byte{7}, 32)}}); err != nil {
		t.Fatal(err)
	}
	report := studiostatus.Report{SchemaVersion: 1, Kind: studiostatus.KindDesktop, Devices: []studiostatus.PairedDevice{{ClientID: "fleet-client", Connected: true}, {ClientID: "phone", Kind: "mobile"}}}
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{answer: func(Host, string, string) ([]byte, []byte, error) { return data, nil, nil }}
	c := Collector{Runner: runner, Studio: Studio{Catalog: catalog}}
	st := c.One(context.Background(), Host{Name: "m", SSH: "m", Kind: KindDesktop, Entry: &Entry{Kind: EntryPaired, CredentialRef: "env-m"}})
	if st.Report == nil || !st.Report.Devices[0].Self || st.Report.Devices[1].Self {
		t.Fatalf("devices = %+v", st.Report)
	}
	if got := DevicesCell(st.Report); got != "1 · 0 on" {
		t.Errorf("cell = %q", got)
	}
	if got := DevicesCell(&studiostatus.Report{}); got != "-" {
		t.Errorf("an unread host = %q", got)
	}
}

func TestAccountCells(t *testing.T) {
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	a := studiostatus.Account{Limits: []studiostatus.AccountLimit{
		{Kind: "session", Percent: 16.4, ResetsAt: "2026-10-03T15:30:00Z", FetchedAt: now.UnixMilli()},
		{Kind: "weekly", Percent: 63, ResetsAt: "2026-10-05T21:00:00Z", FetchedAt: now.UnixMilli()},
		{Kind: "weekly_model", Label: "Example Model", Percent: 91, ResetsAt: "2026-10-03T11:00:00Z", FetchedAt: now.Add(-3 * time.Hour).UnixMilli()},
	}}
	if got := LimitCell(a, "session", now); got != "16% (resets in 3h)" {
		t.Errorf("session = %q", got)
	}
	if got := LimitCell(a, "weekly", now); got != "63% (resets in 2d)" {
		t.Errorf("weekly = %q", got)
	}
	// Read before a reset that has since passed: the number is no longer true.
	if got := LimitCell(a, "weekly_model", now); got != "Example Model reset since last read" {
		t.Errorf("model = %q", got)
	}
	if got := LimitCell(a, "spend", now); got != "-" {
		t.Errorf("a limit the account lacks = %q", got)
	}
	if got := AgoCell(now.Add(-50*time.Hour).UnixMilli(), now); got != "2d ago" {
		t.Errorf("ago = %q", got)
	}
	statuses := []HostStatus{
		{Host: Host{Name: "a"}, Report: &studiostatus.Report{Accounts: []studiostatus.Account{{Provider: "anthropic", Email: "x@example.com", SignedIn: true, LastSeen: 2}}}},
		{Host: Host{Name: "b"}},
		{Host: Host{Name: "c"}, Report: &studiostatus.Report{Accounts: []studiostatus.Account{{Provider: "anthropic", Email: "x@example.com", LastSeen: 1}}}},
	}
	rows := Accounts(statuses)
	if len(rows) != 1 || len(rows[0].Machines) != 2 || !rows[0].SignedIn {
		t.Errorf("accounts = %+v", rows)
	}
}
