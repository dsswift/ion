package fleet

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// InstallOptions are what one install does besides putting the artifact on
// the host.
type InstallOptions struct {
	// QuitIon quits a running desktop first. Without it a running desktop
	// stops the install before anything is copied: its installer will not
	// replace a live app.
	QuitIon bool
	// AskSudo runs a Mac's installer on this terminal so sudo can ask for a
	// password. Interactive says this process has a terminal to ask on.
	AskSudo     bool
	Interactive bool
	// SudoHint is the remedy named when a Mac's sudo would ask for a password
	// and AskSudo is off.
	SudoHint string
	// Backup copies the host's ~/.ion aside first, and checks the copy.
	Backup bool
	// Open makes sure the desktop runs afterwards.
	Open bool
	// Pair mints a pairing link with this label once the host's server is
	// up; empty mints none.
	Pair string
	// OnStep hears each step as it starts, for a live view.
	OnStep func(step string)

	// Relay puts the host on this relay; RelayOIDC when the relay signs the
	// host's operator in, else RelayKey is its pre-shared key. The key only
	// ever travels on ssh's stdin.
	Relay     string
	RelayOIDC bool
	RelayKey  string

	// A first Studio Server install's server.json: label, pairing advertise
	// URL, tenancy mode, and macOS system LaunchDaemons.
	Label     string
	Advertise string
	Tenancy   string
	System    bool
}

// Receipt is what an install reports. A desktop install fills the desktop
// fields; a server install carries the installer's own receipt.
type Receipt struct {
	OK           bool   `json:"ok"`
	Host         string `json:"host"`
	Version      string `json:"version"`
	Archs        string `json:"archs"`
	WasRunning   bool   `json:"wasRunning"`
	Opened       bool   `json:"opened"`
	Backup       string `json:"backup"`
	Relay        string `json:"relay"`
	RelayApplied bool   `json:"relayApplied"`
	PairingLink  string `json:"pairingLink"`
	// Install is the Studio Server installer's receipt.
	Install map[string]any `json:"install,omitempty"`
}

// installLog is one install's log: the steps a person reads, and the
// structured log line for each.
type installLog struct {
	w      io.Writer
	host   string
	onStep func(string)
	// prev is the step in progress, shared by every copy of the log, so each
	// step's log line says how long the one before it took.
	prev *stepMark
}

type stepMark struct {
	name string
	at   time.Time
}

func newInstallLog(w io.Writer, host string, o InstallOptions) installLog {
	return installLog{w: w, host: host, onStep: o.OnStep, prev: &stepMark{}}
}

func (l installLog) step(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintf(l.w, "\n==> %s\n", msg) //nolint:errcheck // a log file; the install's own result is what is reported
	fields := map[string]any{"fleet_host": l.host, "step": msg}
	if l.prev != nil {
		if l.prev.name != "" {
			fields["previous_step"] = l.prev.name
			fields["previous_step_seconds"] = int(time.Since(l.prev.at).Seconds())
		}
		l.prev.name, l.prev.at = msg, time.Now()
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "install step", fields)
	if l.onStep != nil {
		l.onStep(msg)
	}
}

func (l installLog) note(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintln(l.w, msg) //nolint:errcheck // a log file; the install's own result is what is reported
	utils.LogWithFields(utils.LevelInfo, logTag, "install note", map[string]any{"fleet_host": l.host, "note": msg})
}

func (l installLog) output(out []byte) {
	if len(out) > 0 {
		l.w.Write(out) //nolint:errcheck // a log file; the install's own result is what is reported
		if out[len(out)-1] != '\n' {
			fmt.Fprintln(l.w) //nolint:errcheck // as above
		}
	}
}

// errRelayAuth: a relay was asked for with no way to sign in to it.
var errRelayAuth = errors.New("a relay needs relayOidc, or its pre-shared key (ION_RELAY_KEY, --relay-key-file, or the profile's relayKeyCommand)")

// checkRelay refuses a relay with no way to authenticate, before the host is
// touched.
func (o InstallOptions) checkRelay() error {
	if o.Relay != "" && !o.RelayOIDC && o.RelayKey == "" {
		return errRelayAuth
	}
	return nil
}

// relayArgs are `ion studio relay set`'s arguments for these options, and
// its stdin: the key, when there is one.
func (o InstallOptions) relayArgs(noRestart bool) ([]string, io.Reader) {
	args := []string{"studio", "relay", "set", o.Relay}
	var stdin io.Reader
	if o.RelayOIDC {
		args = append(args, "--oidc")
	} else {
		args = append(args, "--key-stdin")
		stdin = strings.NewReader(o.RelayKey + "\n")
	}
	if noRestart {
		args = append(args, "--no-restart")
	}
	return args, stdin
}

// relaySaved: `ion studio relay set` says "saved" when server.json changed
// and "already set" when it did not.
func relaySaved(out []byte) bool {
	return strings.Contains(string(out), " saved (")
}

// incomingName is a name for a copied artifact that no two installs share.
func incomingName(prefix, ext string) string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return prefix + ext
	}
	return prefix + "-" + hex.EncodeToString(b) + ext
}

// archRunsOn reports whether a build for any of archs runs on a host CPU:
// arm64 runs only on arm64; x86_64 (x64) also runs on arm64 under
// emulation.
func archRunsOn(archs, host string) bool {
	norm := func(a string) string {
		switch a {
		case "x86_64", "x64", "amd64":
			return "amd64"
		case "arm64", "aarch64":
			return "arm64"
		}
		return a
	}
	host = norm(host)
	for _, a := range strings.Fields(archs) {
		if a = norm(a); a == host || (a == "amd64" && host == "arm64") {
			return true
		}
	}
	return false
}

// hostCmd runs one command on the host, logging its output, and names the
// step in its error.
func hostCmd(ctx context.Context, r Runner, h Host, windows bool, script string, stdin io.Reader, log installLog) ([]byte, error) {
	var out, stderr []byte
	var err error
	if windows {
		out, stderr, err = r.RunPowerShell(ctx, h, script, stdin)
	} else {
		out, stderr, err = r.Run(ctx, h, script, stdin)
	}
	log.output(stderr)
	if err != nil {
		if msg := strings.TrimSpace(string(stderr)); msg != "" {
			return out, fmt.Errorf("%w: %s", err, lastTextLine(msg))
		}
		return out, err
	}
	return out, nil
}

func lastTextLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
