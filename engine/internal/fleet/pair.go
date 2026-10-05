package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/utils"
)

// pairScopes is what the device asks for: every scope Studio's own pairing
// holds, because this pairing is the one Studio uses too.
const pairScopes = "conversations:read,conversations:operate,terminal:operate,git:write,admin"

// Pairer pairs this device with a host over SSH and records the server in
// the Environment catalog, where Studio finds it.
type Pairer struct {
	Runner  Runner
	Catalog *Catalog
	Tokens  studioclient.TokenSource
	// Tunnel opens an ssh forward to the host's loopback port and returns the
	// local base URL and a closer; sshTunnel by default.
	Tunnel func(ctx context.Context, destination string, port int, remotePort string) (string, func(), error)
	// The pairing exchanges, replaceable in tests.
	OverHTTP  func(ctx context.Context, base string, req studioclient.PairRequest, kp studioclient.KeyPair) (studioclient.Pairing, error)
	OverRelay func(ctx context.Context, relay studioclient.PairingRelay, bearer string, req studioclient.PairRequest, kp studioclient.KeyPair) (studioclient.Pairing, error)
	// EnvironmentID reads the id of the server at base; from its /auth/config by default.
	EnvironmentID func(ctx context.Context, base string) (string, error)
}

type mintedLink struct {
	URL string `json:"url"`
}

// Paired is a completed pairing: the secret, and how the server was reached
// to make it.
type Paired struct {
	Pairing studioclient.Pairing
	// Via is ViaLAN (the link's own address answered), ViaSSHTunnel, or
	// ViaRelayOnly.
	Via string
	// URL is the server's address as the catalog records it for Via.
	URL string
	// RemotePort is the server's port on the host.
	RemotePort int
	// EnvironmentID is the server's own id, when it could be read.
	EnvironmentID string
	// Label is the name the server gave itself in the link.
	Label string
}

func (p Pairer) overHTTP(ctx context.Context, base string, req studioclient.PairRequest, kp studioclient.KeyPair) (studioclient.Pairing, error) {
	if p.OverHTTP != nil {
		return p.OverHTTP(ctx, base, req, kp)
	}
	return studioclient.PairOverHTTP(ctx, base, req, kp)
}

func (p Pairer) environmentID(ctx context.Context, base string) string {
	read := p.EnvironmentID
	if read == nil {
		read = func(ctx context.Context, base string) (string, error) {
			pub, err := studioclient.ReadPublic(ctx, base)
			return pub.Auth.EnvironmentID, err
		}
	}
	id, err := read(ctx, base)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, logTag, "environment id not read at pairing", map[string]any{"base": base, "error": err.Error()})
	}
	return id
}

// Pair mints a pairing link on the host over SSH and redeems it as this
// device: at the link's address, else through an SSH forward to the host's
// own loopback, else on the link's relay pairing channel. The device id and
// label are Studio's, so the server keeps one pairing for this device.
func (p Pairer) Pair(ctx context.Context, h Host) (Paired, error) {
	if h.External() {
		return Paired{}, h.ErrExternal()
	}
	label := "desktop " + shortHostname()
	args := []string{"studio", "pair", "--json", "--scopes", pairScopes, "--label", label}
	out, err := runIon(ctx, p.Runner, h, append(append([]string{}, args...), "--relay"), nil)
	if err != nil {
		// A server with no relay configured refuses a relay channel; pair
		// without one, since SSH is still available now.
		utils.LogWithFields(utils.LevelInfo, logTag, "pairing link with a relay channel refused; minting without", map[string]any{"fleet_host": h.Name, "error": err.Error()})
		out, err = runIon(ctx, p.Runner, h, args, nil)
	}
	if err != nil {
		return Paired{}, fmt.Errorf("mint a pairing link on %s: %w", h.Name, err)
	}
	var minted mintedLink
	if err := json.Unmarshal(lastLine(out), &minted); err != nil || minted.URL == "" {
		return Paired{}, fmt.Errorf("the pairing command on %s printed no link", h.Name)
	}
	link, err := studioclient.ParsePairingLink(minted.URL)
	if err != nil {
		return Paired{}, err
	}
	deviceID, err := p.Catalog.DeviceID()
	if err != nil {
		return Paired{}, err
	}
	req, kp, err := studioclient.NewPairRequest(link.Code, label, deviceID)
	if err != nil {
		return Paired{}, err
	}
	port := linkPort(link.URL)
	done := Paired{Label: link.Label, RemotePort: port}
	var errs []string
	if done.Pairing, err = p.overHTTP(ctx, link.URL, req, kp); err == nil {
		done.Via, done.URL = ViaLAN, link.URL
		done.EnvironmentID = p.environmentID(ctx, link.URL)
	} else {
		errs = append(errs, err.Error())
		if done.Pairing, done.EnvironmentID, err = p.pairThroughTunnel(ctx, h, port, req, kp); err == nil {
			done.Via, done.URL = ViaSSHTunnel, "http://127.0.0.1:"+strconv.Itoa(port)
		}
	}
	if err != nil {
		errs = append(errs, err.Error())
		if link.Relay != nil {
			if done.Pairing, err = p.pairOverRelay(ctx, link, req, kp); err == nil {
				done.Via, done.URL = ViaRelayOnly, link.URL
			}
		}
	}
	if err != nil {
		errs = append(errs, err.Error())
		return Paired{}, fmt.Errorf("pair with %s: %s", h.Name, strings.Join(errs, "; "))
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "paired with host", map[string]any{"fleet_host": h.Name, "via": done.Via, "client_id": done.Pairing.ClientID, "relay_count": len(done.Pairing.Relays), "environment_id": done.EnvironmentID})
	return done, nil
}

// linkPort is the server port a pairing link's address names.
func linkPort(base string) int {
	if u, err := url.Parse(base); err == nil {
		if n, err := strconv.Atoi(u.Port()); err == nil {
			return n
		}
	}
	return 7331
}

// Entry is the catalog entry of a completed pairing, named label, and the
// key its secret is stored under.
func (d Paired) Entry(label string, h Host) Entry {
	e := Entry{Kind: EntryPaired, Label: label, URL: d.URL, Via: d.Via, EnvironmentID: d.EnvironmentID}
	e.CredentialRef = d.EnvironmentID
	if e.CredentialRef == "" {
		e.CredentialRef = d.Pairing.ClientID
	}
	for _, r := range d.Pairing.Relays {
		e.RelayURLs = append(e.RelayURLs, r.URL)
	}
	if d.Via == ViaSSHTunnel {
		e.SSH = &SSHLeg{Destination: h.SSH, RemotePort: d.RemotePort}
	}
	return e
}

func (p Pairer) pairThroughTunnel(ctx context.Context, h Host, port int, req studioclient.PairRequest, kp studioclient.KeyPair) (studioclient.Pairing, string, error) {
	if h.SSH == LocalSSH {
		return studioclient.Pairing{}, "", errors.New("a local host has no tunnel to open")
	}
	tunnel := p.Tunnel
	if tunnel == nil {
		tunnel = sshTunnel
	}
	base, closeTunnel, err := tunnel(ctx, h.SSH, 0, strconv.Itoa(port))
	if err != nil {
		return studioclient.Pairing{}, "", err
	}
	defer closeTunnel()
	utils.LogWithFields(utils.LevelInfo, logTag, "pairing through an ssh forward", map[string]any{"fleet_host": h.Name, "remote_port": port})
	pairing, err := p.overHTTP(ctx, base, req, kp)
	if err != nil {
		return pairing, "", err
	}
	return pairing, p.environmentID(ctx, base), nil
}

func (p Pairer) pairOverRelay(ctx context.Context, link studioclient.PairingLink, req studioclient.PairRequest, kp studioclient.KeyPair) (studioclient.Pairing, error) {
	bearer := link.Relay.Key
	if bearer == "" {
		var err error
		bearer, err = studioclient.RelayBearer(ctx, studioclient.Relay{URL: link.Relay.URL, Auth: studioclient.RelayAuth{Mode: "relay-oidc"}}, p.Tokens)
		if err != nil {
			return studioclient.Pairing{}, err
		}
	}
	if p.OverRelay != nil {
		return p.OverRelay(ctx, *link.Relay, bearer, req, kp)
	}
	return studioclient.PairOverRelay(ctx, *link.Relay, bearer, req, kp)
}

// sshTunnel forwards a free local port to the destination's
// 127.0.0.1:<remotePort>. port is the SSH port when it is not the default.
func sshTunnel(ctx context.Context, destination string, port int, remotePort string) (string, func(), error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	addrInfo, ok := ln.Addr().(*net.TCPAddr)
	ln.Close() //nolint:errcheck // freed so ssh can bind it
	if !ok {
		return "", nil, errors.New("could not pick a local port for the ssh forward")
	}
	local := addrInfo.Port
	args := append(append([]string{}, sshArgs...), "-N", "-o", "ExitOnForwardFailure=yes", "-L", fmt.Sprintf("%d:127.0.0.1:%s", local, remotePort))
	if port > 0 {
		args = append(args, "-p", strconv.Itoa(port))
	}
	cmd := exec.CommandContext(ctx, "ssh", append(args, destination)...)
	if err := cmd.Start(); err != nil {
		return "", nil, fmt.Errorf("start ssh forward: %w", err)
	}
	stop := func() {
		cmd.Process.Kill() //nolint:errcheck // the forward is done either way
		cmd.Wait()         //nolint:errcheck // reaped; its exit status is the kill
	}
	addr := fmt.Sprintf("127.0.0.1:%d", local)
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		if c, err := net.DialTimeout("tcp", addr, 500*time.Millisecond); err == nil {
			c.Close() //nolint:errcheck // probe connection
			return "http://" + addr, stop, nil
		}
	}
	stop()
	return "", nil, fmt.Errorf("the ssh forward to %s did not open", destination)
}

func shortHostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "this Mac"
	}
	return strings.Split(h, ".")[0]
}

func lastLine(out []byte) []byte {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	return []byte(lines[len(lines)-1])
}
