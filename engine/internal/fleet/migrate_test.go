package fleet

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/studioclient"
)

func TestMatchEntry(t *testing.T) {
	entries := []Entry{
		{Kind: EntryPaired, Label: "Work Laptop", URL: "http://worklaptop.local:7331", Via: ViaLAN},
		{Kind: EntryPaired, Label: "Team Beta (me)", URL: "https://ion.example.org", Via: ViaLAN},
		{Kind: EntryPaired, Label: "studio", URL: "http://127.0.0.1:7331", Via: ViaSSHTunnel, SSH: &SSHLeg{Destination: "user@Studio.local", RemotePort: 7331}},
	}
	cases := []struct {
		host Host
		want string
	}{
		{Host{Name: "worklaptop", SSH: "admin@worklaptop.example.org"}, ""},
		{Host{Name: "worklaptop", SSH: "admin@WorkLaptop.local"}, "Work Laptop"},
		{Host{Name: "work laptop"}, "Work Laptop"},
		{Host{Name: "team", URL: "https://ion.example.org/"}, "Team Beta (me)"},
		{Host{Name: "st", SSH: "studio"}, "studio"},
		// A loopback url belongs to an ssh-reached server, not to this host.
		{Host{Name: "lo", SSH: "127.0.0.1"}, ""},
		{Host{Name: "win-arm64", SSH: "user@10.0.0.9"}, ""},
	}
	for _, c := range cases {
		got, ok := matchEntry(entries, c.host)
		if (c.want == "") == ok || got.Label != c.want {
			t.Errorf("%+v matched %q (%v), want %q", c.host, got.Label, ok, c.want)
		}
	}
}

// migrationFixture is a fleet file with hosts of its own, the fleet's old
// pairings, and Studio's catalog.
type migrationFixture struct {
	path    string
	catalog *Catalog
	legacy  *Pairings
	said    []string
	// unreachable hosts do not answer.
	unreachable map[string]bool
	paired      []string
	// onRun sees each host as the migration reaches it over SSH.
	onRun func(h Host)
	// pairedErr is how a host answers the fleet's old pairing; nil is "not reachable".
	pairedErr error
}

func newMigrationFixture(t *testing.T, settings string) *migrationFixture {
	t.Helper()
	dir := t.TempDir()
	return &migrationFixture{path: filepath.Join(dir, "fleet.json"), catalog: testCatalog(t, settings), legacy: OpenPairings(filepath.Join(dir, "fleet")), unreachable: map[string]bool{}}
}

func (f *migrationFixture) migration() Migration {
	runner := &fakeRunner{answer: func(h Host, script string, _ string) ([]byte, []byte, error) {
		if f.onRun != nil {
			f.onRun(h)
		}
		if f.unreachable[h.Name] {
			return nil, nil, errors.New("ssh: connect to host: Operation timed out")
		}
		return []byte(`{"url":"ion-studio://pair?code=0123456789abcdef0123456789abcdef&url=http%3A%2F%2F` + h.Name + `.example%3A7331&env=` + h.Name + `"}` + "\n"), nil, nil
	}}
	return Migration{
		Path: f.path, Catalog: f.catalog, Legacy: f.legacy,
		Pairer: Pairer{
			Runner: runner, Catalog: f.catalog,
			OverHTTP: func(_ context.Context, base string, req studioclient.PairRequest, _ studioclient.KeyPair) (studioclient.Pairing, error) {
				f.paired = append(f.paired, base+" as "+req.Label+" "+req.DeviceID)
				return studioclient.Pairing{ClientID: "studio-client", SharedSecret: bytes.Repeat([]byte{3}, 32)}, nil
			},
			EnvironmentID: func(_ context.Context, base string) (string, error) { return "env-of-" + base, nil },
		},
		Studio: Studio{
			Catalog: f.catalog,
			Paired: func(_ context.Context, base string, p studioclient.Pairing) (*studioclient.Session, error) {
				if f.pairedErr != nil {
					return nil, f.pairedErr
				}
				return nil, errors.New("not reachable in this test: " + base + " " + p.ClientID)
			},
			Tunnel: func(context.Context, string, int, string) (string, func(), error) {
				return "", nil, errors.New("no ssh in this test")
			},
		},
		Say: func(line string) { f.said = append(f.said, line) },
	}
}

// A host Studio already knows keeps Studio's pairing and gains the fleet
// file's deploy settings; one it does not know is paired as this device and
// added manage-only; this machine needs no entry.
func TestMigration_MovesHostsIntoTheCatalog(t *testing.T) {
	f := newMigrationFixture(t, `{"deviceId": "device-1", "environments": [
	  {"kind": "paired", "label": "worklaptop", "url": "http://worklaptop.local:7331", "credentialRef": "env-w", "via": "lan", "environmentId": "env-w"}
	]}`)
	cfg := Config{
		Checkout: "/src/ion",
		LegacyHosts: []Host{
			{Name: "worklaptop", SSH: "admin@worklaptop.example.org", Kind: KindDesktop, AskSudo: true},
			{Name: "win-arm64", SSH: "user@10.0.0.9", Kind: KindDesktop, BuildDir: `C:\dev\ion\.fleet-build`},
			{Name: "this-mac", SSH: LocalSSH, Kind: KindDesktop},
		},
		Profiles: map[string]Profile{},
	}
	pending := f.migration().Run(context.Background(), &cfg)
	if len(pending) != 0 {
		t.Fatalf("pending = %v", pending)
	}
	entries, err := f.catalog.Entries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v", entries)
	}
	laptop, win := entries[0], entries[1]
	if laptop.CredentialRef != "env-w" || laptop.ManageOnly || laptop.Deploy == nil || laptop.Deploy.SSH != "admin@worklaptop.example.org" || !laptop.Deploy.AskSudo || laptop.Deploy.Kind != KindDesktop {
		t.Errorf("the known host = %+v deploy %+v", laptop, laptop.Deploy)
	}
	if win.Label != "win-arm64" || !win.ManageOnly || win.Kind != EntryPaired || win.Via != ViaLAN || win.Deploy == nil || win.Deploy.BuildDir != `C:\dev\ion\.fleet-build` || win.EnvironmentID == "" {
		t.Errorf("the new host = %+v deploy %+v", win, win.Deploy)
	}
	// Paired as this device, under Studio's own label and device id, once.
	if len(f.paired) != 1 || !strings.Contains(f.paired[0], "as desktop ") || !strings.HasSuffix(f.paired[0], " device-1") {
		t.Errorf("pairings made = %v", f.paired)
	}
	if p, ok, err := f.catalog.Pairing(win.CredentialKey()); err != nil || !ok || p.ClientID != "studio-client" {
		t.Errorf("the new host's secret: %+v %v %v", p, ok, err)
	}
	// The fleet file keeps how deploys run and lists no hosts.
	back, err := Load(f.path)
	if err != nil || len(back.LegacyHosts) != 0 || back.Checkout != "/src/ion" {
		t.Errorf("fleet file after = %+v %v", back, err)
	}
}

// A host that does not answer stays in the fleet file for the next run, and
// the ones that answered are not held back by it.
func TestMigration_LeavesWhatItCannotFinish(t *testing.T) {
	f := newMigrationFixture(t, `{"environments": [
	  {"kind": "paired", "label": "worklaptop", "url": "http://worklaptop.local:7331", "credentialRef": "env-w", "via": "lan", "environmentId": "env-w"}
	]}`)
	f.unreachable["win-arm64"] = true
	// The fleet's old pairing with the known host cannot be revoked now.
	if err := f.legacy.Put("worklaptop", studioclient.Pairing{ClientID: "old-fleet-client", SharedSecret: bytes.Repeat([]byte{5}, 32)}); err != nil {
		t.Fatal(err)
	}
	cfg := Config{LegacyHosts: []Host{
		{Name: "worklaptop", SSH: "admin@worklaptop.example.org", Kind: KindDesktop},
		{Name: "win-arm64", SSH: "user@10.0.0.9", Kind: KindDesktop},
		{Name: "this-mac", SSH: LocalSSH},
	}, Profiles: map[string]Profile{}}
	pending := f.migration().Run(context.Background(), &cfg)
	if len(pending) != 2 || pending["win-arm64"] == nil || pending["worklaptop"] == nil || !strings.Contains(pending["worklaptop"].Error(), "revoke the old fleet pairing") {
		t.Fatalf("pending = %v", pending)
	}
	back, err := Load(f.path)
	if err != nil || len(back.LegacyHosts) != 2 {
		t.Fatalf("fleet file after = %+v %v", back, err)
	}
	// The old pairing is still held, so the next run can revoke it on the host.
	if _, ok, _ := f.legacy.Get("worklaptop"); !ok { //nolint:errcheck // only presence matters
		t.Error("the old fleet pairing was forgotten before the host revoked it")
	}
	// The deploy settings moved even though the revoke is still owed.
	entries, _ := f.catalog.Entries() //nolint:errcheck // asserted below
	if len(entries) != 1 || entries[0].Deploy == nil || entries[0].Deploy.SSH != "admin@worklaptop.example.org" {
		t.Errorf("entries = %+v", entries)
	}
}

// A run cut short while it works on a later host has already saved the hosts
// it finished: the fleet file no longer lists them.
func TestMigration_SavesEachHostAsItMoves(t *testing.T) {
	f := newMigrationFixture(t, `{"environments": []}`)
	var listedWhenSecondRan []string
	f.onRun = func(h Host) {
		if h.Name != "second" || listedWhenSecondRan != nil {
			return
		}
		back, err := Load(f.path)
		if err != nil {
			t.Errorf("fleet file unreadable mid-run: %v", err)
		}
		listedWhenSecondRan = []string{}
		for _, left := range back.LegacyHosts {
			listedWhenSecondRan = append(listedWhenSecondRan, left.Name)
		}
	}
	cfg := Config{LegacyHosts: []Host{
		{Name: "this-mac", SSH: LocalSSH},
		{Name: "second", SSH: "user@second.example.org", Kind: KindServer},
	}, Profiles: map[string]Profile{}}
	f.migration().Run(context.Background(), &cfg)
	if len(listedWhenSecondRan) != 1 || listedWhenSecondRan[0] != "second" {
		t.Fatalf("fleet file listed %v while the second host was being moved; want only it", listedWhenSecondRan)
	}
}

// A host whose data was replaced since the fleet paired with it holds no such
// pairing. There is nothing to revoke, so the host is done.
func TestMigration_TreatsAPairingTheHostNoLongerHoldsAsRevoked(t *testing.T) {
	f := newMigrationFixture(t, `{"environments": [
	  {"kind": "paired", "label": "win", "url": "http://win.example.org:7331", "credentialRef": "env-w", "via": "lan", "environmentId": "env-w"}
	]}`)
	f.pairedErr = fmt.Errorf("%w: unknown client", studioclient.ErrUnknownClient)
	if err := f.legacy.Put("win", studioclient.Pairing{ClientID: "old-fleet-client", SharedSecret: bytes.Repeat([]byte{5}, 32)}); err != nil {
		t.Fatal(err)
	}
	cfg := Config{LegacyHosts: []Host{{Name: "win", SSH: "user@win.example.org", Kind: KindDesktop}}, Profiles: map[string]Profile{}}
	if pending := f.migration().Run(context.Background(), &cfg); len(pending) != 0 {
		t.Fatalf("pending = %v", pending)
	}
	if _, ok, _ := f.legacy.Get("win"); ok { //nolint:errcheck // only presence matters
		t.Error("the old pairing the host no longer holds was kept")
	}
}

// A server reached at its own address comes over with the fleet's sign-in.
func TestMigration_DropsALegacySignInForAKnownServer(t *testing.T) {
	f := newMigrationFixture(t, `{"environments": [
	  {"kind": "paired", "label": "Team Beta (me)", "url": "https://ion.example.org", "credentialRef": "env-t", "via": "lan", "environmentId": "env-t"}
	]}`)
	if err := f.legacy.PutSignIn("team", studioclient.SignIn{Issuer: "https://login.example.org", RefreshToken: "rt-old"}); err != nil {
		t.Fatal(err)
	}
	cfg := Config{LegacyHosts: []Host{{Name: "team", URL: "https://ion.example.org", Kind: KindServer}}, Profiles: map[string]Profile{}}
	if pending := f.migration().Run(context.Background(), &cfg); len(pending) != 0 {
		t.Fatalf("pending = %v", pending)
	}
	if _, ok, _ := f.legacy.GetSignIn("team"); ok { //nolint:errcheck // only presence matters
		t.Error("the fleet's own sign-in survived the move to Studio's pairing")
	}
	entries, _ := f.catalog.Entries() //nolint:errcheck // asserted below
	if len(entries) != 1 || entries[0].Deploy == nil || entries[0].Deploy.Kind != KindServer || entries[0].Deploy.SSH != "" {
		t.Errorf("entries = %+v deploy %+v", entries, entries[0].Deploy)
	}
}
