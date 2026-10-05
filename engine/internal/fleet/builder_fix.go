package fleet

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// A host that cannot build is told why (checkBuilder). Two of the reasons
// the fleet can fix on the host itself: build tools it lacks, and a build
// folder Microsoft Defender scans.

// BuilderFix is what PrepareBuilder does to a host.
type BuilderFix struct {
	// Tools installs the build tools the host lacks.
	Tools bool
	// ExcludeBuildDir excludes the host's build folder from Microsoft
	// Defender's real-time scan.
	ExcludeBuildDir bool
}

// psExcludeBuildDir excludes the build folder ($d) from Defender. Only an
// administrator may change Defender's exclusions.
const psExcludeBuildDir = `New-Item -ItemType Directory -Force -Path $d | Out-Null
$full = [IO.Path]::GetFullPath($d)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { [Console]::Error.WriteLine("excluding $full from Microsoft Defender needs an administrator, and this host's SSH user is not one"); exit 5 }
Add-MpPreference -ExclusionPath $full
"excluded $full from Microsoft Defender"
`

var (
	goModToolchain = regexp.MustCompile(`(?m)^toolchain go(\S+)`)
	goModVersion   = regexp.MustCompile(`(?m)^go (\S+)`)
	bundledNode    = regexp.MustCompile(`ION_NODE_VERSION:-(v[0-9][0-9.]*)`)
)

// toolVersions are the Go and Node a checkout builds with: the toolchain its
// engine/go.mod names, and the Node its Studio Server bundle carries.
func toolVersions(checkout string) (goVersion, nodeVersion string, err error) {
	mod, err := os.ReadFile(filepath.Join(checkout, "engine", "go.mod"))
	if err != nil {
		return "", "", fmt.Errorf("read the checkout's Go version: %w", err)
	}
	if m := goModToolchain.FindSubmatch(mod); m != nil {
		goVersion = string(m[1])
	} else if m := goModVersion.FindSubmatch(mod); m != nil {
		goVersion = string(m[1])
	} else {
		return "", "", errors.New("the checkout's engine/go.mod names no Go version")
	}
	pack, err := os.ReadFile(filepath.Join(checkout, "scripts", "package-studio-server.sh"))
	if err != nil {
		return "", "", fmt.Errorf("read the checkout's Node version: %w", err)
	}
	m := bundledNode.FindSubmatch(pack)
	if m == nil {
		return "", "", errors.New("the checkout's scripts/package-studio-server.sh names no Node version")
	}
	return goVersion, string(m[1]), nil
}

// posixInstallTools installs Go and Node under ~/.ion/fleet-build/tools, where
// fleetToolsPath finds them, each checked against its publisher's SHA-256.
// It touches nothing else on the host and needs no sudo.
func posixInstallTools(goVersion, nodeVersion string, wantGo, wantNode bool) string {
	script := `set -e
T="$HOME/.ion/fleet-build/tools"
mkdir -p "$T"
cd "$T"
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64|amd64) GA=amd64; NA=x64 ;;
  arm64|aarch64) GA=arm64; NA=arm64 ;;
  *) echo "unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
`
	if wantGo {
		script += `F="go` + goVersion + `.$OS-$GA.tar.gz"
echo "downloading $F"
curl -fsSL -o "$F" "https://dl.google.com/go/$F"
WANT=$(curl -fsSL "https://dl.google.com/go/$F.sha256")
[ -n "$WANT" ] && [ "$(sha "$F")" = "$WANT" ] || { echo "checksum mismatch for $F" >&2; exit 1; }
rm -rf go
tar xzf "$F"
rm -f "$F"
echo "installed $("$T/go/bin/go" version)"
`
	}
	if wantNode {
		script += `N="node-` + nodeVersion + `-$OS-$NA"
echo "downloading $N.tar.gz"
curl -fsSL -o "$N.tar.gz" "https://nodejs.org/dist/` + nodeVersion + `/$N.tar.gz"
WANT=$(curl -fsSL "https://nodejs.org/dist/` + nodeVersion + `/SHASUMS256.txt" | grep " $N.tar.gz\$" | cut -d' ' -f1)
[ -n "$WANT" ] && [ "$(sha "$N.tar.gz")" = "$WANT" ] || { echo "checksum mismatch for $N.tar.gz" >&2; exit 1; }
rm -rf node "$N"
tar xzf "$N.tar.gz"
mv "$N" node
rm -f "$N.tar.gz"
echo "installed node $("$T/node/bin/node" -v)"
`
	}
	return script
}

// builderComponent is what a host builds when it is a builder: the desktop
// on Windows and on a Mac that runs one, else the Studio Server bundle.
func builderComponent(h Host, plat Platform) string {
	if plat.Windows() || (plat.GOOS == "darwin" && h.Kind != KindServer) {
		return ComponentDesktop
	}
	return ComponentServer
}

// PrepareBuilder fixes what stops a host building and checks it again. On
// Windows the tools come from the checkout's own `make.ps1 setup`, which is
// what a build there would install anyway; on macOS and Linux, Go and Node
// are unpacked under the host's fleet build folder. It returns the host's
// check after the fix, and an error when the host still cannot build.
func (d *Deployer) PrepareBuilder(ctx context.Context, h Host, fix BuilderFix, checkout string, w io.Writer, report func(step string)) (BuilderCheck, error) {
	defer d.resetArchive()
	if h.SSH == "" {
		return BuilderCheck{Host: h.Name}, h.ErrExternal()
	}
	plat, err := d.Runner.Platform(ctx, h)
	if err != nil {
		return BuilderCheck{Host: h.Name}, fmt.Errorf("%s: %w", h.Name, err)
	}
	component := builderComponent(h, plat)
	log := newInstallLog(w, h.Name, InstallOptions{OnStep: report})
	utils.LogWithFields(utils.LevelInfo, logTag, "builder prepare started", map[string]any{"fleet_host": h.Name, "tools": fix.Tools, "exclude_build_dir": fix.ExcludeBuildDir, "platform": plat.String()})
	if fix.ExcludeBuildDir {
		if !plat.Windows() {
			return BuilderCheck{Host: h.Name}, fmt.Errorf("%s does not run Windows; only Windows has Microsoft Defender", h.Name)
		}
		log.step("exclude %s's build folder from Microsoft Defender", h.Name)
		out, err := hostCmd(ctx, d.Runner, h, true, "$d = "+psBuildDir(h.BuildDirOrDefault())+"\n"+psExcludeBuildDir, nil, log)
		log.output(out)
		if err != nil {
			return BuilderCheck{Host: h.Name}, fmt.Errorf("exclude the build folder: %w", err)
		}
	}
	if fix.Tools {
		if err := d.installBuildTools(ctx, h, plat, component, checkout, w, log); err != nil {
			return BuilderCheck{Host: h.Name}, err
		}
	}
	log.step("check %s again", h.Name)
	check := d.checkBuilder(ctx, h, component, plat.GOOS)
	utils.LogWithFields(utils.LevelInfo, logTag, "builder prepare finished", map[string]any{"fleet_host": h.Name, "ok": check.OK(), "problems": check.messages()})
	if !check.OK() {
		return check, errors.New(strings.Join(check.messages(), "; "))
	}
	return check, nil
}

// installBuildTools installs the tools the host lacks for a build of component.
func (d *Deployer) installBuildTools(ctx context.Context, h Host, plat Platform, component, checkout string, w io.Writer, log installLog) error {
	if checkout == "" {
		return errors.New("installing build tools reads their versions from an Ion checkout: name it with --source PATH, or `ion fleet checkout PATH`")
	}
	var missing []string
	for _, p := range d.checkBuilder(ctx, h, component, plat.GOOS).Problems {
		switch {
		case p.Code == ProblemUnreachable:
			return errors.New(p.Message)
		case p.Code == ProblemMissingTools && !p.Fixable:
			if plat.Windows() {
				return fmt.Errorf("%s has no winget to install them with; install App Installer from the Microsoft Store on it", p.Message)
			}
			return fmt.Errorf("%s, and the fleet installs only go, node, and npm; install the rest on the host", p.Message)
		case p.Code == ProblemMissingTools:
			missing = p.Tools
		}
	}
	if len(missing) == 0 {
		log.step("%s already has its build tools", h.Name)
		return nil
	}
	if plat.Windows() {
		if _, err := d.shipCheckout(ctx, h, true, checkout, log); err != nil {
			return err
		}
		log.step("install the build tools on %s (make.ps1 setup); Visual Studio Build Tools is a large download", h.Name)
		arch := map[string]string{"arm64": "arm64", "amd64": "x64"}[plat.GOARCH]
		script := "$d = " + psBuildDir(h.BuildDirOrDefault()) + "\n" + psPrepareBuildDir + psFreshPath + `Set-Location $d
& powershell -NoProfile -ExecutionPolicy Bypass -File .\make.ps1 setup -Arch ` + arch + `
if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("make.ps1 setup exited $LASTEXITCODE"); exit 1 }
`
		if out, stderr, err := d.Runner.RunLogged(ctx, h, script, true, w); err != nil {
			return fmt.Errorf("installing the build tools on %s failed: %s", h.Name, firstNonEmptyString(scriptFailure(out, stderr), err.Error()))
		}
		return nil
	}
	goVersion, nodeVersion, err := toolVersions(checkout)
	if err != nil {
		return err
	}
	wantGo, wantNode := false, false
	for _, t := range missing {
		wantGo = wantGo || t == "go"
		wantNode = wantNode || t == "node" || t == "npm"
	}
	log.step("install %s on %s, under ~/.ion/fleet-build/tools", strings.Join(missing, ", "), h.Name)
	if out, stderr, err := d.Runner.RunLogged(ctx, h, loginShell(posixInstallTools(goVersion, nodeVersion, wantGo, wantNode)), false, w); err != nil {
		return fmt.Errorf("installing the build tools on %s failed: %s", h.Name, firstNonEmptyString(scriptFailure(out, stderr), err.Error()))
	}
	return nil
}
