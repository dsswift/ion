package studioclient

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studiostatus"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ServerInfo is `environment.server.info`. Fields a server older than them
// does not send decode to their zero value; Formats nil means "not reported".
type ServerInfo struct {
	ServerVersion string  `json:"serverVersion"`
	EngineVersion *string `json:"engineVersion"`
	Hostname      string  `json:"hostname"`
	Platform      string  `json:"platform"`
	Arch          string  `json:"arch"`
	DataDir       string  `json:"dataDir"`
	Bundle        *struct {
		Root    string `json:"root"`
		Version struct {
			Server string `json:"server"`
			Engine string `json:"engine"`
			Node   string `json:"node"`
		} `json:"version"`
	} `json:"bundle"`
	UptimeSeconds        int64  `json:"uptimeSeconds"`
	EngineMinVersion     string `json:"engineMinVersion"`
	EngineMeetsMin       *bool  `json:"engineMeetsMin"`
	RunningConversations *int   `json:"runningConversations"`
	HostApp              *struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"hostApp"`
	Formats []compat.Format `json:"formats"`
	// HostInstall is whether the host can install on itself now, and the
	// refusal code when it cannot. Nil from a server that predates it.
	HostInstall *struct {
		Available bool   `json:"available"`
		Code      string `json:"code"`
	} `json:"hostInstall"`
}

// Status is one read of a server through the relay.
type Status struct {
	Welcome Welcome
	Info    ServerInfo
	// Metrics is the server's latest System Metrics; nil when it has none.
	Metrics *types.SystemMetricsSample
	// Devices are the pairing owner's devices; nil when the server predates
	// environment.devices or refused it.
	Devices []studiostatus.PairedDevice
	// Accounts is the server's Provider Account Ledger; nil when the server
	// predates fleet.report.
	Accounts []studiostatus.Account
}

// ReadStatus connects over `relay`, reads the server info and the latest
// metrics sample, and closes.
func ReadStatus(ctx context.Context, relay Relay, bearer string, p Pairing) (Status, error) {
	ctx, cancel := context.WithTimeout(ctx, ReadTimeout)
	defer cancel()
	s, err := Connect(ctx, relay, bearer, p)
	if err != nil {
		return Status{}, err
	}
	defer s.Close()
	return ReadSession(ctx, s, relay.URL)
}

// ReadSession reads the server info, the latest metrics sample, the devices,
// and the provider accounts over an open session.
func ReadSession(ctx context.Context, s *Session, where string) (Status, error) {
	out := Status{Welcome: s.Welcome}
	raw, err := s.Action(ctx, "environment.server.info")
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out.Info); err != nil {
		return out, fmt.Errorf("decode environment.server.info: %w", err)
	}
	// `on: false` returns the latest sample without starting a stream.
	if raw, err := s.Action(ctx, "environment.systemMetrics.watch", map[string]any{"on": false}); err == nil {
		var watch struct {
			Latest *types.SystemMetricsSample `json:"latest"`
		}
		if err := json.Unmarshal(raw, &watch); err == nil {
			out.Metrics = watch.Latest
		}
	} else {
		utils.LogWithFields(utils.LevelWarn, logTag, "relay status: no metrics", map[string]any{"where": where, "error": err.Error()})
	}
	if raw, err := s.Action(ctx, "environment.devices"); err == nil {
		var devices []studiostatus.PairedDevice
		if err := json.Unmarshal(raw, &devices); err == nil {
			out.Devices = append([]studiostatus.PairedDevice{}, devices...)
		} else {
			utils.LogWithFields(utils.LevelWarn, logTag, "relay status: devices undecodable", map[string]any{"where": where, "error": err.Error()})
		}
	} else {
		utils.LogWithFields(utils.LevelWarn, logTag, "relay status: no devices", map[string]any{"where": where, "error": err.Error()})
	}
	if raw, err := s.Action(ctx, "fleet.report"); err == nil {
		var report struct {
			Accounts []studiostatus.Account `json:"accounts"`
		}
		if err := json.Unmarshal(raw, &report); err == nil {
			out.Accounts = append([]studiostatus.Account{}, report.Accounts...)
		} else {
			utils.LogWithFields(utils.LevelWarn, logTag, "studio status: accounts undecodable", map[string]any{"where": where, "error": err.Error()})
		}
	} else {
		utils.LogWithFields(utils.LevelInfo, logTag, "studio status: no provider accounts", map[string]any{"where": where, "error": err.Error()})
	}
	return out, nil
}

// Report turns a relay read into the report `ion studio status` prints, so a
// reader handles one shape whichever way the host answered. What only the
// host itself can see (service units, log paths, installed-but-not-running
// versions) is named in Problems.
func (s Status) Report() studiostatus.Report {
	i := s.Info
	r := studiostatus.Report{
		SchemaVersion: compat.StatusReportVersion,
		Hostname:      i.Hostname,
		Platform:      i.Platform,
		Arch:          i.Arch,
		DataDir:       i.DataDir,
		Ready:         true,
		Services:      []studiostatus.Service{},
		Relays:        []string{},
		Engine: studiostatus.Engine{
			MinVersion: i.EngineMinVersion,
			MeetsMin:   i.EngineMeetsMin,
		},
		RunningConversations: i.RunningConversations,
		Problems:             []string{"services, logs, and installed-but-not-running versions: not visible through the relay"},
	}
	if i.EngineVersion != nil && *i.EngineVersion != "" {
		r.Engine.Running = true
		r.Engine.Version = *i.EngineVersion
	}
	if i.Bundle != nil {
		r.InstalledVersion, r.EngineVersion = i.Bundle.Version.Server, i.Bundle.Version.Engine
		r.Components.StudioServer = &studiostatus.ServerBundle{Path: i.Bundle.Root, Version: i.Bundle.Version.Server, EngineVersion: i.Bundle.Version.Engine, NodeVersion: i.Bundle.Version.Node}
		r.Engine.InstalledVersion = i.Bundle.Version.Engine
		r.Engine.PendingRestart = r.Engine.Running && r.Engine.Version != i.Bundle.Version.Engine
	}
	if i.HostApp != nil {
		r.Components.Desktop = &studiostatus.DesktopApp{Version: i.HostApp.Version, ServerVersion: i.ServerVersion}
	}
	r.Kind = studiostatus.InstallKind(r.Components)
	for _, rel := range s.Welcome.Relays {
		r.Relays = append(r.Relays, rel.URL)
	}
	if i.Formats == nil {
		r.Problems = append(r.Problems, "formats: the server predates format reporting")
	}
	r.Formats = studiostatus.MergeFormats(nil, i.Formats)
	r.Metrics = studiostatus.ReduceMetrics(s.Metrics)
	r.Devices = s.Devices
	r.Accounts = s.Accounts
	if s.Devices == nil {
		r.Problems = append(r.Problems, "devices: the server predates environment.devices")
	}
	return r
}
