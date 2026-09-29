// Package studiostatus is the report `ion studio status --json` prints about
// one host: what is installed, what is running, the host's load, and every
// Format Version installed and running. `ion fleet` decodes the same type,
// whether it read the report over SSH or assembled it through the relay.
package studiostatus

import (
	"fmt"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/types"
)

// Install kinds: what the host has installed.
const (
	KindServer  = "server"  // a Studio Server bundle (`ion studio install`)
	KindDesktop = "desktop" // the Ion desktop app, which runs its own server
	KindBoth    = "both"
	KindNone    = "none"
)

// Report is one host's status.
type Report struct {
	// SchemaVersion is compat.StatusReportVersion for a report this build
	// writes; a reader refuses a higher one rather than misread it.
	SchemaVersion int    `json:"schemaVersion"`
	Hostname      string `json:"hostname"`
	Platform      string `json:"platform"`
	Arch          string `json:"arch"`
	DataDir       string `json:"dataDir"`
	User          string `json:"user"`
	Port          int    `json:"port"`
	Kind          string `json:"kind"`

	// InstalledVersion and EngineVersion are the Studio Server bundle's
	// server and engine versions, kept at the top level for readers of the
	// first shape of this report. Empty when no bundle is installed.
	InstalledVersion string `json:"installedVersion"`
	EngineVersion    string `json:"engineVersion"`
	// LatestVersion is the newest published Studio Server release; empty when
	// not looked up (--no-latest) or the lookup failed.
	LatestVersion string `json:"latestVersion,omitempty"`

	// Ready is the server's /readyz on this host.
	Ready    bool      `json:"ready"`
	Services []Service `json:"services"`
	Logs     []string  `json:"logs"`

	Components Components `json:"components"`
	Engine     Engine     `json:"engine"`
	// Metrics is the engine's latest System Metrics sample, reduced; nil when
	// the engine is down or sampling is disabled.
	Metrics *HostMetrics `json:"metrics,omitempty"`
	// RunningConversations counts engine sessions with an agent running now;
	// nil when the engine did not answer.
	RunningConversations *int `json:"runningConversations"`
	// Relays are the relay URLs in server.json. Keys are never reported.
	Relays []string `json:"relays"`
	// Devices are the devices paired to the host for its owner, and which
	// are connected now; nil when the running server was not asked.
	Devices []PairedDevice `json:"devices"`
	Formats []FormatStatus `json:"formats"`
	// Problems names each part of the report that could not be read, so a
	// reader can tell "absent" from "unknown".
	Problems []string `json:"problems,omitempty"`
}

// PairedDevice is one device paired to the host, as the server's
// environment.devices answers it (packages/shared PairedDevice).
type PairedDevice struct {
	ClientID string `json:"clientId"`
	// Label is what the device called itself at pairing; empty on old records.
	Label       string `json:"label"`
	Kind        string `json:"kind"` // desktop | mobile
	PairedAt    int64  `json:"pairedAt"`
	LastSeen    int64  `json:"lastSeen"`
	Connected   bool   `json:"connected"`
	ConnectedAt *int64 `json:"connectedAt"`
	Admin       bool   `json:"admin"`
	// Self marks the pairing the reader connected through.
	Self bool `json:"self"`
}

// DeviceCounts are the host's paired devices and how many are connected now,
// leaving out the reader's own pairing.
func DeviceCounts(devices []PairedDevice) (paired, connected int) {
	for _, d := range devices {
		if d.Self {
			continue
		}
		paired++
		if d.Connected {
			connected++
		}
	}
	return paired, connected
}

// DeviceSummary reads the devices in a line: how many are paired and
// connected, then each by name, connected ones first.
func DeviceSummary(devices []PairedDevice) string {
	paired, connected := DeviceCounts(devices)
	if paired == 0 {
		return "none paired"
	}
	var on, off []string
	for _, d := range devices {
		if d.Self {
			continue
		}
		name := d.Label
		if name == "" {
			name = "unnamed " + DeviceKindName(d.Kind)
		}
		if d.Connected {
			on = append(on, name+" (connected)")
		} else {
			off = append(off, name)
		}
	}
	return fmt.Sprintf("%d paired, %d connected now: %s", paired, connected, strings.Join(append(on, off...), ", "))
}

// DeviceKindName is what a device kind is called: the wire says mobile, a
// person says phone.
func DeviceKindName(kind string) string {
	if kind == "mobile" {
		return "phone"
	}
	return kind
}

// Service is one service unit's state.
type Service struct {
	Label  string `json:"label"`
	State  string `json:"state"`
	PID    string `json:"pid,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// Components are the installs on the host.
type Components struct {
	StudioServer *ServerBundle `json:"studioServer,omitempty"`
	Desktop      *DesktopApp   `json:"desktop,omitempty"`
}

// ServerBundle is an installed Studio Server bundle.
type ServerBundle struct {
	Path          string `json:"path"`
	Version       string `json:"version"`
	EngineVersion string `json:"engineVersion"`
	NodeVersion   string `json:"nodeVersion"`
}

// DesktopApp is an installed Ion desktop and the server and engine it carries.
type DesktopApp struct {
	Path          string `json:"path"`
	Version       string `json:"version"`
	ServerVersion string `json:"serverVersion"`
	EngineVersion string `json:"engineVersion"`
}

// Engine is the engine on the host: the one running, against the one installed.
type Engine struct {
	Running bool `json:"running"`
	// Version is the running engine's; empty when it is not running.
	Version string `json:"version,omitempty"`
	// InstalledVersion is the engine the host's install would run next.
	InstalledVersion string `json:"installedVersion,omitempty"`
	// PendingRestart is true when the running engine is not the installed one.
	PendingRestart bool  `json:"pendingRestart"`
	UptimeSec      int64 `json:"uptimeSec,omitempty"`
	// MinVersion is server.json's engine.minVersion, and MeetsMin whether the
	// running engine meets it (nil when either is unknown).
	MinVersion string `json:"minVersion,omitempty"`
	MeetsMin   *bool  `json:"meetsMin,omitempty"`
}

// HostMetrics is the part of a System Metrics sample a fleet view shows.
type HostMetrics struct {
	SampledAt int64 `json:"sampledAt"`
	// CPUUtilization is the host's CPU use, 0..1; nil on a first sample.
	CPUUtilization       *float64 `json:"cpuUtilization"`
	CPUCount             int      `json:"cpuCount"`
	MemoryTotalBytes     uint64   `json:"memoryTotalBytes"`
	MemoryAvailableBytes uint64   `json:"memoryAvailableBytes"`
	MemoryLimitBytes     uint64   `json:"memoryLimitBytes,omitempty"`
	Load1                *float64 `json:"load1,omitempty"`
	DiskTotalBytes       uint64   `json:"diskTotalBytes,omitempty"`
	DiskFreeBytes        uint64   `json:"diskFreeBytes,omitempty"`
	// IonCPUPercent sums every Ion process (100 = one core); IonRSSBytes sums
	// their resident memory.
	IonCPUPercent float64 `json:"ionCpuPercent"`
	IonRSSBytes   uint64  `json:"ionRssBytes"`
}

// FormatStatus is one Format Version on the host, installed against running.
type FormatStatus struct {
	ID      string      `json:"id"`
	Owner   string      `json:"owner"`
	Rule    compat.Rule `json:"rule"`
	Meaning string      `json:"meaning"`
	// Installed is the version the installed build speaks; empty when unknown.
	Installed string `json:"installed,omitempty"`
	// Running is the version the running build speaks; empty when not running.
	Running string `json:"running,omitempty"`
	// PendingRestart: both are known and differ.
	PendingRestart bool `json:"pendingRestart"`
}

// Effective is the version this host speaks now: the running one, else the
// installed one.
func (f FormatStatus) Effective() string {
	if f.Running != "" {
		return f.Running
	}
	return f.Installed
}

// MergeFormats joins installed and running registries by owner and id,
// sorted engine first, then server, then by id.
func MergeFormats(installed, running []compat.Format) []FormatStatus {
	type key struct{ owner, id string }
	byKey := map[key]*FormatStatus{}
	var order []key
	add := func(f compat.Format) *FormatStatus {
		k := key{f.Owner, f.ID}
		if s, ok := byKey[k]; ok {
			return s
		}
		s := &FormatStatus{ID: f.ID, Owner: f.Owner, Rule: f.Rule, Meaning: f.Meaning}
		byKey[k] = s
		order = append(order, k)
		return s
	}
	for _, f := range installed {
		add(f).Installed = f.Version
	}
	for _, f := range running {
		s := add(f)
		s.Running = f.Version
		// The running build describes the format as it runs now.
		s.Rule, s.Meaning = f.Rule, f.Meaning
	}
	out := make([]FormatStatus, 0, len(order))
	for _, k := range order {
		s := byKey[k]
		s.PendingRestart = s.Installed != "" && s.Running != "" && s.Installed != s.Running
		out = append(out, *s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Owner != out[j].Owner {
			return out[i].Owner == compat.OwnerEngine
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Format returns the host's entry for one format, or false.
func (r Report) Format(owner, id string) (FormatStatus, bool) {
	for _, f := range r.Formats {
		if f.Owner == owner && f.ID == id {
			return f, true
		}
	}
	return FormatStatus{}, false
}

// ReduceMetrics keeps a System Metrics sample's host figures and sums Ion's
// own processes. Nil in, nil out.
func ReduceMetrics(s *types.SystemMetricsSample) *HostMetrics {
	if s == nil {
		return nil
	}
	m := &HostMetrics{
		SampledAt:            s.SampledAt,
		CPUUtilization:       s.Host.CPUUtilization,
		CPUCount:             s.Host.CPUCount,
		MemoryTotalBytes:     s.Host.MemoryTotalBytes,
		MemoryAvailableBytes: s.Host.MemoryAvailableBytes,
		MemoryLimitBytes:     s.Host.MemoryLimitBytes,
		Load1:                s.Host.Load1,
		DiskTotalBytes:       s.Host.DiskTotalBytes,
		DiskFreeBytes:        s.Host.DiskFreeBytes,
	}
	for _, p := range s.Processes {
		if p.CPUPercent != nil {
			m.IonCPUPercent += *p.CPUPercent
		}
		m.IonRSSBytes += p.RSSBytes
	}
	return m
}

// InstallKind names what is installed. A server with neither a bundle nor a
// desktop behind it (one run from a checkout) is KindNone.
func InstallKind(c Components) string {
	switch {
	case c.StudioServer != nil && c.Desktop != nil:
		return KindBoth
	case c.StudioServer != nil:
		return KindServer
	case c.Desktop != nil:
		return KindDesktop
	}
	return KindNone
}
