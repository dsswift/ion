package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/studiostatus"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Reach names which path answered for a host.
const (
	ViaSSH   = "ssh"
	ViaRelay = "relay"
	ViaNone  = "down"
)

// HostStatus is one host's latest read.
type HostStatus struct {
	Host Host `json:"host"`
	// Via is ssh, relay, or down.
	Via    string               `json:"via"`
	Report *studiostatus.Report `json:"report,omitempty"`
	// Error says why the host could not be read at all.
	Error     string    `json:"error,omitempty"`
	CheckedAt time.Time `json:"checkedAt"`
}

// StudioReader reads a host over its Studio connection and says how the
// connection reached it.
type StudioReader func(ctx context.Context, h Host) (studioclient.Status, string, error)

// Collector reads host statuses.
type Collector struct {
	Runner Runner
	// Studio opens a host's Studio connection with the device's credential.
	Studio Studio
	// ReadStudio reads a host over its Studio connection; opening one with
	// Studio and reading it by default.
	ReadStudio StudioReader
	// Public reads what a server answers without a credential;
	// studioclient.ReadPublic by default.
	Public func(ctx context.Context, base string) (studioclient.Public, error)
	Now    func() time.Time
}

// SSHTimeout bounds one host's status probe over SSH.
const SSHTimeout = 25 * time.Second

// Collect reads every host at once and returns the statuses in host order.
func (c Collector) Collect(ctx context.Context, hosts []Host) []HostStatus {
	out := make([]HostStatus, len(hosts))
	var wg sync.WaitGroup
	for i, h := range hosts {
		wg.Add(1)
		go func(i int, h Host) {
			defer wg.Done()
			out[i] = c.One(ctx, h)
		}(i, h)
	}
	wg.Wait()
	return out
}

// One reads one host: over SSH when it has an SSH target, since only the
// host itself sees its services and installed versions; else, or when SSH
// gives no report, over its Studio connection; else what the server
// publishes to anyone.
func (c Collector) One(ctx context.Context, h Host) HostStatus {
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	st := HostStatus{Host: h, Via: ViaNone, CheckedAt: now()}
	var errs []string
	if h.SSH != "" {
		report, err := c.overSSH(ctx, h)
		if err == nil {
			c.markOwnPairing(h, report)
			st.Via, st.Report = ViaSSH, report
			utils.LogWithFields(utils.LevelInfo, logTag, "host read over ssh", map[string]any{"fleet_host": h.Name, "kind": report.Kind, "problems": len(report.Problems)})
			return st
		}
		utils.LogWithFields(utils.LevelWarn, logTag, "host not readable over ssh", map[string]any{"fleet_host": h.Name, "error": err.Error()})
		errs = append(errs, "ssh: "+err.Error())
	}
	if h.Paired() {
		report, via, err := c.overStudio(ctx, h)
		if err == nil {
			st.Via, st.Report = via, report
			utils.LogWithFields(utils.LevelInfo, logTag, "host read over its studio connection", map[string]any{"fleet_host": h.Name, "via": via})
			return st
		}
		utils.LogWithFields(utils.LevelWarn, logTag, "host not readable over its studio connection", map[string]any{"fleet_host": h.Name, "error": err.Error()})
		errs = append(errs, "studio: "+err.Error())
		if h.URL != "" {
			if report, err := c.publicly(ctx, h, err.Error()); err == nil {
				st.Via, st.Report = ViaHTTPS, report
				return st
			}
		}
	}
	if len(errs) == 0 {
		errs = append(errs, "the fleet has no way to reach this host")
	}
	st.Error = strings.Join(errs, "; ")
	utils.LogWithFields(utils.LevelWarn, logTag, "host unreadable", map[string]any{"fleet_host": h.Name, "error": st.Error})
	return st
}

// ReadTimeout bounds one host's read over its Studio connection, every
// address it is tried at included.
const ReadTimeout = 45 * time.Second

func (c Collector) overStudio(ctx context.Context, h Host) (*studiostatus.Report, string, error) {
	ctx, cancel := context.WithTimeout(ctx, ReadTimeout)
	defer cancel()
	read := c.ReadStudio
	if read == nil {
		read = func(ctx context.Context, h Host) (studioclient.Status, string, error) {
			link, err := c.Studio.Open(ctx, h)
			if err != nil {
				return studioclient.Status{}, "", err
			}
			defer link.Close()
			st, err := studioclient.ReadSession(ctx, link.Session, h.Name)
			return st, link.Via, err
		}
	}
	st, via, err := read(ctx, h)
	if err != nil {
		return nil, "", err
	}
	r := st.Report()
	return &r, via, nil
}

// publicly reads what the server at the host's address answers to anyone:
// its versions, readiness, and formats. why is the reason the full read did
// not happen.
func (c Collector) publicly(ctx context.Context, h Host, why string) (*studiostatus.Report, error) {
	ctx, cancel := context.WithTimeout(ctx, SSHTimeout)
	defer cancel()
	read := c.Public
	if read == nil {
		read = studioclient.ReadPublic
	}
	pub, err := read(ctx, h.URL)
	if err != nil {
		return nil, err
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "host read publicly", map[string]any{"fleet_host": h.Name, "reason": why})
	r := pub.Report(publicOnlyProblem + why)
	r.Hostname = pub.Auth.Label
	return &r, nil
}

func (c Collector) overSSH(ctx context.Context, h Host) (*studiostatus.Report, error) {
	ctx, cancel := context.WithTimeout(ctx, SSHTimeout)
	defer cancel()
	out, err := runIon(ctx, c.Runner, h, []string{"studio", "status", "--json", "--no-latest"}, nil)
	if err != nil {
		if sshUnreachable(err) {
			return nil, fmt.Errorf("unreachable (%v)", err)
		}
		return nil, err
	}
	return DecodeReport(out)
}

// markOwnPairing marks this device's own pairing among a host's devices.
// Over SSH the host lists every device of its owner, this one included;
// over a Studio connection the server marks it itself.
func (c Collector) markOwnPairing(h Host, r *studiostatus.Report) {
	if h.Entry == nil || c.Studio.Catalog == nil || len(r.Devices) == 0 {
		return
	}
	p, ok, err := c.Studio.Catalog.Pairing(h.Entry.CredentialKey())
	if err != nil || !ok {
		return
	}
	for i := range r.Devices {
		if r.Devices[i].ClientID == p.ClientID {
			r.Devices[i].Self = true
		}
	}
}

// DecodeReport reads `ion studio status --json`. A host whose `ion` predates
// the full report still yields what it printed, with a Problem saying so.
func DecodeReport(out []byte) (*studiostatus.Report, error) {
	trimmed := strings.TrimSpace(string(out))
	if !strings.HasPrefix(trimmed, "{") {
		return nil, errors.New("the host's ion does not print `studio status --json`; deploy to update it")
	}
	var r studiostatus.Report
	if err := json.Unmarshal([]byte(trimmed), &r); err != nil {
		return nil, fmt.Errorf("parse status: %w", err)
	}
	if r.SchemaVersion > compat.StatusReportVersion {
		return nil, fmt.Errorf("the host reports status schema %d; this ion reads up to %d", r.SchemaVersion, compat.StatusReportVersion)
	}
	if r.SchemaVersion == 0 {
		upgradeFirstShape(&r)
	}
	return &r, nil
}

// PredatesFullReport is the Problem a host whose `ion` printed the first,
// shorter shape of the status report carries.
const PredatesFullReport = "the host's ion predates the full status report; deploy to update it"

// upgradeFirstShape fills what the first shape of the report says in its own
// terms: the bundle's versions, and the engine service's state. What it never
// reported (a desktop install, the running engine's version, formats, load)
// stays unknown.
func upgradeFirstShape(r *studiostatus.Report) {
	r.Problems = append(r.Problems, PredatesFullReport)
	if r.InstalledVersion != "" {
		r.Components.StudioServer = &studiostatus.ServerBundle{Version: r.InstalledVersion, EngineVersion: r.EngineVersion}
		r.Engine.InstalledVersion = r.EngineVersion
	}
	r.Kind = studiostatus.InstallKind(r.Components)
	for _, s := range r.Services {
		if strings.Contains(s.Label, "engine") && s.State == "running" {
			r.Engine.Running = true
		}
	}
}

// Legacy reports whether the host answered with the first shape.
func Legacy(r *studiostatus.Report) bool {
	return r != nil && r.SchemaVersion == 0
}
