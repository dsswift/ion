package fleet

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/studiostatus"
)

var orion = Host{Name: "orion", URL: "https://orion.example.org", Kind: KindServer}

type memSignIns map[string]studioclient.SignIn

func (m memSignIns) GetSignIn(host string) (studioclient.SignIn, bool, error) {
	s, ok := m[host]
	return s, ok, nil
}

func (m memSignIns) PutSignIn(host string, s studioclient.SignIn) error {
	m[host] = s
	return nil
}

func publicOrion(context.Context, string) (studioclient.Public, error) {
	engine := "1.85.3"
	return studioclient.Public{Ready: true, Auth: studioclient.AuthConfig{Label: "Orion Beta"},
		Versionz: studioclient.Versionz{ServerVersion: "0.1.0", EngineVersion: &engine,
			Formats: []compat.Format{{ID: "transfer-archive", Owner: "server", Version: "3", Rule: compat.RuleExact}}}}, nil
}

func TestConfig_ExternalHosts(t *testing.T) {
	ok := Config{Hosts: []Host{orion}}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, h := range map[string]Host{
		"both":       {Name: "x", SSH: "x", URL: "https://x", Kind: KindServer},
		"neither":    {Name: "x", Kind: KindServer},
		"not a url":  {Name: "x", URL: "orion.example.org", Kind: KindServer},
		"no desktop": {Name: "x", URL: "https://x", Kind: KindDesktop},
	} {
		if err := (Config{Hosts: []Host{h}}).Validate(); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
}

// With its own sign-in the fleet reads everything; the refresh token the
// issuer rotates is kept for the next read.
func TestCollect_ExternalSignedIn(t *testing.T) {
	signIns := memSignIns{"orion": {RefreshToken: "rt-1"}}
	var bearer string
	c := Collector{SignIns: signIns, External: ExternalReader{
		Public: publicOrion,
		Refresh: func(_ context.Context, s studioclient.SignIn) (string, studioclient.SignIn, error) {
			s.RefreshToken = "rt-2"
			return "at-1", s, nil
		},
		Status: func(_ context.Context, base, b string) (studioclient.Status, error) {
			bearer = b
			n := 2
			return studioclient.Status{Info: studioclient.ServerInfo{ServerVersion: "0.1.0", Hostname: "orion-0", RunningConversations: &n}, Devices: []studiostatus.PairedDevice{{ClientID: "p", Connected: true}}}, nil
		},
	}}
	st := c.One(context.Background(), orion)
	if st.Via != ViaHTTPS || st.Report == nil || bearer != "at-1" || !st.Report.Ready || *st.Report.RunningConversations != 2 || DevicesCell(st.Report) != "1 · 1 on" {
		t.Fatalf("status = %+v bearer %q", st, bearer)
	}
	if signIns["orion"].RefreshToken != "rt-2" {
		t.Error("a rotated refresh token must be kept")
	}
	if flags := HostFlags(st); len(flags) != 0 {
		t.Errorf("a signed-in read raises no flag: %v", flags)
	}
}

// Without a sign-in, or when it stopped working, the fleet still reads the
// versions and formats, and says why the rest is blank.
func TestCollect_ExternalPublicOnly(t *testing.T) {
	c := Collector{SignIns: memSignIns{}, External: ExternalReader{Public: publicOrion}}
	st := c.One(context.Background(), orion)
	if st.Via != ViaHTTPS || ServerCell(st.Report) != "0.1.0" || EngineCell(st.Report) != "1.85.3" || FormatCell(st.Report, TransferFormat) != "3" || st.Report.Hostname != "Orion Beta" {
		t.Fatalf("status = %+v", st.Report)
	}
	if flags := HostFlags(st); len(flags) != 1 || !strings.Contains(flags[0], "not signed in (run `ion fleet pair orion`)") {
		t.Errorf("flags = %v", flags)
	}
	c.SignIns = memSignIns{"orion": {RefreshToken: "spent"}}
	c.External.Refresh = func(_ context.Context, s studioclient.SignIn) (string, studioclient.SignIn, error) {
		return "", s, errors.New("the sign-in no longer works; sign in again")
	}
	if flags := HostFlags(c.One(context.Background(), orion)); len(flags) != 1 || !strings.Contains(flags[0], "sign in again") {
		t.Errorf("flags = %v", flags)
	}
	c.External.Public = func(context.Context, string) (studioclient.Public, error) {
		return studioclient.Public{}, errors.New("GET /auth/config: HTTP 502")
	}
	if st := c.One(context.Background(), orion); st.Via != ViaNone || !strings.Contains(st.Error, "502") {
		t.Errorf("an unreachable external host = %+v", st)
	}
}

// The fleet changes nothing on a host deployed outside it.
func TestExternalHosts_AreReadOnly(t *testing.T) {
	r := &fakeRunner{answer: func(Host, string, string) ([]byte, []byte, error) { return nil, nil, nil }}
	for name, err := range map[string]error{
		"restart":   Restart(context.Background(), r, orion),
		"relay set": SetRelay(context.Background(), r, orion, Profile{Relay: "wss://r", RelayOIDC: true}),
	} {
		if err == nil || !strings.Contains(err.Error(), "deployed outside the fleet") {
			t.Errorf("%s: %v", name, err)
		}
	}
	if len(r.scripts) != 0 {
		t.Errorf("nothing may run: %v", r.scripts)
	}
	_, d := newDeployFixture(t, Config{Hosts: []Host{orion}})
	if _, err := d.Prepare(context.Background(), Request{Hosts: []Host{orion}, Source: SourceRelease}); err == nil || !strings.Contains(err.Error(), "change it where it is deployed") {
		t.Errorf("deploy: %v", err)
	}
}
