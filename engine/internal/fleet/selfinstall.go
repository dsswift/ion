package fleet

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/studiostatus"
	"github.com/dsswift/ion/engine/internal/utils"
)

// A host installs on itself: over its Studio connection the fleet tells it
// to restart, to install a release, or to install a build the fleet sends.
// It needs no SSH, so it works for a server reached only through a relay.
// SSH stays for a first install, a host whose Ion is down, and Windows.

// hostInstallChannel carries each step of a host's install
// (packages/shared host-install.ts).
const hostInstallChannel = "ion:host-install-progress"

// Waits around a host restarting itself.
var (
	hostGoesDownWithin = 4 * time.Minute
	hostReturnsWithin  = 6 * time.Minute
	hostReturnPoll     = 5 * time.Second
)

// HostLink is what a self-install needs of a host's Studio connection.
type HostLink interface {
	Action(ctx context.Context, action string, args ...any) (json.RawMessage, error)
	// InstallArtifact sends the file at path and has the host install it.
	InstallArtifact(ctx context.Context, path string) error
	// AwaitRestart waits for the host to go down for its install. A host
	// that says it will not install returns that as an error.
	AwaitRestart(ctx context.Context) error
	Close()
}

// canInstallItself asks the host whether it can install on itself now. A
// host whose server predates the answer cannot: it has no install actions.
func canInstallItself(ctx context.Context, link HostLink) (bool, string) {
	raw, err := link.Action(ctx, "environment.server.info")
	if err != nil {
		return false, "the host did not describe itself: " + err.Error()
	}
	var info studioclient.ServerInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return false, "the host's description did not decode: " + err.Error()
	}
	if info.HostInstall == nil {
		return false, "its Ion predates installing on itself"
	}
	if !info.HostInstall.Available {
		return false, "the host says it cannot: " + info.HostInstall.Code
	}
	return true, ""
}

// InstallArtifact streams the file to the host with its SHA-256, which the
// host checks before it installs.
func (l *Link) InstallArtifact(ctx context.Context, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck // read-only file
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	if err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	id := make([]byte, 8)
	if _, err := rand.Read(id); err != nil {
		return err
	}
	transferID := "fleet-" + hex.EncodeToString(id)
	const action = "environment.server.installArtifact"
	actionID, err := l.StartAction(ctx, action, map[string]any{
		"transferId": transferID, "totalBytes": size, "sha256": hex.EncodeToString(hash.Sum(nil)), "name": filepath.Base(path),
	})
	if err != nil {
		return err
	}
	if err := l.SendFile(ctx, transferID, f); err != nil {
		return fmt.Errorf("send %s: %w", filepath.Base(path), err)
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "artifact sent to host", map[string]any{"artifact": filepath.Base(path), "bytes": size, "via": l.Via})
	_, err = l.WaitResult(ctx, action, actionID, nil)
	return err
}

// installProgress is one step of a host's install.
type installProgress struct {
	Stage   string `json:"stage"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// AwaitRestart reads the host's install steps until its connection closes,
// which is the host going down to install. A step that says the host
// refused or failed ends the wait with the host's reason.
func (l *Link) AwaitRestart(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, hostGoesDownWithin)
	defer cancel()
	for {
		event, err := l.NextEvent(ctx, hostInstallChannel)
		if err != nil {
			if ctx.Err() != nil {
				return fmt.Errorf("the host did not restart within %s", hostGoesDownWithin)
			}
			return nil // the connection closed: the host went down
		}
		var p installProgress
		if json.Unmarshal(event.Payload, &p) != nil {
			continue
		}
		utils.LogWithFields(utils.LevelInfo, logTag, "host install step", map[string]any{"stage": p.Stage, "code": p.Code, "message": p.Message})
		if p.Stage == "refused" || p.Stage == "failed" {
			return fmt.Errorf("the host did not install: %s", firstNonEmptyString(p.Message, p.Code, p.Stage))
		}
	}
}

func firstNonEmptyString(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// LinkOpener opens a host's Studio connection for a self-install.
type LinkOpener func(ctx context.Context, h Host) (HostLink, error)

// Opener is the LinkOpener that uses s.
func (s Studio) Opener() LinkOpener {
	return func(ctx context.Context, h Host) (HostLink, error) {
		link, err := s.Open(ctx, h)
		if err != nil {
			return nil, err
		}
		return link, nil
	}
}

// Ops are the changes the fleet makes to a host outside a deploy.
type Ops struct {
	Runner Runner
	// Open opens a host's Studio connection; nil leaves only SSH.
	Open LinkOpener
	// ForceSSH never asks the host to act on itself.
	ForceSSH bool
}

// Restart restarts the host's Ion: the Studio Server services, or the
// desktop app (which stops its running conversations). The host restarts
// itself when it answers on its Studio connection; else the fleet restarts
// it over SSH.
func (o Ops) Restart(ctx context.Context, h Host) error {
	err := o.restart(ctx, h)
	logOutcome("restart", h, err)
	return err
}

func (o Ops) restart(ctx context.Context, h Host) error {
	var selfErr error
	if !o.ForceSSH && o.Open != nil && h.Paired() {
		if selfErr = o.restartSelf(ctx, h); selfErr == nil {
			return nil
		}
		utils.LogWithFields(utils.LevelInfo, logTag, "host did not restart itself", map[string]any{"fleet_host": h.Name, "error": selfErr.Error(), "ssh_fallback": h.SSH != ""})
	}
	if h.SSH == "" {
		if selfErr != nil {
			return selfErr
		}
		return h.ErrExternal()
	}
	kind, err := resolveKind(ctx, o.Runner, h)
	if err != nil {
		return err
	}
	h.Kind = kind
	return restart(ctx, o.Runner, h)
}

func (o Ops) restartSelf(ctx context.Context, h Host) error {
	link, err := o.Open(ctx, h)
	if err != nil {
		return err
	}
	defer link.Close()
	if _, err := link.Action(ctx, "environment.server.restart"); err != nil {
		return err
	}
	return link.AwaitRestart(ctx)
}

// KindOfReport is what a host runs, from its report: a server bundle or a
// desktop. A host with both, or neither, does not say.
func KindOfReport(r *studiostatus.Report) (string, bool) {
	if r == nil {
		return "", false
	}
	switch r.Kind {
	case studiostatus.KindServer:
		return KindServer, true
	case studiostatus.KindDesktop:
		return KindDesktop, true
	}
	return "", false
}

// errKindUnknown names the fix for a host whose kind is not known.
func errKindUnknown(h Host) error {
	return fmt.Errorf("the fleet cannot tell whether %s runs a Studio Server bundle or the desktop; say which with `ion fleet set %s --kind server|desktop`", h.Name, h.Name)
}

// resolveKind is the host's kind: what the catalog says, else what the
// host's own status says over SSH.
func resolveKind(ctx context.Context, r Runner, h Host) (string, error) {
	if h.Kind != "" {
		return h.Kind, nil
	}
	report, err := Collector{Runner: r}.overSSH(ctx, h)
	if err != nil {
		return "", err
	}
	if kind, ok := KindOfReport(report); ok {
		return kind, nil
	}
	return "", errKindUnknown(h)
}

// deploySelf deploys one target by having the host install on itself: a
// release it downloads, or the build this deploy made, sent over.
func (d *Deployer) deploySelf(ctx context.Context, p *Prepared, t Target, arts map[string]artifact, log io.Writer, step func(string)) (string, error) {
	h := t.Host
	link, err := d.OpenLink(ctx, h)
	if err != nil {
		return "", fmt.Errorf("open the host's Studio connection: %w", err)
	}
	defer link.Close()
	if p.sourceOf(t) == SourceRelease {
		want := p.Latest.Server
		if t.Component == ComponentDesktop {
			want = p.Latest.Desktop
		}
		if have := p.versionOf(t); want != "" && have == want {
			fmt.Fprintf(log, "%s already runs %s\n", h.Name, want) //nolint:errcheck // log line
			return "already at " + want, nil
		}
		step("asking the host to install release " + want)
		if _, err := link.Action(ctx, "environment.server.update"); err != nil {
			return "", err
		}
	} else {
		art := arts[artifactKey(t)]
		if art.err != nil {
			return "", art.err
		}
		path := art.path
		if t.Component == ComponentDesktop {
			step("packing the app for the host's updater")
			if path, err = d.Artifacts.UpdateArchive(ctx, p.Request.Checkout, art.path, log); err != nil {
				return "", err
			}
		}
		step("sending " + filepath.Base(path) + " to the host")
		if err := link.InstallArtifact(ctx, path); err != nil {
			return "", err
		}
	}
	step("the host is installing; waiting for it to restart")
	if err := link.AwaitRestart(ctx); err != nil {
		return "", err
	}
	link.Close()
	step("waiting for the host to come back")
	version, err := d.awaitReturn(ctx, h, t.Component)
	if err != nil {
		return "", err
	}
	fmt.Fprintf(log, "%s is back, running %s\n", h.Name, version) //nolint:errcheck // log line
	return version, nil
}

// versionOf is the version of the target's component the host runs now, as
// the deploy's statuses have it.
func (p *Prepared) versionOf(t Target) string {
	for _, st := range p.Statuses {
		if st.Host.Name != t.Host.Name || st.Report == nil {
			continue
		}
		if t.Component == ComponentDesktop {
			return DesktopCell(st.Report)
		}
		return ServerCell(st.Report)
	}
	return ""
}

// awaitReturn waits for the host to answer on its Studio connection again
// and returns the version of the component it now runs.
func (d *Deployer) awaitReturn(ctx context.Context, h Host, component string) (string, error) {
	deadline := time.Now().Add(hostReturnsWithin)
	var lastErr error
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(hostReturnPoll):
		}
		link, err := d.OpenLink(ctx, h)
		if err != nil {
			lastErr = err
			continue
		}
		raw, err := link.Action(ctx, "environment.server.info")
		link.Close()
		if err != nil {
			lastErr = err
			continue
		}
		var info studioclient.ServerInfo
		if err := json.Unmarshal(raw, &info); err != nil {
			return "", fmt.Errorf("decode the host's server info: %w", err)
		}
		if component == ComponentDesktop && info.HostApp != nil {
			return info.HostApp.Version, nil
		}
		return info.ServerVersion, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no attempt answered")
	}
	return "", fmt.Errorf("the host did not come back within %s: %w", hostReturnsWithin, lastErr)
}
