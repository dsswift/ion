package fleet

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Login shells a host's ssh can run a command in.
const (
	ShellPOSIX      = "sh"
	ShellPowerShell = "powershell"
	ShellCmd        = "cmd"
)

// Platform is what a host runs: its OS and CPU in Go's names, and the shell
// its ssh starts a command in.
type Platform struct {
	GOOS   string `json:"goos"`
	GOARCH string `json:"goarch"`
	// LoginShell is the shell ssh runs a command in: sh on macOS and Linux,
	// PowerShell or cmd on Windows (OpenSSH's DefaultShell).
	LoginShell string `json:"loginShell"`
}

// Windows reports whether the host runs Windows.
func (p Platform) Windows() bool { return p.GOOS == "windows" }

// String is the platform as goos/goarch.
func (p Platform) String() string { return p.GOOS + "/" + p.GOARCH }

// rawRun runs one command line in the host's login shell, as given.
type rawRun func(ctx context.Context, h Host, command string, stdin io.Reader) (stdout, stderr []byte, err error)

// probeUname asks a POSIX host its OS and CPU. On Windows it fails: neither
// PowerShell nor cmd has uname.
const probeUname = "uname -s; uname -m"

// probeLoginShell prints the PowerShell edition in PowerShell and the text
// itself in cmd, which does not expand it.
const probeLoginShell = "echo $PSVersionTable.PSEdition"

// probeWindowsArch prints the OS's CPU (Arm64, X64), not the probing
// process's: an emulated PowerShell would report its own.
const probeWindowsArch = `$a = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($a) { "$a" } else { $env:PROCESSOR_ARCHITECTURE }`

// probePlatform reads a host's platform: uname first, else the Windows
// login shell and CPU.
func probePlatform(ctx context.Context, run rawRun, h Host) (Platform, error) {
	out, _, unameErr := run(ctx, h, probeUname, nil)
	if unameErr == nil {
		return parseUname(out)
	}
	if sshUnreachable(unameErr) {
		return Platform{}, fmt.Errorf("unreachable (%v)", unameErr)
	}
	edition, _, err := run(ctx, h, probeLoginShell, nil)
	if err != nil {
		return Platform{}, fmt.Errorf("neither uname nor a Windows shell answered: uname: %v; shell: %w", unameErr, err)
	}
	p := Platform{GOOS: "windows", LoginShell: ShellCmd}
	switch strings.TrimSpace(string(edition)) {
	case "Desktop", "Core":
		p.LoginShell = ShellPowerShell
	}
	arch, stderr, err := run(ctx, h, powerShellCommand(p.LoginShell, probeWindowsArch), nil)
	if err != nil {
		return Platform{}, fmt.Errorf("read the Windows CPU: %w %s", err, stderr)
	}
	switch strings.ToLower(strings.TrimSpace(string(arch))) {
	case "arm64":
		p.GOARCH = "arm64"
	case "x64", "amd64":
		p.GOARCH = "amd64"
	default:
		return Platform{}, fmt.Errorf("unsupported Windows CPU %q", strings.TrimSpace(string(arch)))
	}
	return p, nil
}

func parseUname(out []byte) (Platform, error) {
	lines := strings.Fields(string(out))
	if len(lines) < 2 {
		return Platform{}, fmt.Errorf("unexpected uname output %q", out)
	}
	p := Platform{LoginShell: ShellPOSIX}
	switch lines[0] {
	case "Darwin":
		p.GOOS = "darwin"
	case "Linux":
		p.GOOS = "linux"
	default:
		return Platform{}, fmt.Errorf("unsupported OS %s", lines[0])
	}
	switch lines[1] {
	case "x86_64", "amd64":
		p.GOARCH = "amd64"
	case "arm64", "aarch64":
		p.GOARCH = "arm64"
	default:
		return Platform{}, fmt.Errorf("unsupported arch %s", lines[1])
	}
	return p, nil
}

// psPrelude starts every PowerShell script: no progress records, and any
// error ends the script with its message on stderr and exit 1. Without the
// trap, PowerShell writes errors as CLIXML when its output is redirected.
const psPrelude = `$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`

// powerShellCommand is the command line that runs script on a Windows host
// from its login shell. The script travels base64-encoded (UTF-16LE, as
// -EncodedCommand reads it), so no shell quoting touches it. PowerShell as the
// login shell reports only success or failure for a native command, so the
// line hands on the inner exit code itself; cmd already does.
func powerShellCommand(loginShell, script string) string {
	line := "powershell -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand " + encodePowerShell(psPrelude+script)
	if loginShell == ShellPowerShell {
		line += "; exit $LASTEXITCODE"
	}
	return line
}

// encodePowerShell encodes a script for -EncodedCommand.
func encodePowerShell(script string) string {
	units := utf16.Encode([]rune(script))
	buf := make([]byte, 0, len(units)*2)
	for _, u := range units {
		buf = append(buf, byte(u), byte(u>>8))
	}
	return base64.StdEncoding.EncodeToString(buf)
}

// psQuote quotes s as a PowerShell single-quoted string.
func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// platforms caches each host's platform for the life of the process: a
// host's OS does not change under a running fleet.
var platforms sync.Map // ssh target -> Platform

func cachedPlatform(ctx context.Context, run rawRun, h Host) (Platform, error) {
	if v, ok := platforms.Load(h.SSH); ok {
		if p, ok := v.(Platform); ok {
			return p, nil
		}
	}
	p, err := probePlatform(ctx, run, h)
	if err != nil {
		return Platform{}, err
	}
	platforms.Store(h.SSH, p)
	utils.LogWithFields(utils.LevelInfo, logTag, "host platform read", map[string]any{"fleet_host": h.Name, "platform": p.String(), "login_shell": p.LoginShell})
	return p, nil
}
