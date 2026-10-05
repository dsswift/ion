package studioclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/coder/websocket"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studiostatus"
	"github.com/dsswift/ion/engine/internal/utils"
)

// A server reached at its own address, as a deployment behind an ingress
// is: its public endpoints, and a Studio connection signed in with a bearer
// token. The TLS of the address protects the connection; nothing is sealed.

// AuthOIDC is the sign-in a server accepts for a bearer, from /auth/config.
type AuthOIDC struct {
	Issuer   string `json:"issuer"`
	Audience string `json:"audience"`
	Scope    string `json:"scope"`
	ClientID string `json:"clientId"`
}

// AuthConfig is the part of a server's unauthenticated /auth/config a
// reader uses.
type AuthConfig struct {
	OIDC          *AuthOIDC `json:"oidc"`
	EnvironmentID string    `json:"environmentId"`
	Label         string    `json:"label"`
	ServerVersion string    `json:"serverVersion"`
}

// Public is what a server answers without a sign-in: who it is, whether it
// is ready, and the versions and formats it runs.
type Public struct {
	Auth     AuthConfig
	Ready    bool
	Versionz Versionz
}

// Versionz is a server's unauthenticated /versionz.
type Versionz struct {
	ServerVersion    string          `json:"serverVersion"`
	EngineVersion    *string         `json:"engineVersion"`
	EngineMinVersion string          `json:"engineMinVersion"`
	EngineMeetsMin   *bool           `json:"engineMeetsMin"`
	Formats          []compat.Format `json:"formats"`
}

// ReadPublic reads a server's /auth/config, /versionz, and /readyz.
func ReadPublic(ctx context.Context, base string) (Public, error) {
	var p Public
	base = strings.TrimSuffix(base, "/")
	if err := getJSON(ctx, base+"/auth/config", &p.Auth); err != nil {
		return p, err
	}
	if err := getJSON(ctx, base+"/versionz", &p.Versionz); err != nil {
		return p, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/readyz", nil)
	if err != nil {
		return p, err
	}
	if resp, err := httpClient.Do(req); err == nil {
		resp.Body.Close() //nolint:errcheck // status is all that is read
		p.Ready = resp.StatusCode == http.StatusOK
	}
	return p, nil
}

func getJSON(ctx context.Context, u string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("GET %s: %w", u, err)
	}
	defer resp.Body.Close() //nolint:errcheck // response body close after full read
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: HTTP %d", u, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out)
}

// studioURL is the Studio wire address under a server's base URL.
func studioURL(base string) (string, error) {
	u, err := url.Parse(strings.TrimSuffix(base, "/"))
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("%s: the address must be http or https", base)
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/studio"
	return u.String(), nil
}

// ConnectDirect opens a Studio connection at the server's address with a
// bearer token, in the thin view, and waits for the welcome.
func ConnectDirect(ctx context.Context, base, bearer string) (*Session, error) {
	wsURL, err := studioURL(base)
	if err != nil {
		return nil, err
	}
	conn, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + bearer}}})
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		utils.LogWithFields(utils.LevelWarn, logTag, "direct studio connection failed", map[string]any{"url": wsURL, "http_status": status, "error": err.Error()})
		return nil, fmt.Errorf("connect to %s: %w", wsURL, err)
	}
	conn.SetReadLimit(16 << 20)
	s := &Session{conn: conn}
	hello := map[string]any{
		"type": "studio_hello", "protocolVersion": studioProtocolVersion, "clientId": helloClientID(),
		"clientKind": "desktop", "capabilities": []string{}, "view": "thin",
		"credential": map[string]any{"kind": "bearer", "token": bearer},
	}
	if err := s.handshake(ctx, hello, wsURL); err != nil {
		return nil, err
	}
	return s, nil
}

// ReadDirectStatus signs in at the server's address, reads what a relay read
// reads, and closes.
func ReadDirectStatus(ctx context.Context, base, bearer string) (Status, error) {
	ctx, cancel := context.WithTimeout(ctx, ReadTimeout)
	defer cancel()
	s, err := ConnectDirect(ctx, base, bearer)
	if err != nil {
		return Status{}, err
	}
	defer s.Close()
	return ReadSession(ctx, s, base)
}

// Report is a public read as the report `ion studio status` prints: the
// server's versions, readiness, and formats. What only a signed-in reader
// sees is named in Problems.
func (p Public) Report(problem string) studiostatus.Report {
	v := p.Versionz
	r := studiostatus.Report{
		SchemaVersion: compat.StatusReportVersion,
		Ready:         p.Ready,
		Services:      []studiostatus.Service{},
		Relays:        []string{},
		Kind:          studiostatus.KindServer,
		Components:    studiostatus.Components{StudioServer: &studiostatus.ServerBundle{Version: v.ServerVersion}},
		Engine:        studiostatus.Engine{MinVersion: v.EngineMinVersion, MeetsMin: v.EngineMeetsMin},
		Formats:       studiostatus.MergeFormats(nil, v.Formats),
		Problems:      []string{problem},
	}
	if v.EngineVersion != nil && *v.EngineVersion != "" {
		r.Engine.Running, r.Engine.Version = true, *v.EngineVersion
		r.Components.StudioServer.EngineVersion = *v.EngineVersion
	}
	return r
}
