package fleet

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// BuildPlan is where one artifact of a dev deploy is built: on this machine
// when it can build that platform, else on the first target host of that
// platform that has the tools. Every other host of the platform installs the
// same artifact, fetched back from the builder.
type BuildPlan struct {
	Key       string `json:"key"`
	Component string `json:"component"`
	GOOS      string `json:"goos"`
	GOARCH    string `json:"goarch"`
	// Builder is the host that builds; nil builds on this machine.
	Builder *Host `json:"builder,omitempty"`
	// Hosts install the artifact.
	Hosts []string `json:"hosts"`
}

// Line describes the build for a plan.
func (b BuildPlan) Line() string {
	where := "this machine"
	if b.Builder != nil {
		where = b.Builder.Name + " (this checkout is shipped there, and the result fetched back)"
	}
	what := "Studio Server bundle"
	if b.Component == ComponentDesktop {
		what = "desktop"
	}
	return fmt.Sprintf("  the %s %s for %s builds once on %s, for %s", displayOS(b.GOOS), what, b.GOARCH, where, strings.Join(b.Hosts, ", "))
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

// planBuilds picks a builder for every artifact a dev deploy builds.
func (d *Deployer) planBuilds(ctx context.Context, p *Prepared) error {
	req := p.Request
	if req.Source != SourceDev || req.Artifact != "" {
		return nil
	}
	here := localPlatform()
	byKey := map[string]*BuildPlan{}
	var order []string
	targetsOf := map[string][]Target{}
	for _, t := range p.Targets {
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
		if req.NoBuild || canBuildHere(b.Component, b.GOOS, b.GOARCH, here) {
			if !req.NoBuild {
				if missing := missingLocalTools(buildTools(b.Component, b.GOOS)); len(missing) > 0 {
					return fmt.Errorf("this machine builds the %s/%s %s but lacks %s", b.GOOS, b.GOARCH, b.Component, strings.Join(missing, ", "))
				}
			}
			p.Builds = append(p.Builds, *b)
			continue
		}
		var refusals []string
		for _, t := range targetsOf[key] {
			refusal, err := d.builderRefusal(ctx, t.Host, b.Component, b.GOOS)
			if err == nil && refusal == "" {
				h := t.Host
				b.Builder = &h
				break
			}
			if err != nil {
				refusal = err.Error()
			}
			refusals = append(refusals, t.Host.Name+" "+refusal)
		}
		if b.Builder == nil {
			return fmt.Errorf("nothing can build the %s/%s %s: this machine is %s, and %s", b.GOOS, b.GOARCH, b.Component, here, strings.Join(refusals, "; "))
		}
		p.Builds = append(p.Builds, *b)
	}
	for _, b := range p.Builds {
		builder := "local"
		if b.Builder != nil {
			builder = b.Builder.Name
		}
		utils.LogWithFields(utils.LevelInfo, logTag, "build planned", map[string]any{"artifact": b.Key, "builder": builder, "hosts": b.Hosts})
	}
	return nil
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

// builderRefusal says why a host cannot build, or "" when it can: a build
// tool it lacks (asked through its login shell, so a profile's PATH counts),
// or, on Windows, a build folder Defender scans.
func (d *Deployer) builderRefusal(ctx context.Context, h Host, component, goos string) (string, error) {
	tools := buildTools(component, goos)
	var out, stderr []byte
	var err error
	if goos == "windows" {
		script := "foreach ($t in @('" + strings.Join(tools, "','") + "')) { if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { $t } }\n" +
			"$d = " + psBuildDir(h.BuildDirOrDefault()) + "\n" + psDefenderScans
		out, stderr, err = d.Runner.RunPowerShell(ctx, h, script, nil)
	} else {
		out, stderr, err = d.Runner.Run(ctx, h, loginShell("for t in "+strings.Join(tools, " ")+"; do command -v $t >/dev/null 2>&1 || echo $t; done"), nil)
	}
	if err != nil {
		return "", fmt.Errorf("could not check its tools: %w %s", err, stderr)
	}
	var missing []string
	var reasons []string
	for _, word := range strings.Fields(string(out)) {
		if dir, ok := strings.CutPrefix(word, "defender:"); ok {
			reasons = append(reasons, fmt.Sprintf("builds in %s, which Microsoft Defender scans, and electron-builder cannot rename its output there; set \"buildDir\" on host %q in %s to a folder Defender excludes, or exclude that one", dir, h.Name, DefaultPath()))
			continue
		}
		missing = append(missing, word)
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		reasons = append([]string{"lacks " + strings.Join(missing, ", ")}, reasons...)
	}
	return strings.Join(reasons, "; "), nil
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
