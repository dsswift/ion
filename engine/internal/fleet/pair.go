package fleet

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/utils"
)

// pairScopes is what the fleet asks for: it only reads.
const pairScopes = "conversations:read"

// Pairer pairs the fleet with a host so its status can be read through the
// relay when SSH cannot reach it.
type Pairer struct {
	Runner   Runner
	Pairings *Pairings
	Tokens   studioclient.TokenSource
	// Tunnel opens an ssh forward to the host's loopback port and returns the
	// local base URL and a closer; sshTunnel by default.
	Tunnel func(ctx context.Context, h Host, remotePort string) (string, func(), error)
}

type mintedLink struct {
	URL string `json:"url"`
}

// Pair mints a read-only pairing link on the host over SSH and redeems it:
// at the link's address, else through an SSH forward to the host's own
// loopback, else on the link's relay pairing channel.
func (p Pairer) Pair(ctx context.Context, h Host) (studioclient.Pairing, error) {
	label := "ion fleet on " + shortHostname()
	args := []string{"studio", "pair", "--json", "--scopes", pairScopes, "--label", label}
	out, err := runIon(ctx, p.Runner, h, append(append([]string{}, args...), "--relay"), nil)
	if err != nil {
		// A server with no relay configured refuses a relay channel; pair
		// without one, since SSH is still available now.
		utils.LogWithFields(utils.LevelInfo, logTag, "pairing link with a relay channel refused; minting without", map[string]any{"fleet_host": h.Name, "error": err.Error()})
		out, err = runIon(ctx, p.Runner, h, args, nil)
	}
	if err != nil {
		return studioclient.Pairing{}, fmt.Errorf("mint a pairing link on %s: %w", h.Name, err)
	}
	var minted mintedLink
	if err := json.Unmarshal(lastLine(out), &minted); err != nil || minted.URL == "" {
		return studioclient.Pairing{}, fmt.Errorf("the pairing command on %s printed no link", h.Name)
	}
	link, err := studioclient.ParsePairingLink(minted.URL)
	if err != nil {
		return studioclient.Pairing{}, err
	}
	deviceID, err := fleetDeviceID()
	if err != nil {
		return studioclient.Pairing{}, err
	}
	req, kp, err := studioclient.NewPairRequest(link.Code, label, deviceID)
	if err != nil {
		return studioclient.Pairing{}, err
	}
	var errs []string
	pairing, err := studioclient.PairOverHTTP(ctx, link.URL, req, kp)
	if err != nil {
		errs = append(errs, err.Error())
		pairing, err = p.pairThroughTunnel(ctx, h, link, req, kp)
	}
	if err != nil {
		errs = append(errs, err.Error())
		if link.Relay != nil {
			pairing, err = p.pairOverRelay(ctx, link, req, kp)
		}
	}
	if err != nil {
		errs = append(errs, err.Error())
		return studioclient.Pairing{}, fmt.Errorf("pair with %s: %s", h.Name, strings.Join(errs, "; "))
	}
	if err := p.Pairings.Put(h.Name, pairing); err != nil {
		return pairing, err
	}
	return pairing, nil
}

func (p Pairer) pairThroughTunnel(ctx context.Context, h Host, link studioclient.PairingLink, req studioclient.PairRequest, kp studioclient.KeyPair) (studioclient.Pairing, error) {
	if h.SSH == LocalSSH {
		return studioclient.Pairing{}, errors.New("a local host has no tunnel to open")
	}
	u, err := url.Parse(link.URL)
	if err != nil {
		return studioclient.Pairing{}, err
	}
	port := u.Port()
	if port == "" {
		port = "7331"
	}
	tunnel := p.Tunnel
	if tunnel == nil {
		tunnel = sshTunnel
	}
	base, closeTunnel, err := tunnel(ctx, h, port)
	if err != nil {
		return studioclient.Pairing{}, err
	}
	defer closeTunnel()
	utils.LogWithFields(utils.LevelInfo, logTag, "pairing through an ssh forward", map[string]any{"fleet_host": h.Name, "remote_port": port})
	return studioclient.PairOverHTTP(ctx, base, req, kp)
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
	return studioclient.PairOverRelay(ctx, *link.Relay, bearer, req, kp)
}

// sshTunnel forwards a free local port to the host's 127.0.0.1:<remotePort>.
func sshTunnel(ctx context.Context, h Host, remotePort string) (string, func(), error) {
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
	cmd := exec.CommandContext(ctx, "ssh", append(append([]string{}, sshArgs...), "-N", "-o", "ExitOnForwardFailure=yes", "-L", fmt.Sprintf("%d:127.0.0.1:%s", local, remotePort), h.SSH)...)
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
	return "", nil, fmt.Errorf("the ssh forward to %s did not open", h.SSH)
}

// fleetDeviceID is this Mac's stable id as a fleet client, so a re-pair
// replaces its earlier record on the host instead of adding another.
func fleetDeviceID() (string, error) {
	path := filepath.Join(StateDir(), "device-id")
	if data, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(data))) > 0 {
		return strings.TrimSpace(string(data)), nil
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	id := "fleet-" + hex.EncodeToString(b)
	if err := os.MkdirAll(StateDir(), 0o700); err != nil {
		return "", err
	}
	if err := utils.AtomicWriteFile(path, []byte(id+"\n"), 0o600); err != nil {
		return "", err
	}
	return id, nil
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
