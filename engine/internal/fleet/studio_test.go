package fleet

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/studioclient"
)

var testSecret = bytes.Repeat([]byte{7}, 32)

// dialLog records which way a Studio connection was tried.
type dialLog struct {
	tried []string
	// answers are the attempts that succeed.
	answers map[string]bool
}

func (d *dialLog) studio(c *Catalog) Studio {
	try := func(what string) (*studioclient.Session, error) {
		d.tried = append(d.tried, what)
		if d.answers[what] {
			return &studioclient.Session{}, nil
		}
		return nil, errors.New("no answer")
	}
	return Studio{
		Catalog: c,
		Paired: func(_ context.Context, base string, _ studioclient.Pairing) (*studioclient.Session, error) {
			return try("paired " + base)
		},
		Relay: func(_ context.Context, relay studioclient.Relay, bearer string, _ studioclient.Pairing) (*studioclient.Session, error) {
			return try("relay " + relay.URL + " " + bearer)
		},
		Bearer: func(_ context.Context, base, bearer string) (*studioclient.Session, error) {
			return try("bearer " + base + " " + bearer)
		},
		Tunnel: func(_ context.Context, destination string, _ int, remotePort string) (string, func(), error) {
			d.tried = append(d.tried, "tunnel "+destination+":"+remotePort)
			return "http://127.0.0.1:50000", func() {}, nil
		},
		Refresh: func(_ context.Context, oidc studioclient.AuthOIDC, token string) (string, string, error) {
			d.tried = append(d.tried, "refresh "+oidc.Issuer+" "+token)
			return "access-1", "rt-2", nil
		},
	}
}

func pairedCatalog(t *testing.T, key string) *Catalog {
	t.Helper()
	c := testCatalog(t, "")
	err := c.PutPairing(key, StoredPairing{
		Pairing:         studioclient.Pairing{ClientID: "client-1", SharedSecret: testSecret, Relays: []studioclient.Relay{{URL: "wss://relay.example", Auth: studioclient.RelayAuth{Mode: "psk", Key: "k"}}}},
		DirectAddresses: []string{"http://devbox.local:7331", "ws://ignored.example"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// A paired server is tried where it answers directly, then through an SSH
// forward, then through its relay: the relay last.
func TestStudioOpen_Order(t *testing.T) {
	c := pairedCatalog(t, "env-1")
	entry := Entry{Kind: EntryPaired, Label: "devbox", URL: "http://192.168.1.5:7331", CredentialRef: "env-1", Via: ViaLAN, EnvironmentID: "env-1"}
	h := Host{Name: "devbox", SSH: "user@devbox.example", Entry: &entry}

	d := &dialLog{answers: map[string]bool{"relay wss://relay.example k": true}}
	link, err := d.studio(c).Open(context.Background(), h)
	if err != nil {
		t.Fatal(err)
	}
	want := "paired http://192.168.1.5:7331|paired http://devbox.local:7331|tunnel user@devbox.example:7331|paired http://127.0.0.1:50000|relay wss://relay.example k"
	if got := strings.Join(d.tried, "|"); got != want || link.Via != ViaRelay {
		t.Errorf("tried\n  %s\nwant\n  %s\nvia %s", got, want, link.Via)
	}

	d = &dialLog{answers: map[string]bool{"paired http://devbox.local:7331": true}}
	link, err = d.studio(c).Open(context.Background(), h)
	if err != nil || link.Via != ViaDirect || len(d.tried) != 2 {
		t.Errorf("a direct answer stops the search: via %v, tried %v, err %v", link, d.tried, err)
	}

	d = &dialLog{answers: map[string]bool{"paired http://127.0.0.1:50000": true}}
	link, err = d.studio(c).Open(context.Background(), h)
	if err != nil || link.Via != ViaTunnel {
		t.Errorf("the forward: via %v err %v", link, err)
	}

	d = &dialLog{answers: map[string]bool{}}
	if _, err := d.studio(c).Open(context.Background(), h); err == nil || !strings.Contains(err.Error(), "wss://relay.example") {
		t.Errorf("every way failing names each: %v", err)
	}
}

// An ssh-reached server's url is its own loopback: it is reached only
// through the forward its catalog entry names, on the entry's port.
func TestStudioOpen_SSHEntry(t *testing.T) {
	c := pairedCatalog(t, "env-2")
	if err := c.PutPairing("env-2", StoredPairing{Pairing: studioclient.Pairing{ClientID: "client-2", SharedSecret: testSecret}}); err != nil {
		t.Fatal(err)
	}
	entry := Entry{Kind: EntryPaired, Label: "oscar", URL: "http://127.0.0.1:7444", CredentialRef: "env-2", Via: ViaSSHTunnel, SSH: &SSHLeg{Destination: "user@oscar.example", RemotePort: 7444}}
	d := &dialLog{answers: map[string]bool{"paired http://127.0.0.1:50000": true}}
	link, err := d.studio(c).Open(context.Background(), Host{Name: "oscar", Entry: &entry})
	if err != nil || link.Via != ViaTunnel {
		t.Fatalf("via %v err %v", link, err)
	}
	if got := strings.Join(d.tried, "|"); got != "tunnel user@oscar.example:7444|paired http://127.0.0.1:50000" {
		t.Errorf("tried %s", got)
	}
}

// A signed-in server takes a bearer minted from the stored refresh token,
// and the token the issuer rotated to is kept.
func TestStudioOpen_Bearer(t *testing.T) {
	c := testCatalog(t, "")
	if err := c.PutRefreshToken("env-3", "rt-1"); err != nil {
		t.Fatal(err)
	}
	entry := Entry{Kind: EntryBearer, Label: "team", URL: "https://ion.example.org", EnvironmentID: "env-3", OIDC: &EntryOIDC{Issuer: "https://login.example.org/t/v2.0", Audience: "app", Scope: "Studio.Access"}}
	d := &dialLog{answers: map[string]bool{"bearer https://ion.example.org access-1": true}}
	link, err := d.studio(c).Open(context.Background(), Host{Name: "team", URL: entry.URL, Entry: &entry})
	if err != nil || link.Via != ViaHTTPS {
		t.Fatalf("via %v err %v", link, err)
	}
	if got := strings.Join(d.tried, "|"); got != "refresh https://login.example.org/t/v2.0 rt-1|bearer https://ion.example.org access-1" {
		t.Errorf("tried %s", got)
	}
	if token, _, _ := c.RefreshToken("env-3"); token != "rt-2" { //nolint:errcheck // compared below
		t.Errorf("the rotated token was not kept: %q", token)
	}
}

func TestStudioOpen_Refusals(t *testing.T) {
	c := testCatalog(t, "")
	d := &dialLog{}
	if _, err := d.studio(c).Open(context.Background(), Host{Name: "local", SSH: LocalSSH}); err == nil {
		t.Error("this machine has no Studio connection to open")
	}
	entry := Entry{Kind: EntryPaired, Label: "x", CredentialRef: "missing"}
	if _, err := d.studio(c).Open(context.Background(), Host{Name: "x", Entry: &entry}); err == nil || !strings.Contains(err.Error(), "ion fleet pair x") {
		t.Errorf("a missing pairing names the fix: %v", err)
	}
}
