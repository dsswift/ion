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
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/studiostatus"
)

func TestConfig_ValidateLoadSave(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fleet.json")
	empty, err := Load(path)
	if err != nil || len(empty.Hosts) != 0 {
		t.Fatalf("a missing fleet file is an empty fleet: %+v %v", empty, err)
	}
	c := Config{
		Hosts:    []Host{{Name: "oscar", SSH: "user@oscar.local", Kind: KindServer, Profile: "home"}, {Name: "mac", SSH: "local", Kind: KindDesktop}},
		Profiles: map[string]Profile{"home": {Relay: "wss://relay.example.org", RelayKeyCommand: "echo k"}},
	}
	if err := Save(path, c); err != nil {
		t.Fatal(err)
	}
	back, err := Load(path)
	if err != nil || len(back.Hosts) != 2 || back.Hosts[0].Name != "oscar" || back.ProfileOf(back.Hosts[0]).Relay != "wss://relay.example.org" {
		t.Fatalf("round trip = %+v %v", back, err)
	}
	// Windows file modes carry only read-only; the profile's ACL keeps it private.
	if info, err := os.Stat(path); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Errorf("the fleet file must be owner-only: %v %v", info.Mode(), err)
	}
	bad := []Config{
		{Hosts: []Host{{Name: "a b", SSH: "x", Kind: KindServer}}},
		{Hosts: []Host{{Name: "a", SSH: "x", Kind: KindServer}, {Name: "a", SSH: "y", Kind: KindServer}}},
		{Hosts: []Host{{Name: "a", Kind: KindServer}}},
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
	if _, err := back.Select([]string{"nope"}); err == nil {
		t.Error("an unknown host name must be an error")
	}
}

func TestPairings_RoundTrip(t *testing.T) {
	p := OpenPairings(t.TempDir())
	if _, ok, err := p.Get("oscar"); ok || err != nil {
		t.Fatalf("an empty store has no pairing: ok=%v err=%v", ok, err)
	}
	want := studioclient.Pairing{ClientID: "c1", SharedSecret: bytes.Repeat([]byte{7}, 32), Relays: []studioclient.Relay{{URL: "wss://r", Auth: studioclient.RelayAuth{Mode: "psk", Key: "k"}}}}
	if err := p.Put("oscar", want); err != nil {
		t.Fatal(err)
	}
	got, ok, err := p.Get("oscar")
	if err != nil || !ok || got.ClientID != "c1" || !bytes.Equal(got.SharedSecret, want.SharedSecret) || got.Relays[0].Auth.Key != "k" {
		t.Fatalf("got %+v ok=%v err=%v", got, ok, err)
	}
	if err := p.Delete("oscar"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := p.Get("oscar"); ok { //nolint:errcheck // absence is the assertion
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

type memPairings map[string]studioclient.Pairing

func (m memPairings) Get(host string) (studioclient.Pairing, bool, error) {
	p, ok := m[host]
	return p, ok, nil
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

func TestCollect_SSHThenRelayThenDown(t *testing.T) {
	unreachable := sshExit255(t)
	runner := &fakeRunner{answer: func(h Host, _ string, _ string) ([]byte, []byte, error) {
		if h.Name == "a" {
			return reportJSON(t, "3"), nil, nil
		}
		return nil, []byte("ssh: connect to host: Operation timed out"), unreachable
	}}
	var relayed []string
	c := Collector{
		Runner:   runner,
		Pairings: memPairings{"b": {ClientID: "c", Relays: []studioclient.Relay{{URL: "wss://r", Auth: studioclient.RelayAuth{Mode: "psk", Key: "k"}}}}},
		ReadRelay: func(_ context.Context, relay studioclient.Relay, bearer string, _ studioclient.Pairing) (studioclient.Status, error) {
			relayed = append(relayed, relay.URL+" "+bearer)
			return studioclient.Status{Info: studioclient.ServerInfo{Hostname: "b-host", Formats: []compat.Format{{ID: "transfer-archive", Owner: "server", Version: "2", Rule: compat.RuleExact}}}}, nil
		},
	}
	got := c.Collect(context.Background(), []Host{{Name: "a", SSH: "a", Kind: KindServer}, {Name: "b", SSH: "b", Kind: KindServer}, {Name: "c", SSH: "c", Kind: KindServer}})
	if got[0].Via != ViaSSH || got[0].Report == nil {
		t.Errorf("a = %+v", got[0])
	}
	if got[1].Via != ViaRelay || got[1].Report == nil || got[1].Report.Hostname != "b-host" || len(relayed) != 1 || relayed[0] != "wss://r k" {
		t.Errorf("b = %+v relayed=%v", got[1], relayed)
	}
	if got[2].Via != ViaNone || got[2].Report != nil || !strings.Contains(got[2].Error, "not paired") || !strings.Contains(got[2].Error, "unreachable") {
		t.Errorf("c = %+v", got[2])
	}
	if !strings.Contains(runner.scripts[0], `"$ION" 'studio' 'status' '--json' '--no-latest'`) {
		t.Errorf("probe script = %s", runner.scripts[0])
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
	if err := Restart(context.Background(), runner, Host{Name: "s", SSH: "s", Kind: KindServer}); err != nil {
		t.Fatal(err)
	}
	if err := Restart(context.Background(), runner, Host{Name: "d", SSH: "d", Kind: KindDesktop}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(runner.scripts[0], `"$ION" 'studio' 'restart'`) || !strings.Contains(runner.scripts[1], "pkill -USR2") || !strings.Contains(runner.scripts[1], "open -a") {
		t.Errorf("scripts = %v", runner.scripts)
	}
	failing := &fakeRunner{answer: func(Host, string, string) ([]byte, []byte, error) { return nil, []byte("boom"), errors.New("exit 1") }}
	if err := Restart(context.Background(), failing, Host{Name: "d", SSH: "d", Kind: KindDesktop}); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Errorf("a failed restart must carry the host's stderr: %v", err)
	}
}

// Over SSH a host lists every device of its owner, the fleet's own pairing
// included; the collector marks it so counts match a relay read.
func TestCollect_MarksTheFleetsOwnPairing(t *testing.T) {
	report := studiostatus.Report{SchemaVersion: 1, Kind: studiostatus.KindDesktop, Devices: []studiostatus.PairedDevice{{ClientID: "fleet-client", Connected: true}, {ClientID: "phone", Kind: "mobile"}}}
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{answer: func(Host, string, string) ([]byte, []byte, error) { return data, nil, nil }}
	c := Collector{Runner: runner, Pairings: memPairings{"m": {ClientID: "fleet-client"}}}
	st := c.One(context.Background(), Host{Name: "m", SSH: "m", Kind: KindDesktop})
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
