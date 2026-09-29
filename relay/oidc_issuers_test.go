package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"
)

// twoTenantAuth builds an auth middleware accepting two issuers, each with
// its own signing key, audience, and scope, the way a relay serving one
// person signed in to two identity tenants is configured.
type tenantFixture struct {
	issuer string
	token  func(t *testing.T, mutate func(jwt.MapClaims)) string
}

func newTenant(t *testing.T, audience, subject string) (*OIDCConfig, tenantFixture) {
	t.Helper()
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)
	cfg, err := NewOIDCConfig(srv.URL, audience, "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}
	return cfg, tenantFixture{
		issuer: srv.URL,
		token: func(t *testing.T, mutate func(jwt.MapClaims)) string {
			claims := standardClaims(srv.URL, audience)
			claims["oid"] = subject
			if mutate != nil {
				mutate(claims)
			}
			return makeJWT(t, key, claims)
		},
	}
}

func TestParseOIDCIssuerSpecs(t *testing.T) {
	specs, err := parseOIDCIssuerSpecs("https://a.example", "aud-a", "Relay.Access",
		`[{"issuer":"https://b.example","audience":"aud-b"}]`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(specs) != 2 || specs[0].Issuer != "https://a.example" || specs[1].Audience != "aud-b" {
		t.Fatalf("specs = %+v, want the single-issuer entry first then the listed one", specs)
	}

	only, err := parseOIDCIssuerSpecs("", "", "", `[{"issuer":"https://b.example","audience":"aud-b"}]`)
	if err != nil || len(only) != 1 {
		t.Fatalf("a list with no single-issuer variables must stand alone: %+v, %v", only, err)
	}

	for name, list := range map[string]string{
		"not json":    `nope`,
		"no audience": `[{"issuer":"https://b.example"}]`,
		"no issuer":   `[{"audience":"aud-b"}]`,
		"duplicate":   `[{"issuer":"https://a.example","audience":"aud-a"}]`,
	} {
		if _, err := parseOIDCIssuerSpecs("https://a.example", "aud-a", "", list); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

// A token from either configured tenant authenticates, each against its own
// audience; the second tenant's token was refused before there was a list.
func TestAuthMiddleware_AcceptsEveryConfiguredIssuer(t *testing.T) {
	home, homeTenant := newTenant(t, "aud-home", "oid-home")
	work, workTenant := newTenant(t, "aud-work", "oid-work")
	auth := NewAuthMiddleware("", home, work)

	for name, tc := range map[string]struct {
		token    string
		subject  string
		ownerKey string
	}{
		"primary":   {homeTenant.token(t, nil), "oid-home", "oid-home"},
		"secondary": {workTenant.token(t, nil), "oid-work", workTenant.issuer + "|oid-work"},
	} {
		identity, reason := auth.ValidateDetailed(newBearerRequest(t, tc.token))
		if reason != "" {
			t.Fatalf("%s: refused with %q", name, reason)
		}
		if identity.Subject != tc.subject || identity.OwnerKey != tc.ownerKey {
			t.Errorf("%s: identity = %+v, want subject %q owner key %q", name, identity, tc.subject, tc.ownerKey)
		}
	}

	// The single-issuer relay this replaces refuses the work tenant.
	if _, reason := NewAuthMiddleware("", home).ValidateDetailed(newBearerRequest(t, workTenant.token(t, nil))); reason != authFailureJWTValidation {
		t.Errorf("single-issuer relay accepted a second tenant: reason %q", reason)
	}
}

// Each issuer's audience binds only its own tokens: a work token minted for
// the home audience is refused, and so is one naming an unconfigured issuer.
func TestAuthMiddleware_IssuerAudiencesDoNotCross(t *testing.T) {
	home, _ := newTenant(t, "aud-home", "oid-home")
	work, workTenant := newTenant(t, "aud-work", "oid-work")
	_, stranger := newTenant(t, "aud-home", "oid-stranger")
	auth := NewAuthMiddleware("", home, work)

	crossed := workTenant.token(t, func(c jwt.MapClaims) { c["aud"] = "aud-home" })
	if _, reason := auth.ValidateDetailed(newBearerRequest(t, crossed)); reason != authFailureJWTValidation {
		t.Errorf("work token for the home audience: reason %q, want refusal", reason)
	}
	if _, reason := auth.ValidateDetailed(newBearerRequest(t, stranger.token(t, nil))); reason != authFailureJWTValidation {
		t.Errorf("unconfigured issuer: reason %q, want refusal", reason)
	}
}

func TestAuthConfigEndpoint_ListsEveryIssuer(t *testing.T) {
	home, homeTenant := newTenant(t, "aud-home", "oid-home")
	work, workTenant := newTenant(t, "aud-work", "oid-work")
	server, _ := startRoutedTestRelay(t, NewAuthMiddleware("", home, work), "")

	resp, err := http.Get(server.URL + "/v1/auth/config")
	if err != nil {
		t.Fatalf("GET auth config: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck // test
	var body struct {
		Issuer   string           `json:"issuer"`
		Audience string           `json:"audience"`
		Issuers  []OIDCIssuerSpec `json:"issuers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Issuer != homeTenant.issuer || body.Audience != "aud-home" {
		t.Errorf("top-level issuer = %q/%q, want the primary", body.Issuer, body.Audience)
	}
	if len(body.Issuers) != 2 || body.Issuers[1].Issuer != workTenant.issuer || body.Issuers[1].Audience != "aud-work" {
		t.Errorf("issuers = %+v, want both tenants in order", body.Issuers)
	}
}

// The whole cross-tenant path: the host joins as ion with a work-tenant
// token and owns the channel; the person's other laptop is signed in to the
// home tenant, so its subject differs. Without an announcement the relay
// refuses it as a second owner. Announced with the joiner's issuer and
// subject it is admitted, and anyone else from that tenant still is not.
func TestCrossTenantJoin_AnnouncedSubjectAdmitted(t *testing.T) {
	home, homeTenant := newTenant(t, "aud-home", "oid-home")
	work, workTenant := newTenant(t, "aud-work", "oid-work")
	server, _ := startRoutedTestRelay(t, NewAuthMiddleware("", home, work), "")

	dialIonWithAnnounce(t, server, "chan-plain", workTenant.token(t, nil), map[string]any{"type": "not_an_announce"})
	if _, resp, err := dialMobileWithBearer(t, server, "chan-plain", homeTenant.token(t, nil)); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("unannounced cross-tenant join: err=%v resp=%v, want 403 (owned by the host's subject)", err, resp)
	}

	ion := dialIonWithAnnounce(t, server, "chan-cross", workTenant.token(t, nil), map[string]any{
		"type":  "relay_announce",
		"trust": map[string]any{"issuer": homeTenant.issuer, "audience": "aud-home", "subject": "oid-home"},
	})

	other := homeTenant.token(t, func(c jwt.MapClaims) { c["oid"] = "oid-someone-else" })
	if _, resp, err := dialMobileWithBearer(t, server, "chan-cross", other); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("another subject of the announced tenant: err=%v resp=%v, want 403", err, resp)
	}

	joiner, _, err := dialMobileWithBearer(t, server, "chan-cross", homeTenant.token(t, nil))
	if err != nil {
		t.Fatalf("announced cross-tenant join refused: %v", err)
	}
	ion.Write(context.Background(), websocket.MessageText, []byte(`{"msg":"hi"}`)) //nolint:errcheck // test
	if got := string(readExpected(t, joiner, "mobile")); got != `{"msg":"hi"}` {
		t.Errorf("joiner got %s", got)
	}
}

// A configured issuer is trusted for announcement without a second listing,
// and the registry reports it, which is what the startup log states.
func TestOIDCRegistry_TrustedIssuersIncludesConfiguredOnes(t *testing.T) {
	home, homeTenant := newTenant(t, "aud-home", "oid-home")
	registry := NewOIDCRegistry("https://listed.example")
	if got := registry.TrustedIssuers(); len(got) != 1 || got[0] != "https://listed.example" {
		t.Fatalf("before Trust: %v", got)
	}
	registry.Trust(home)
	got := registry.TrustedIssuers()
	if len(got) != 2 || (got[0] != homeTenant.issuer && got[1] != homeTenant.issuer) {
		t.Errorf("after Trust: %v, want the configured issuer added", got)
	}
}
