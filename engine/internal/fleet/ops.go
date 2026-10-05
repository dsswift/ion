package fleet

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// desktopApp is where the desktop installer puts Ion on a Mac.
const desktopApp = "/Applications/Ion.app"

// restartDesktop quits Ion the way a deploy does (SIGUSR2: no quit dialog,
// sessions stopped), kills one that ignores it, and opens it again.
const restartDesktop = macQuitIon + "open -a '" + desktopApp + "'\n"

// restart restarts the host's Ion over SSH: the Studio Server services, or
// the desktop app.
func restart(ctx context.Context, r Runner, h Host) error {
	if h.Kind != KindDesktop {
		_, err := runIon(ctx, r, h, []string{"studio", "restart"}, nil)
		return err
	}
	p, err := r.Platform(ctx, h)
	if err != nil {
		return err
	}
	var stderr []byte
	if p.Windows() {
		_, stderr, err = r.RunPowerShell(ctx, h, psRestartDesktop, nil)
	} else {
		_, stderr, err = r.Run(ctx, h, restartDesktop, nil)
	}
	if err != nil {
		return fmt.Errorf("%w: %s", err, stderr)
	}
	return nil
}

// desktopRunning reports whether the host's desktop app is running.
func desktopRunning(ctx context.Context, r Runner, h Host) (bool, error) {
	p, err := r.Platform(ctx, h)
	if err != nil {
		return false, err
	}
	var out, stderr []byte
	if p.Windows() {
		out, stderr, err = r.RunPowerShell(ctx, h, psDesktopRunning, nil)
	} else {
		out, stderr, err = r.Run(ctx, h, macIonRunning, nil)
	}
	if err != nil {
		return false, fmt.Errorf("%w: %s", err, stderr)
	}
	return strings.TrimSpace(string(out)) == "yes", nil
}

// SetRelay puts the host on its profile's relay. A key comes from the
// profile's command on this machine and reaches the host on ssh's stdin, never
// a command line. A server restarts its services itself; a desktop that is
// running is restarted so it reads the change.
func SetRelay(ctx context.Context, r Runner, h Host, p Profile) error {
	if h.External() {
		return h.ErrExternal()
	}
	kind, err := resolveKind(ctx, r, h)
	if err != nil {
		logOutcome("relay set", h, err)
		return err
	}
	h.Kind = kind
	err = setRelay(ctx, r, h, p)
	logOutcome("relay set", h, err)
	return err
}

func setRelay(ctx context.Context, r Runner, h Host, p Profile) error {
	if p.Relay == "" {
		return fmt.Errorf("host %s has no relay in its profile", h.Name)
	}
	args := []string{"studio", "relay", "set", p.Relay}
	var stdin io.Reader
	if p.RelayOIDC {
		args = append(args, "--oidc")
	} else {
		key, err := RelayKey(ctx, p)
		if err != nil {
			return err
		}
		args = append(args, "--key-stdin")
		stdin = strings.NewReader(key + "\n")
	}
	if h.Kind == KindDesktop {
		args = append(args, "--no-restart")
	}
	out, err := runIon(ctx, r, h, args, stdin)
	if err != nil || h.Kind != KindDesktop || !strings.Contains(string(out), " saved (") {
		return err
	}
	running, err := desktopRunning(ctx, r, h)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "relay set: could not tell whether the desktop runs; not restarting it", map[string]any{"fleet_host": h.Name, "error": err.Error()})
		return nil
	}
	if !running {
		return nil
	}
	return restart(ctx, r, h)
}

// RelayKey runs the profile's key command on this machine and returns its
// first line. The key is never logged or stored.
func RelayKey(ctx context.Context, p Profile) (string, error) {
	if p.RelayKeyCommand == "" {
		return "", errors.New("the profile has no relayKeyCommand and is not relayOidc")
	}
	out, err := operatorCommand(ctx, p.RelayKeyCommand).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", fmt.Errorf("relay key command failed: %s", strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", fmt.Errorf("relay key command: %w", err)
	}
	key := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	if key == "" {
		return "", errors.New("the relay key command printed nothing")
	}
	return key, nil
}

func logOutcome(op string, h Host, err error) {
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "host operation failed", map[string]any{"op": op, "fleet_host": h.Name, "error": err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "host operation done", map[string]any{"op": op, "fleet_host": h.Name})
}
