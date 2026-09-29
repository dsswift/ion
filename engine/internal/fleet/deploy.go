package fleet

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Components a deploy installs.
const (
	ComponentServer  = "server"  // the Studio Server bundle (engine + server + node)
	ComponentDesktop = "desktop" // the Ion desktop app (carries its own server and engine)
)

// Sources a deploy installs from.
const (
	SourceDev     = "dev"     // a build of the fleet file's checkout
	SourceRelease = "release" // the newest published release
)

// Target is one host and what it gets.
type Target struct {
	Host      Host   `json:"host"`
	Component string `json:"component"`
	// Platform is the host's goos/goarch, which picks a server bundle.
	GOOS   string `json:"goos"`
	GOARCH string `json:"goarch"`
}

// Request is what the operator asked for.
type Request struct {
	Hosts []Host
	// Component is server or desktop; empty means each host's own kind.
	Component string
	// Source is dev or release (ResolveSource turns a path into dev).
	Source string
	// Checkout is the Ion checkout a dev deploy builds from, and whose
	// Studio Server installer a server install runs; ResolveSource picks it.
	Checkout       string
	AllowDowngrade bool
	// Install is what every install does; each host adds its own sudo
	// setting and its profile's relay and arguments.
	Install InstallOptions
	// Artifact installs this desktop package or installer instead of a build.
	Artifact string
	// NoBuild installs the newest build already in the checkout.
	NoBuild bool
	// Terminal says this process has a terminal a host's sudo can ask on.
	Terminal bool
	// Known are host statuses the caller already read. Prepare reads only
	// the fleet's hosts missing from it.
	Known []HostStatus
}

// ExecSpec is one local command a deploy runs (a build or a deploy script).
type ExecSpec struct {
	Dir  string
	Name string
	Args []string
	// Env is added to this process's environment.
	Env []string
	// Interactive commands need this terminal (a sudo password prompt).
	Interactive bool
	// Banner says what an interactive command will ask for. A view that
	// hides the terminal prints it when it hands the terminal over; a plain
	// terminal already showed it in the echoed log.
	Banner string
	Stdout io.Writer
	Stderr io.Writer
}

// Event is one step of a deploy, for a live view.
type Event struct {
	Host  string `json:"host"`
	Stage string `json:"stage"`
	// Detail is the stage's one-line explanation, or the failure.
	Detail string `json:"detail,omitempty"`
}

// Stages a target moves through.
const (
	StageQueued    = "queued"
	StageBuilding  = "building"
	StageDeploying = "deploying"
	StageWaiting   = "waiting for the terminal"
	StageVerifying = "verifying"
	StageDone      = "done"
	StageFailed    = "failed"
)

// Deployer plans and runs deploys.
type Deployer struct {
	Config    Config
	Runner    Runner
	Collector Collector
	// Exec runs a local command; ExecLocal by default.
	Exec func(ctx context.Context, spec ExecSpec) error
	// Latest reads the newest releases; LatestReleases by default.
	Latest func(ctx context.Context) (Latest, error)
	// Artifacts builds and downloads what a deploy installs.
	Artifacts Artifacts
	// LogDir holds one log per host per deploy.
	LogDir   string
	Progress func(Event)
	// Echo also receives every build and install log line, prefixed with
	// its host, for a deploy watched on a terminal.
	Echo io.Writer

	// The checkout shipped to builder hosts, packed once per deploy.
	archiveOnce  sync.Once
	archiveStamp checkoutStamp
	archivePath  string
	archiveErr   error
}

// resetArchive forgets (and removes) the last deploy's checkout archive.
func (d *Deployer) resetArchive() {
	if d.archivePath != "" {
		if err := os.Remove(d.archivePath); err != nil && !os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelWarn, logTag, "could not remove the checkout archive", map[string]any{"path": d.archivePath, "error": err.Error()})
		}
	}
	d.archiveOnce, d.archiveStamp, d.archivePath, d.archiveErr = sync.Once{}, checkoutStamp{}, "", nil
}

// Prepared is a deploy ready to run: its targets, the fleet's statuses now,
// the new builds' formats, and what they change.
type Prepared struct {
	Request   Request
	Targets   []Target
	Statuses  []HostStatus
	Formats   map[string][]compat.Format
	Preflight Preflight
	Latest    Latest
	// Builds are where a dev deploy builds each artifact.
	Builds []BuildPlan
}

// Prepare resolves the targets and computes the preflight. It builds nothing
// the operator has not agreed to: a dev preflight reads the checkout's
// registries, a release preflight reads the published artifacts.
func (d *Deployer) Prepare(ctx context.Context, req Request) (*Prepared, error) {
	if req.Source != SourceDev && req.Source != SourceRelease {
		return nil, fmt.Errorf("source must be %q or %q", SourceDev, SourceRelease)
	}
	if len(req.Hosts) == 0 {
		return nil, errors.New("name at least one host")
	}
	if req.Source == SourceDev && req.Checkout == "" && req.Artifact == "" {
		return nil, errors.New(`a dev deploy builds from a checkout: set "checkout" in ~/.ion/fleet.json, or pass --source PATH (--source . builds this folder)`)
	}
	p := &Prepared{Request: req, Formats: map[string][]compat.Format{}}
	for _, h := range req.Hosts {
		if h.External() {
			return nil, h.ErrExternal()
		}
		component := req.Component
		if component == "" {
			component = h.Kind
		}
		if component != h.Kind {
			return nil, fmt.Errorf("%s is a %s host; it takes the %s component", h.Name, h.Kind, h.Kind)
		}
		plat, err := d.Runner.Platform(ctx, h)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", h.Name, err)
		}
		if plat.Windows() && component == ComponentServer {
			return nil, fmt.Errorf("%s runs Windows, which has no Studio Server bundle; it takes the desktop", h.Name)
		}
		p.Targets = append(p.Targets, Target{Host: h, Component: component, GOOS: plat.GOOS, GOARCH: plat.GOARCH})
	}
	if err := d.planBuilds(ctx, p); err != nil {
		return nil, err
	}
	latest := d.Latest
	if latest == nil {
		latest = LatestReleases
	}
	if req.Source == SourceRelease {
		var err error
		if p.Latest, err = latest(ctx); err != nil {
			return nil, err
		}
	}
	for _, t := range p.Targets {
		formats, err := d.Artifacts.TargetFormats(ctx, req.Checkout, req.Source, t, p.Latest)
		if err != nil {
			if req.Source == SourceRelease && errors.Is(err, errNoRelease) {
				return nil, fmt.Errorf("%s: %w", t.Host.Name, err)
			}
			utils.LogWithFields(utils.LevelWarn, logTag, "deploy preflight: new build's formats unreadable", map[string]any{"fleet_host": t.Host.Name, "error": err.Error()})
		}
		p.Formats[t.Host.Name] = formats
	}
	var read []string
	p.Statuses, read = d.statuses(ctx, req.Known)
	p.Preflight = ComputePreflight(p.Statuses, p.Formats)
	utils.LogWithFields(utils.LevelInfo, logTag, "deploy prepared", map[string]any{
		"source": req.Source, "targets": targetNames(p.Targets), "changes": len(p.Preflight.Changes), "downgrades": len(p.Preflight.Downgrades), "unknown": p.Preflight.Unknown,
		"unreadable": len(p.Preflight.Unreadable), "read_hosts": read, "known_hosts": len(p.Statuses) - len(read),
	})
	return p, nil
}

// statuses is every fleet host's status, in fleet order: the known ones as
// given, the rest read now. It also returns the names it read.
func (d *Deployer) statuses(ctx context.Context, known []HostStatus) ([]HostStatus, []string) {
	byName := make(map[string]HostStatus, len(known))
	for _, st := range known {
		byName[st.Host.Name] = st
	}
	var missing []Host
	for _, h := range d.Config.Hosts {
		if _, ok := byName[h.Name]; !ok {
			missing = append(missing, h)
		}
	}
	read := make([]string, 0, len(missing))
	for _, st := range d.Collector.Collect(ctx, missing) {
		byName[st.Host.Name] = st
		read = append(read, st.Host.Name)
	}
	out := make([]HostStatus, 0, len(d.Config.Hosts))
	for _, h := range d.Config.Hosts {
		out = append(out, byName[h.Name])
	}
	return out, read
}

func targetNames(ts []Target) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.Host.Name)
	}
	sort.Strings(out)
	return out
}

// PlanLines describes the deploy before it runs.
func (p *Prepared) PlanLines() []string {
	source := p.Request.Source
	if p.Request.Source == SourceDev {
		source = "dev build of " + p.Request.Checkout
	}
	out := []string{"Deploying the " + source + ":"}
	for _, t := range p.Targets {
		note := ""
		switch {
		case t.Component != ComponentDesktop:
		case p.Request.Install.QuitIon:
			note = " (Ion there quits: its running conversations stop)"
		default:
			note = " (stops if Ion is running there; --quit-ion quits it)"
		}
		if t.Host.AskSudo && t.GOOS == "darwin" {
			note += " (asks for its sudo password on this terminal, after the others)"
		}
		out = append(out, fmt.Sprintf("  %s: %s %s/%s%s", t.Host.Name, t.Component, t.GOOS, t.GOARCH, note))
	}
	if len(p.Builds) > 0 && !p.Request.NoBuild {
		out = append(out, "Builds:")
		for _, b := range p.Builds {
			out = append(out, b.Line())
		}
	}
	return append(out, p.Preflight.Lines()...)
}

// logPath is this deploy's log for one host.
func (d *Deployer) logPath(name, stamp string) string {
	return filepath.Join(d.LogDir, name+"-"+stamp+".log")
}

func (d *Deployer) emit(host, stage, detail string) {
	utils.LogWithFields(utils.LevelInfo, logTag, "deploy stage", map[string]any{"fleet_host": host, "stage": stage, "detail": detail})
	if d.Progress != nil {
		d.Progress(Event{Host: host, Stage: stage, Detail: detail})
	}
}
