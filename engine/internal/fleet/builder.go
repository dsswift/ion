package fleet

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// BuildPlan is where one artifact of a dev deploy is built: on this machine
// when it can build that platform, else on the first host of the fleet that
// can. Every host that takes the artifact installs the same one, fetched back
// from the builder.
type BuildPlan struct {
	Key       string `json:"key"`
	Component string `json:"component"`
	GOOS      string `json:"goos"`
	GOARCH    string `json:"goarch"`
	// Builder is the host that builds; nil builds on this machine.
	Builder *Host `json:"builder,omitempty"`
	// Hosts install the artifact.
	Hosts []string `json:"hosts"`
	// Refusal is why nothing can build the artifact; its hosts are not deployed.
	Refusal string `json:"refusal,omitempty"`
	// Candidates are the machines asked to build an artifact nothing can
	// build, each with what stops it.
	Candidates []BuilderCheck `json:"candidates,omitempty"`
}

// Problems that stop a machine building.
const (
	ProblemWrongPlatform = "wrong_platform" // it cannot build this OS and CPU at all
	ProblemNoSSH         = "no_ssh"         // no SSH target to run a build over
	ProblemUnreachable   = "unreachable"    // its tools could not be read
	ProblemMissingTools  = "missing_tools"  // build tools are not installed
	ProblemDefender      = "defender"       // Microsoft Defender scans its build folder
)

// BuildProblem is one thing that stops a machine building.
type BuildProblem struct {
	Code string `json:"code"`
	// Tools are the missing tools of a missing_tools problem.
	Tools []string `json:"tools,omitempty"`
	// Dir is the scanned build folder of a defender problem.
	Dir string `json:"dir,omitempty"`
	// Fixable: PrepareBuilder can fix it.
	Fixable bool `json:"fixable"`
	// Message says the problem in a sentence that starts with the machine's name.
	Message string `json:"message"`
}

// BuilderCheck is whether one machine can build, and what stops it.
type BuilderCheck struct {
	// Host is the fleet host, or empty for this machine.
	Host string `json:"host"`
	// EnvironmentID is the host's catalog id, when it has one.
	EnvironmentID string         `json:"environmentId,omitempty"`
	Problems      []BuildProblem `json:"problems"`
}

// Remedy is the command that fixes the problem on host, or "" when the fleet
// has none.
func (p BuildProblem) Remedy(host string) string {
	switch {
	case p.Code == ProblemMissingTools && p.Fixable:
		return fmt.Sprintf("`ion fleet builder %s --install-tools` installs them", host)
	case p.Code == ProblemDefender:
		return fmt.Sprintf("`ion fleet builder %s --exclude-build-dir` excludes that folder, or `ion fleet set %s --build-dir DIR` builds in another", host, host)
	}
	return ""
}

// OK reports whether the machine can build.
func (c BuilderCheck) OK() bool { return len(c.Problems) == 0 }

func (c BuilderCheck) messages() []string {
	out := make([]string, 0, len(c.Problems))
	for _, p := range c.Problems {
		out = append(out, p.Message)
	}
	return out
}

// Line describes the build for a plan.
func (b BuildPlan) Line() string {
	where := "this machine"
	if b.Builder != nil {
		where = b.Builder.Name + " (this checkout is shipped there, and the result fetched back)"
	}
	return fmt.Sprintf("  the %s builds once on %s, for %s", b.what(), where, strings.Join(b.Hosts, ", "))
}

// what names the artifact: "Windows desktop for amd64".
func (b BuildPlan) what() string {
	what := "Studio Server bundle"
	if b.Component == ComponentDesktop {
		what = "desktop"
	}
	return fmt.Sprintf("%s %s for %s", displayOS(b.GOOS), what, b.GOARCH)
}

func displayOS(goos string) string {
	switch goos {
	case "darwin":
		return "macOS"
	case "windows":
		return "Windows"
	case "linux":
		return "Linux"
	}
	return goos
}

// canBuildHere: a macOS server bundle builds on any Mac (both CPUs); a Linux
// bundle only on Linux of the same CPU (node-pty compiles there); a desktop
// only on its own OS and CPU.
func canBuildHere(component, goos, goarch string, here Platform) bool {
	if component == ComponentServer && goos == "darwin" {
		return here.GOOS == "darwin"
	}
	return here.GOOS == goos && here.GOARCH == goarch
}

// buildTools are the commands a build needs on its builder.
func buildTools(component, goos string) []string {
	switch {
	case component == ComponentServer:
		return []string{"go", "node", "npm", "tar", "curl"}
	case goos == "windows":
		return []string{"go", "node", "npm", "tar"}
	default:
		return []string{"go", "node", "npm", "make"}
	}
}

// planBuilds picks a builder for every artifact a dev deploy builds: this
// machine, else a target of that platform, else any other host of the fleet
// that can build it. An artifact nothing can build is refused, with what
// stops each machine asked; the deploy goes on without its hosts.
func (d *Deployer) planBuilds(ctx context.Context, p *Prepared) {
	req := p.Request
	if req.Artifact != "" {
		return
	}
	here := localPlatform()
	byKey := map[string]*BuildPlan{}
	var order []string
	targetsOf := map[string][]Target{}
	for _, t := range p.Targets {
		if t.Refusal != "" || p.sourceOf(t) != SourceDev {
			continue
		}
		key := artifactKey(t)
		if byKey[key] == nil {
			byKey[key] = &BuildPlan{Key: key, Component: t.Component, GOOS: t.GOOS, GOARCH: t.GOARCH}
			order = append(order, key)
		}
		byKey[key].Hosts = append(byKey[key].Hosts, t.Host.Name)
		targetsOf[key] = append(targetsOf[key], t)
	}
	for _, key := range order {
		b := byKey[key]
		if req.NoBuild {
			p.Builds = append(p.Builds, *b)
			continue
		}
		local := BuilderCheck{}
		if !canBuildHere(b.Component, b.GOOS, b.GOARCH, here) {
			local.Problems = []BuildProblem{{Code: ProblemWrongPlatform, Message: fmt.Sprintf("this machine is %s", here)}}
		} else if missing := missingLocalTools(buildTools(b.Component, b.GOOS)); len(missing) > 0 {
			local.Problems = []BuildProblem{{Code: ProblemMissingTools, Tools: missing, Message: "this machine lacks " + strings.Join(missing, ", ")}}
		}
		if local.OK() {
			p.Builds = append(p.Builds, *b)
			continue
		}
		b.Candidates = []BuilderCheck{local}
		for _, h := range d.builderCandidates(p, *b, targetsOf[key]) {
			check := d.checkBuilder(ctx, h, b.Component, b.GOOS)
			if check.OK() {
				builder := h
				b.Builder, b.Candidates = &builder, nil
				break
			}
			b.Candidates = append(b.Candidates, check)
		}
		if b.Builder == nil {
			var why []string
			for _, c := range b.Candidates {
				why = append(why, c.messages()...)
			}
			b.Refusal = fmt.Sprintf("nothing can build the %s: %s", b.what(), strings.Join(why, "; "))
		}
		p.Builds = append(p.Builds, *b)
	}
	for i, t := range p.Targets {
		if b, ok := p.buildFor(artifactKey(t)); ok && b.Refusal != "" && t.Refusal == "" && p.sourceOf(t) == SourceDev {
			p.Targets[i].Refusal = b.Refusal
		}
	}
	for _, b := range p.Builds {
		builder := "local"
		if b.Builder != nil {
			builder = b.Builder.Name
		}
		utils.LogWithFields(utils.LevelInfo, logTag, "build planned", map[string]any{"artifact": b.Key, "builder": builder, "hosts": b.Hosts, "refusal": b.Refusal, "candidates": len(b.Candidates)})
	}
}

// builderCandidates are the hosts asked to build an artifact, in order: the
// targets that take it, then every other host of the fleet whose last report
// says it runs a platform that can build it. A host that only builds is not
// restarted and installs nothing.
func (d *Deployer) builderCandidates(p *Prepared, b BuildPlan, targets []Target) []Host {
	var out []Host
	seen := map[string]bool{}
	for _, t := range targets {
		seen[t.Host.Name] = true
		out = append(out, t.Host)
	}
	for _, st := range p.Statuses {
		h := st.Host
		if seen[h.Name] || h.SSH == "" || h.SSH == LocalSSH || st.Report == nil || st.Report.Platform == "" {
			continue
		}
		goos, goarch := platformFromReport(st.Report.Platform, st.Report.Arch)
		if !canBuildHere(b.Component, b.GOOS, b.GOARCH, Platform{GOOS: goos, GOARCH: goarch}) {
			continue
		}
		seen[h.Name] = true
		out = append(out, h)
	}
	return out
}

func missingLocalTools(tools []string) []string {
	var missing []string
	for _, t := range tools {
		if !localToolFound(t) {
			missing = append(missing, t)
		}
	}
	return missing
}

// psDefenderScans prints the build folder ($d) when Microsoft Defender scans
// it in real time. electron-builder unpacks Electron there and renames the
// folder, and the rename fails (EPERM) while Defender holds the fresh files.
const psDefenderScans = `$status = Get-MpComputerStatus -ErrorAction SilentlyContinue
if ($status -and $status.RealTimeProtectionEnabled) {
  $full = [IO.Path]::GetFullPath($d).TrimEnd('\') + '\'
  $covered = $false
  foreach ($e in @((Get-MpPreference -ErrorAction SilentlyContinue).ExclusionPath)) {
    if ($e -and $full.StartsWith([IO.Path]::GetFullPath($e).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $covered = $true }
  }
  if (-not $covered) { "defender:$full" }
}
`

// psFreshPath re-reads PATH from the registry: a session opened before a tool
// was installed still has the PATH from before it.
const psFreshPath = `$env:Path = (@([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) | Where-Object { $_ }) -join ';'
`

// fleetToolsPath puts the Go and Node the fleet installed on a POSIX builder
// (PrepareBuilder) ahead of the host's own.
const fleetToolsPath = `export PATH="$HOME/.ion/fleet-build/tools/go/bin:$HOME/.ion/fleet-build/tools/node/bin:$PATH"
`

// installableTools are the tools PrepareBuilder installs on a POSIX builder.
var installableTools = map[string]bool{"go": true, "node": true, "npm": true}

// checkBuilder asks a host whether it can build: its build tools (asked
// through its login shell, so a profile's PATH counts) and, on Windows,
// whether Defender scans its build folder.
func (d *Deployer) checkBuilder(ctx context.Context, h Host, component, goos string) BuilderCheck {
	check := BuilderCheck{Host: h.Name}
	if h.Entry != nil {
		check.EnvironmentID = h.Entry.EnvironmentID
	}
	if h.SSH == "" {
		// Building on a host means running its tools over SSH. A server reached
		// only over its Studio connection can take a build, not make one.
		check.Problems = []BuildProblem{{Code: ProblemNoSSH, Message: fmt.Sprintf("%s has no SSH target to build over (`ion fleet set %s --ssh [user@]host` names one)", h.Name, h.Name)}}
		return check
	}
	tools := buildTools(component, goos)
	var out, stderr []byte
	var err error
	if goos == "windows" {
		script := psFreshPath + "foreach ($t in @('" + strings.Join(tools, "','") + "')) { if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { $t } }\n" +
			"if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { 'nowinget' }\n" +
			"$d = " + psBuildDir(h.BuildDirOrDefault()) + "\n" + psDefenderScans
		out, stderr, err = d.Runner.RunPowerShell(ctx, h, script, nil)
	} else {
		out, stderr, err = d.Runner.Run(ctx, h, loginShell(fleetToolsPath+"for t in "+strings.Join(tools, " ")+"; do command -v $t >/dev/null 2>&1 || echo $t; done"), nil)
	}
	if err != nil {
		check.Problems = []BuildProblem{{Code: ProblemUnreachable, Message: fmt.Sprintf("%s did not answer when asked for its build tools: %v %s", h.Name, err, stderr)}}
		utils.LogWithFields(utils.LevelWarn, logTag, "builder check failed", map[string]any{"fleet_host": h.Name, "error": err.Error()})
		return check
	}
	var missing []string
	winget := true
	defender := ""
	for _, line := range strings.Split(strings.ReplaceAll(string(out), "\r", ""), "\n") {
		word := strings.TrimSpace(line)
		switch {
		case word == "":
		case word == "nowinget":
			winget = false
		case strings.HasPrefix(word, "defender:"):
			defender = strings.TrimPrefix(word, "defender:")
		default:
			missing = append(missing, word)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		fixable := winget
		if goos != "windows" {
			for _, t := range missing {
				fixable = fixable && installableTools[t]
			}
		}
		check.Problems = append(check.Problems, BuildProblem{Code: ProblemMissingTools, Tools: missing, Fixable: fixable, Message: fmt.Sprintf("%s lacks %s", h.Name, strings.Join(missing, ", "))})
	}
	if defender != "" {
		check.Problems = append(check.Problems, BuildProblem{Code: ProblemDefender, Dir: defender, Fixable: true,
			Message: fmt.Sprintf("%s builds in %s, which Microsoft Defender scans, and electron-builder cannot rename its output there", h.Name, defender)})
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "builder checked", map[string]any{"fleet_host": h.Name, "component": component, "goos": goos, "missing": missing, "defender_scans": defender != "", "ok": check.OK()})
	return check
}

// loginShell runs a POSIX script in the host user's login shell, which reads
// the profile that puts Homebrew and Go on PATH; a plain ssh command does not.
func loginShell(script string) string {
	return `exec "${SHELL:-/bin/sh}" -lc ` + shellQuote(script)
}

// buildFor returns the plan that builds key.
func (p *Prepared) buildFor(key string) (BuildPlan, bool) {
	for _, b := range p.Builds {
		if b.Key == key {
			return b, true
		}
	}
	return BuildPlan{}, false
}
