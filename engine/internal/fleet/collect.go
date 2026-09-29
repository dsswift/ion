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

// PairingSource reads the fleet's pairing with a host.
type PairingSource interface {
	Get(host string) (studioclient.Pairing, bool, error)
}

// Collector reads host statuses.
type Collector struct {
	Runner   Runner
	Pairings PairingSource
	// Tokens mints relay OIDC tokens; nil when the local engine is not reachable.
	Tokens studioclient.TokenSource
	// SignIns keeps the fleet's sign-ins to external hosts.
	SignIns SignInStore
	// External reads hosts deployed outside the fleet.
	External ExternalReader
	// ReadRelay reads a status through a relay; studioclient.ReadStatus by default.
	ReadRelay func(ctx context.Context, relay studioclient.Relay, bearer string, p studioclient.Pairing) (studioclient.Status, error)
	Now       func() time.Time
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

// One reads one host: SSH first, then the relay when SSH produced no report
// and the fleet is paired with the host.
func (c Collector) One(ctx context.Context, h Host) HostStatus {
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	st := HostStatus{Host: h, Via: ViaNone, CheckedAt: now()}
	if h.External() {
		report, err := c.overHTTPS(ctx, h)
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, logTag, "external host unreadable", map[string]any{"fleet_host": h.Name, "error": err.Error()})
			st.Error = err.Error()
			return st
		}
		st.Via, st.Report = ViaHTTPS, report
		return st
	}
	report, sshErr := c.overSSH(ctx, h)
	if sshErr == nil {
		c.markOwnPairing(h, report)
		st.Via, st.Report = ViaSSH, report
		utils.LogWithFields(utils.LevelInfo, logTag, "host read over ssh", map[string]any{"fleet_host": h.Name, "kind": report.Kind, "problems": len(report.Problems)})
		return st
	}
	utils.LogWithFields(utils.LevelWarn, logTag, "host not readable over ssh; trying the relay", map[string]any{"fleet_host": h.Name, "error": sshErr.Error()})
	report, relayErr := c.overRelay(ctx, h)
	if relayErr == nil {
		st.Via, st.Report = ViaRelay, report
		utils.LogWithFields(utils.LevelInfo, logTag, "host read through the relay", map[string]any{"fleet_host": h.Name})
		return st
	}
	utils.LogWithFields(utils.LevelWarn, logTag, "host unreadable", map[string]any{"fleet_host": h.Name, "ssh_error": sshErr.Error(), "relay_error": relayErr.Error()})
	st.Error = "ssh: " + sshErr.Error() + "; relay: " + relayErr.Error()
	return st
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

// markOwnPairing marks the fleet's own pairing among a host's devices. Over
// SSH the host lists every device of its owner, the fleet's included; through
// the relay the server marks it itself.
func (c Collector) markOwnPairing(h Host, r *studiostatus.Report) {
	if c.Pairings == nil || len(r.Devices) == 0 {
		return
	}
	p, ok, err := c.Pairings.Get(h.Name)
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

func (c Collector) overRelay(ctx context.Context, h Host) (*studiostatus.Report, error) {
	if c.Pairings == nil {
		return nil, errors.New("no pairing store")
	}
	p, ok, err := c.Pairings.Get(h.Name)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("not paired (run `ion fleet pair " + h.Name + "`)")
	}
	if len(p.Relays) == 0 {
		return nil, errors.New("the host advertised no relay when it paired")
	}
	read := c.ReadRelay
	if read == nil {
		read = studioclient.ReadStatus
	}
	var errs []string
	for _, relay := range p.Relays {
		bearer, err := studioclient.RelayBearer(ctx, relay, c.Tokens)
		if err != nil {
			errs = append(errs, err.Error())
			continue
		}
		st, err := read(ctx, relay, bearer, p)
		if err != nil {
			errs = append(errs, relay.URL+": "+err.Error())
			continue
		}
		r := st.Report()
		return &r, nil
	}
	return nil, errors.New(strings.Join(errs, "; "))
}
