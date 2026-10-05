package fleet

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/utils"
)

// A host's Studio connection, opened with the credential the device already
// holds for it: the pairing Studio made, or its sign-in. The fleet uses the
// same connection Studio does, so the server sees one device.

// Reach names, beside ViaSSH: how a Studio connection got to the host.
const (
	ViaDirect = "direct"
	ViaTunnel = "tunnel"
)

// studioDialTimeout bounds one attempt at one address.
const studioDialTimeout = 6 * time.Second

// Studio opens Studio connections to fleet hosts.
type Studio struct {
	Catalog *Catalog
	// Tokens mints relay OIDC tokens; nil when the local engine is not reachable.
	Tokens studioclient.TokenSource
	// Tunnel opens an ssh forward to a host's loopback port and returns the
	// local base URL and a closer; sshTunnel by default.
	Tunnel func(ctx context.Context, destination string, port int, remotePort string) (string, func(), error)

	// The dials, replaceable in tests.
	Paired func(ctx context.Context, base string, p studioclient.Pairing) (*studioclient.Session, error)
	Relay  func(ctx context.Context, relay studioclient.Relay, bearer string, p studioclient.Pairing) (*studioclient.Session, error)
	Bearer func(ctx context.Context, base, bearer string) (*studioclient.Session, error)
	// Refresh mints a bearer from a refresh token; studioclient.RefreshBearer by default.
	Refresh func(ctx context.Context, oidc studioclient.AuthOIDC, refreshToken string) (string, string, error)
}

// Link is an open Studio connection and how it reached the host.
type Link struct {
	*studioclient.Session
	Via   string
	close func()
}

// Close ends the connection and any forward it rode.
func (l *Link) Close() {
	l.Session.Close()
	if l.close != nil {
		l.close()
	}
}

func (s Studio) paired(ctx context.Context, base string, p studioclient.Pairing) (*studioclient.Session, error) {
	ctx, cancel := context.WithTimeout(ctx, studioDialTimeout)
	defer cancel()
	if s.Paired != nil {
		return s.Paired(ctx, base, p)
	}
	return studioclient.ConnectPaired(ctx, base, p)
}

// Open connects to the host. A paired server is tried at its own address
// and the others it said it answers at, then through an SSH forward, then
// through each relay: the relay last, because it is the slowest path.
func (s Studio) Open(ctx context.Context, h Host) (*Link, error) {
	if h.Entry == nil {
		return nil, errors.New("this machine is read directly, not over a Studio connection")
	}
	if s.Catalog == nil {
		return nil, errors.New("no environment catalog")
	}
	e := *h.Entry
	if e.Kind == EntryBearer {
		return s.openBearer(ctx, h, e)
	}
	stored, ok, err := s.Catalog.Pairing(e.CredentialKey())
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("no stored pairing (pair again with `ion fleet pair %s`)", h.Name)
	}
	return s.OpenWith(ctx, h, stored)
}

// OpenWith connects to a paired host with the pairing given, which need not
// be the one the catalog stores.
func (s Studio) OpenWith(ctx context.Context, h Host, stored StoredPairing) (*Link, error) {
	if h.Entry == nil {
		return nil, errors.New("the host has no catalog entry to reach it by")
	}
	e := *h.Entry
	var errs []error
	for _, base := range directBases(e, stored) {
		session, err := s.paired(ctx, base, stored.Pairing)
		if err == nil {
			utils.LogWithFields(utils.LevelInfo, logTag, "studio connection opened", map[string]any{"fleet_host": h.Name, "via": ViaDirect, "base": base})
			return &Link{Session: session, Via: ViaDirect}, nil
		}
		errs = append(errs, fmt.Errorf("%s: %w", base, err))
	}
	if dest, port := tunnelTarget(h, e); dest != "" {
		link, err := s.openTunnel(ctx, dest, port, entryPort(e), stored.Pairing)
		if err == nil {
			utils.LogWithFields(utils.LevelInfo, logTag, "studio connection opened", map[string]any{"fleet_host": h.Name, "via": ViaTunnel})
			return link, nil
		}
		errs = append(errs, fmt.Errorf("ssh forward: %w", err))
	}
	for _, relay := range stored.Relays {
		bearer, err := studioclient.RelayBearer(ctx, relay, s.Tokens)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", relay.URL, err))
			continue
		}
		connect := s.Relay
		if connect == nil {
			connect = studioclient.Connect
		}
		session, err := connect(ctx, relay, bearer, stored.Pairing)
		if err == nil {
			utils.LogWithFields(utils.LevelInfo, logTag, "studio connection opened", map[string]any{"fleet_host": h.Name, "via": ViaRelay, "relay_url": relay.URL})
			return &Link{Session: session, Via: ViaRelay}, nil
		}
		errs = append(errs, fmt.Errorf("%s: %w", relay.URL, err))
	}
	if len(errs) == 0 {
		return nil, errors.New("the pairing names no address, SSH target, or relay to reach the server at")
	}
	utils.LogWithFields(utils.LevelWarn, logTag, "no studio connection to the host", map[string]any{"fleet_host": h.Name, "attempts": len(errs)})
	return nil, attemptErrors(errs)
}

// attemptErrors is every way of reaching a host that failed, in the order
// tried. It reads as one line and still answers errors.Is for each cause,
// so a caller can tell "the server refused this pairing" from "nothing
// answered".
type attemptErrors []error

func (a attemptErrors) Error() string {
	parts := make([]string, len(a))
	for i, err := range a {
		parts[i] = err.Error()
	}
	return strings.Join(parts, "; ")
}

func (a attemptErrors) Unwrap() []error { return a }

// directBases are the http(s) addresses a paired server may answer at: the
// catalog's, then the ones its last welcome reported.
func directBases(e Entry, stored StoredPairing) []string {
	var out []string
	seen := map[string]bool{}
	add := func(base string) {
		base = strings.TrimSuffix(base, "/")
		if (strings.HasPrefix(base, "http://") || strings.HasPrefix(base, "https://")) && !seen[base] {
			seen[base] = true
			out = append(out, base)
		}
	}
	if e.Via != ViaSSHTunnel && e.Via != ViaRelayOnly {
		add(e.URL)
	}
	for _, addr := range stored.DirectAddresses {
		add(addr)
	}
	return out
}

// tunnelTarget is the SSH destination a forward to the host opens through:
// the entry's own SSH leg, else its deploy target.
func tunnelTarget(h Host, e Entry) (string, int) {
	if e.SSH != nil && e.SSH.Destination != "" {
		return e.SSH.Destination, e.SSH.Port
	}
	if h.SSH != "" && h.SSH != LocalSSH {
		return h.SSH, 0
	}
	return "", 0
}

func (s Studio) openTunnel(ctx context.Context, destination string, port int, remotePort string, p studioclient.Pairing) (*Link, error) {
	tunnel := s.Tunnel
	if tunnel == nil {
		tunnel = sshTunnel
	}
	base, closeTunnel, err := tunnel(ctx, destination, port, remotePort)
	if err != nil {
		return nil, err
	}
	session, err := s.paired(ctx, base, p)
	if err != nil {
		closeTunnel()
		return nil, err
	}
	return &Link{Session: session, Via: ViaTunnel, close: closeTunnel}, nil
}

// openBearer signs in with the stored refresh token and keeps the one the
// issuer rotated to.
func (s Studio) openBearer(ctx context.Context, h Host, e Entry) (*Link, error) {
	if e.OIDC == nil {
		return nil, errors.New("the catalog entry names no sign-in")
	}
	key := e.CredentialKey()
	token, ok, err := s.Catalog.RefreshToken(key)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("not signed in (sign in with `ion fleet pair %s`, or in Studio)", h.Name)
	}
	refresh := s.Refresh
	if refresh == nil {
		refresh = studioclient.RefreshBearer
	}
	access, kept, err := refresh(ctx, studioclient.AuthOIDC{Issuer: e.OIDC.Issuer, Audience: e.OIDC.Audience, Scope: e.OIDC.Scope, ClientID: e.OIDC.ClientID}, token)
	if err != nil {
		return nil, err
	}
	if kept != "" && kept != token {
		if err := s.Catalog.PutRefreshToken(key, kept); err != nil {
			utils.LogWithFields(utils.LevelWarn, logTag, "could not keep a rotated refresh token", map[string]any{"fleet_host": h.Name, "error": err.Error()})
		}
	}
	connect := s.Bearer
	if connect == nil {
		connect = studioclient.ConnectDirect
	}
	dialCtx, cancel := context.WithTimeout(ctx, studioDialTimeout)
	defer cancel()
	session, err := connect(dialCtx, e.URL, access)
	if err != nil {
		return nil, err
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "studio connection opened", map[string]any{"fleet_host": h.Name, "via": ViaHTTPS})
	return &Link{Session: session, Via: ViaHTTPS}, nil
}
