package main

// cmd_studio_status.go — `ion studio status [--json] [--no-latest]`: the whole
// host in one report (engine/internal/studiostatus). What is installed (a
// Studio Server bundle, the desktop app, or both), what is running, the
// host's load, the conversations with an agent running now, the relays, and
// every Format Version installed against running.
//
// Every read is local: the bundle and app on disk, the engine socket, and the
// server's /versionz on loopback. A part that cannot be read is named in
// Problems instead of failing the report, so a half-broken host still says
// what it can.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/studiostatus"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// statusDeps are the reads that leave this process, so tests can replace them.
type statusDeps struct {
	// engineSocket is where the engine listens.
	engineSocket string
	// desktop is the installed desktop, nil when none is; desktopErr says
	// why it could not be read.
	desktop    *desktopInstall
	desktopErr error
	// services reports the service units' states.
	services func() ([]studiostatus.Service, error)
	// latest looks up the newest published Studio Server release.
	latest func() (string, error)
	// runVersionJSON runs `<ion> version --json` for an installed engine.
	runVersionJSON func(ionBin string) ([]byte, error)
	// httpGet reads a loopback URL.
	httpGet func(url string) ([]byte, int, error)
	// devices asks the running server for its owner's paired devices.
	devices func() ([]studiostatus.PairedDevice, error)
}

const statusProbeTimeout = 4 * time.Second

func liveStatusDeps(l studioLayout) statusDeps {
	desktop, desktopErr := locateDesktop()
	return statusDeps{
		engineSocket: studioEngineSocket(l),
		desktop:      desktop,
		desktopErr:   desktopErr,
		services: func() ([]studiostatus.Service, error) {
			if runtime.GOOS == "windows" {
				task, err := engineTaskName()
				if err != nil {
					return nil, err
				}
				return []studiostatus.Service{windowsEngineService(execRunner{}, task)}, nil
			}
			mgr, err := newServiceManager(execRunner{}, l, false)
			if err != nil {
				return nil, err
			}
			var out []studiostatus.Service
			for _, u := range studioUnits(l) {
				st, err := mgr.Status(u)
				if err != nil {
					st = serviceStatus{Label: u.Label, State: "unknown", Detail: err.Error()}
				}
				out = append(out, studiostatus.Service{Label: st.Label, State: st.State, PID: st.PID, Detail: st.Detail})
			}
			return out, nil
		},
		latest: func() (string, error) {
			v, _, err := findLatestStudioRelease()
			return v, err
		},
		runVersionJSON: func(ionBin string) ([]byte, error) {
			ctx, cancel := context.WithTimeout(context.Background(), statusProbeTimeout)
			defer cancel()
			return exec.CommandContext(ctx, ionBin, "version", "--json").Output()
		},
		devices: func() ([]studiostatus.PairedDevice, error) { return readPairedDevices(l, desktop) },
		httpGet: func(url string) ([]byte, int, error) {
			client := &http.Client{Timeout: statusProbeTimeout}
			resp, err := client.Get(url)
			if err != nil {
				return nil, 0, err
			}
			defer resp.Body.Close() //nolint:errcheck // response body close after full read
			data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
			return data, resp.StatusCode, err
		},
	}
}

// studioEngineSocket is the engine socket of THIS install's data dir, which
// is not necessarily the one ION_DATA_DIR names for the invoking shell.
func studioEngineSocket(l studioLayout) string {
	if runtime.GOOS == "windows" {
		if sock, err := resolveSocketPath(); err == nil {
			return sock
		}
	}
	return filepath.Join(l.dataDir, "engine.sock")
}

func studioStatus(l studioLayout, flags map[string]string) {
	deps := liveStatusDeps(l)
	if flags["no-latest"] == "true" {
		deps.latest = nil
	}
	report := collectStudioStatus(l, deps)
	if flags["json"] == "true" {
		fmt.Println(string(mustMarshalCLI(report)))
		return
	}
	printStudioStatus(report)
}

// collectStudioStatus builds the report. It never fails; what it cannot read
// lands in Problems.
func collectStudioStatus(l studioLayout, d statusDeps) studiostatus.Report {
	host, _ := os.Hostname() //nolint:errcheck // an unknown hostname reports as empty
	r := studiostatus.Report{
		SchemaVersion: compat.StatusReportVersion,
		Hostname:      host,
		Platform:      runtime.GOOS,
		Arch:          runtime.GOARCH,
		DataDir:       l.dataDir,
		User:          l.user,
		Port:          l.port,
		Services:      []studiostatus.Service{},
		Relays:        []string{},
	}
	problem := func(part string, err error) {
		r.Problems = append(r.Problems, part+": "+err.Error())
		utils.LogWithFields(utils.LevelWarn, studioTag, "status: part unreadable", map[string]any{"part": part, "error": err.Error()})
	}

	// Installed: the Studio Server bundle and the desktop app.
	var installedFormats []compat.Format
	var bundleEngine, desktopEngine string
	if v, err := readBundleVersion(l.current); err == nil {
		r.InstalledVersion, r.EngineVersion = v.Server, v.Engine
		r.Components.StudioServer = &studiostatus.ServerBundle{Path: l.current, Version: v.Server, EngineVersion: v.Engine, NodeVersion: v.Node}
		bundleEngine = v.Engine
		installedFormats = append(installedFormats, readInstalledFormats(l.ionBin(), filepath.Join(l.current, "compat.json"), d, problem)...)
	} else if !os.IsNotExist(err) {
		problem("studio server bundle", err)
	}
	if d.desktopErr != nil {
		problem("desktop app", d.desktopErr)
	}
	if app := readDesktopApp(d.desktop, d); app != nil {
		r.Components.Desktop = app
		desktopEngine = app.EngineVersion
		if r.Components.StudioServer == nil {
			installedFormats = append(installedFormats, readInstalledFormats(d.desktop.engineBin(), d.desktop.serverFile("compat.json"), d, problem)...)
		}
	}
	r.Kind = studiostatus.InstallKind(r.Components)

	// Running: the engine over its socket, the server's /versionz.
	var runningFormats []compat.Format
	r.Engine.InstalledVersion = firstNonEmpty(bundleEngine, desktopEngine)
	if health, err := engineHealth(d.engineSocket); err == nil {
		r.Engine.Running = true
		r.Engine.Version = health.Version
		r.Engine.UptimeSec = health.UptimeSec
		r.Metrics = studiostatus.ReduceMetrics(health.SystemMetrics)
		if health.SystemMetrics == nil {
			problem("metrics", fmt.Errorf("the engine has no System Metrics sample (sampling disabled or none taken yet)"))
		}
		r.Engine.PendingRestart = engineRestartPending(health.Version, bundleEngine, desktopEngine)
		runningFormats = append(runningFormats, health.Compat...)
	} else {
		problem("engine", err)
	}
	if r.Engine.Running {
		if n, err := countRunningSessions(d.engineSocket); err == nil {
			r.RunningConversations = &n
		} else {
			problem("sessions", err)
		}
	}
	vz, vzErr := readVersionz(l.port, d)
	if vzErr == nil {
		r.Engine.MinVersion = vz.EngineMinVersion
		r.Engine.MeetsMin = vz.EngineMeetsMin
		// /versionz carries the engine's formats too; take the server's only.
		for _, f := range vz.Formats {
			if f.Owner == compat.OwnerServer {
				runningFormats = append(runningFormats, f)
			}
		}
	} else {
		problem("server /versionz", vzErr)
	}
	// Only a running server knows which devices are connected.
	if vzErr == nil && d.devices != nil {
		if devices, err := d.devices(); err == nil {
			r.Devices = devices
		} else {
			problem("devices", err)
		}
	}
	if _, code, err := d.httpGet(fmt.Sprintf("http://127.0.0.1:%d/readyz", l.port)); err == nil {
		r.Ready = code == http.StatusOK
	}
	r.Formats = studiostatus.MergeFormats(installedFormats, runningFormats)

	if relays, err := readStudioRelays(l.dataDir); err == nil {
		for _, rel := range relays {
			r.Relays = append(r.Relays, rel.url)
		}
	} else {
		problem("relays", err)
	}
	if d.services != nil {
		if svcs, err := d.services(); err == nil {
			r.Services = svcs
		} else {
			problem("services", err)
		}
	}
	for _, u := range studioUnits(l) {
		r.Logs = append(r.Logs, u.StdoutPath, u.StderrPath)
	}
	r.Logs = append(r.Logs, filepath.Join(l.dataDir, "engine.jsonl"), filepath.Join(l.dataDir, "server.jsonl"))
	if d.latest != nil {
		if v, err := d.latest(); err == nil {
			r.LatestVersion = v
		} else {
			problem("latest release", err)
		}
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "status collected", map[string]any{
		"kind": r.Kind, "engine_running": r.Engine.Running, "ready": r.Ready, "format_count": len(r.Formats), "problem_count": len(r.Problems),
	})
	return r
}

// engineRestartPending: a running engine that is none of the installed ones.
// Unknown installs (no version) never flag.
func engineRestartPending(running string, installed ...string) bool {
	known := false
	for _, v := range installed {
		if v == "" {
			continue
		}
		known = true
		if v == running {
			return false
		}
	}
	return known && running != ""
}

// readInstalledFormats reads an install's formats: its engine binary's
// `version --json` and its server's compat.json.
func readInstalledFormats(ionBin, compatJSON string, d statusDeps, problem func(string, error)) []compat.Format {
	var out []compat.Format
	if data, err := d.runVersionJSON(ionBin); err != nil {
		problem("installed engine formats", fmt.Errorf("%s version --json: %w", ionBin, err))
	} else if v, err := parseVersionJSON(data); err != nil {
		problem("installed engine formats", err)
	} else {
		out = append(out, v.Formats...)
	}
	if data, err := os.ReadFile(compatJSON); err != nil {
		problem("installed server formats", err)
	} else {
		var file struct {
			Formats []compat.Format `json:"formats"`
		}
		if err := json.Unmarshal(data, &file); err != nil {
			problem("installed server formats", fmt.Errorf("parse %s: %w", compatJSON, err))
		} else {
			out = append(out, file.Formats...)
		}
	}
	return out
}

// parseVersionJSON reads `ion version --json`. An engine older than the flag
// prints `ion-engine <v>` instead: its version, no formats.
func parseVersionJSON(data []byte) (versionReport, error) {
	var v versionReport
	trimmed := strings.TrimSpace(string(data))
	if strings.HasPrefix(trimmed, "ion-engine ") {
		return versionReport{Version: strings.TrimPrefix(trimmed, "ion-engine ")}, fmt.Errorf("engine %s predates format reporting", strings.TrimPrefix(trimmed, "ion-engine "))
	}
	if err := json.Unmarshal(data, &v); err != nil {
		return v, fmt.Errorf("parse version --json: %w", err)
	}
	return v, nil
}

type engineHealthData struct {
	Version       string                     `json:"version"`
	UptimeSec     int64                      `json:"uptimeSec"`
	SystemMetrics *types.SystemMetricsSample `json:"systemMetrics"`
	Compat        []compat.Format            `json:"compat"`
}

func engineHealth(sock string) (engineHealthData, error) {
	var h engineHealthData
	res, err := connectAndSendTimeout(sock, map[string]interface{}{"cmd": "health"}, statusProbeTimeout)
	if err != nil {
		return h, err
	}
	if msg, ok := res["error"].(string); ok && msg != "" {
		return h, fmt.Errorf("health: %s", msg)
	}
	raw, err := json.Marshal(res["data"])
	if err != nil {
		return h, fmt.Errorf("re-encode health: %w", err)
	}
	if err := json.Unmarshal(raw, &h); err != nil {
		return h, fmt.Errorf("decode health: %w", err)
	}
	return h, nil
}

func countRunningSessions(sock string) (int, error) {
	res, err := connectAndSendTimeout(sock, map[string]interface{}{"cmd": "list_sessions"}, statusProbeTimeout)
	if err != nil {
		return 0, err
	}
	sessions, err := decodeSessionList(res["data"])
	if err != nil {
		return 0, err
	}
	n := 0
	for _, s := range sessions {
		if s.HasActiveRun {
			n++
		}
	}
	return n, nil
}

// versionzBody is the part of the server's /versionz this report reads.
type versionzBody struct {
	EngineMinVersion string          `json:"engineMinVersion"`
	EngineMeetsMin   *bool           `json:"engineMeetsMin"`
	Formats          []compat.Format `json:"formats"`
}

func readVersionz(port int, d statusDeps) (versionzBody, error) {
	var v versionzBody
	data, code, err := d.httpGet(fmt.Sprintf("http://127.0.0.1:%d/versionz", port))
	if err != nil {
		return v, err
	}
	if code == http.StatusNotFound {
		return v, fmt.Errorf("the running server predates /versionz")
	}
	if code != http.StatusOK {
		return v, fmt.Errorf("/versionz answered %d", code)
	}
	if err := json.Unmarshal(data, &v); err != nil {
		return v, fmt.Errorf("parse /versionz: %w", err)
	}
	return v, nil
}

// printStudioStatus is the human form of the report.
func printStudioStatus(r studiostatus.Report) {
	var b strings.Builder
	fmt.Fprintf(&b, "Ion on %s (%s/%s), %s install, data %s, account %s\n", orDash(r.Hostname), r.Platform, r.Arch, r.Kind, r.DataDir, r.User)
	if c := r.Components.StudioServer; c != nil {
		fmt.Fprintf(&b, "  studio server  %s (engine %s, node %s)\n", c.Version, c.EngineVersion, c.NodeVersion)
	}
	if c := r.Components.Desktop; c != nil {
		fmt.Fprintf(&b, "  desktop        %s (server %s, engine %s)\n", c.Version, orDash(c.ServerVersion), orDash(c.EngineVersion))
	}
	if r.LatestVersion != "" && r.LatestVersion != r.InstalledVersion && r.Components.StudioServer != nil {
		fmt.Fprintf(&b, "  update available: %s (run `ion studio update`)\n", r.LatestVersion)
	}
	switch {
	case !r.Engine.Running:
		b.WriteString("  engine         not running\n")
	case r.Engine.PendingRestart:
		fmt.Fprintf(&b, "  engine         %s running, %s installed (restart pending)\n", r.Engine.Version, r.Engine.InstalledVersion)
	default:
		fmt.Fprintf(&b, "  engine         %s running, up %s\n", r.Engine.Version, time.Duration(r.Engine.UptimeSec)*time.Second)
	}
	fmt.Fprintf(&b, "  ready          %v (http://127.0.0.1:%d/readyz)\n", r.Ready, r.Port)
	if m := r.Metrics; m != nil {
		cpu := "-"
		if m.CPUUtilization != nil {
			cpu = fmt.Sprintf("%.0f%%", *m.CPUUtilization*100)
		}
		fmt.Fprintf(&b, "  host           cpu %s of %d cores, memory %s free of %s; Ion %.0f%% cpu, %s\n",
			cpu, m.CPUCount, fleet.HumanBytes(m.MemoryAvailableBytes), fleet.HumanBytes(m.MemoryTotalBytes), m.IonCPUPercent, fleet.HumanBytes(m.IonRSSBytes))
	}
	if r.RunningConversations != nil {
		fmt.Fprintf(&b, "  running now    %d conversation(s)\n", *r.RunningConversations)
	}
	if len(r.Relays) > 0 {
		fmt.Fprintf(&b, "  relays         %s\n", strings.Join(r.Relays, ", "))
	}
	if r.Devices != nil {
		fmt.Fprintf(&b, "  devices        %s\n", studiostatus.DeviceSummary(r.Devices))
	}
	for _, s := range r.Services {
		detail := ""
		if s.Detail != "" {
			detail = " (" + s.Detail + ")"
		}
		fmt.Fprintf(&b, "  %-24s %s pid=%s%s\n", s.Label, s.State, orDash(s.PID), detail)
	}
	if len(r.Formats) > 0 {
		b.WriteString("  formats:\n")
		for _, f := range r.Formats {
			note := ""
			if f.PendingRestart {
				note = fmt.Sprintf(" (installed %s, restart pending)", f.Installed)
			}
			fmt.Fprintf(&b, "    %-6s %-24s %-10s %s%s\n", f.Owner, f.ID, orDash(f.Effective()), f.Rule, note)
		}
	}
	for _, p := range r.Problems {
		fmt.Fprintf(&b, "  unreadable: %s\n", p)
	}
	b.WriteString("  logs:\n")
	for _, p := range r.Logs {
		fmt.Fprintf(&b, "    %s\n", p)
	}
	fmt.Print(b.String())
}
