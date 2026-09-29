package fleet

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
)

// Runner runs scripts on a host. The engine's own exec wrappers are for tools
// inside a session; this is the operator's SSH.
type Runner interface {
	// Run runs a POSIX shell script on a macOS or Linux host.
	Run(ctx context.Context, h Host, script string, stdin io.Reader) (stdout, stderr []byte, err error)
	// RunPowerShell runs a PowerShell script on a Windows host.
	RunPowerShell(ctx context.Context, h Host, script string, stdin io.Reader) (stdout, stderr []byte, err error)
	// Platform reads the host's OS, CPU, and login shell.
	Platform(ctx context.Context, h Host) (Platform, error)
	// CopyTo copies a local file to a path on the host; a relative path is
	// under the host user's home.
	CopyTo(ctx context.Context, h Host, local, remote string) error
	// CopyFrom copies a file on the host to a local path.
	CopyFrom(ctx context.Context, h Host, remote, local string) error
	// RunTerminal runs a POSIX script on a terminal attached to this one, so
	// a sudo prompt on the host can be answered. Output goes to out and to
	// this terminal. banner says what the script will ask for.
	RunTerminal(ctx context.Context, h Host, script, banner string, out io.Writer) error
	// RunLogged runs a script like Run, or RunPowerShell when powershell is
	// set, and also writes its output to log as it arrives: for a build that
	// runs for minutes.
	RunLogged(ctx context.Context, h Host, script string, powershell bool, log io.Writer) (stdout, stderr []byte, err error)
}

// ExecRunner runs over the system ssh (key auth, no prompts), or locally for
// a host whose target is "local".
type ExecRunner struct{}

// sshArgs are the options every fleet ssh call uses: never prompt, fail fast,
// and give up on a host that stops answering mid-command. Without keepalives
// a host that reboots or drops off the network while a long step runs leaves
// ssh waiting on a dead connection forever, since an idle session sends
// nothing that would draw a reset.
var sshArgs = []string{"-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"}

// raw runs one command line in the host's login shell.
func (r ExecRunner) raw(ctx context.Context, h Host, command string, stdin io.Reader) ([]byte, []byte, error) {
	return r.run(ctx, h, command, false, stdin, nil)
}

// run runs a script on h, as a PowerShell script when powershell is set,
// copying its output to log when there is one.
func (r ExecRunner) run(ctx context.Context, h Host, script string, powershell bool, stdin io.Reader, log io.Writer) ([]byte, []byte, error) {
	var cmd *exec.Cmd
	switch {
	case h.SSH == LocalSSH && powershell:
		cmd = localPowerShell(ctx, script)
	case h.SSH == LocalSSH:
		cmd = localCommand(ctx, script)
	default:
		if powershell {
			p, err := r.Platform(ctx, h)
			if err != nil {
				return nil, nil, err
			}
			script = powerShellCommand(p.LoginShell, script)
		}
		cmd = exec.CommandContext(ctx, "ssh", append(append([]string{}, sshArgs...), h.SSH, script)...)
	}
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr, cmd.Stdin = &out, &errOut, stdin
	if log != nil {
		cmd.Stdout, cmd.Stderr = io.MultiWriter(&out, log), io.MultiWriter(&errOut, log)
	}
	err := cmd.Run()
	return out.Bytes(), quietSSH(errOut.Bytes()), err
}

// Run implements Runner.
func (r ExecRunner) Run(ctx context.Context, h Host, script string, stdin io.Reader) ([]byte, []byte, error) {
	return r.run(ctx, h, script, false, stdin, nil)
}

// RunPowerShell implements Runner.
func (r ExecRunner) RunPowerShell(ctx context.Context, h Host, script string, stdin io.Reader) ([]byte, []byte, error) {
	return r.run(ctx, h, script, true, stdin, nil)
}

// RunLogged implements Runner.
func (r ExecRunner) RunLogged(ctx context.Context, h Host, script string, powershell bool, log io.Writer) ([]byte, []byte, error) {
	return r.run(ctx, h, script, powershell, nil, log)
}

// Platform implements Runner.
func (r ExecRunner) Platform(ctx context.Context, h Host) (Platform, error) {
	if h.SSH == LocalSSH {
		return localHostPlatform(), nil
	}
	return cachedPlatform(ctx, r.raw, h)
}

// CopyTo implements Runner.
func (ExecRunner) CopyTo(ctx context.Context, h Host, local, remote string) error {
	if h.SSH == LocalSSH {
		return copyLocal(local, remote)
	}
	return scp(ctx, local, h.SSH+":"+remote)
}

// CopyFrom implements Runner.
func (ExecRunner) CopyFrom(ctx context.Context, h Host, remote, local string) error {
	if h.SSH == LocalSSH {
		return copyLocal(remote, local)
	}
	return scp(ctx, h.SSH+":"+remote, local)
}

func scp(ctx context.Context, from, to string) error {
	var errOut bytes.Buffer
	cmd := exec.CommandContext(ctx, "scp", append(append([]string{"-q"}, sshArgs...), from, to)...)
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("scp %s %s: %w %s", from, to, err, quietSSH(errOut.Bytes()))
	}
	return nil
}

// RunTerminal implements Runner.
func (ExecRunner) RunTerminal(ctx context.Context, h Host, script, banner string, out io.Writer) error {
	spec := terminalCommand(h, script)
	spec.Stdout, spec.Stderr, spec.Banner = out, out, banner
	return ExecLocal(ctx, spec)
}

// terminalCommand runs script on h with this terminal attached: ssh -t, so
// the host's sudo can prompt on it.
func terminalCommand(h Host, script string) ExecSpec {
	if h.SSH == LocalSSH {
		cmd := localCommand(context.Background(), script)
		return ExecSpec{Name: cmd.Path, Args: cmd.Args[1:], Interactive: true}
	}
	return ExecSpec{Name: "ssh", Args: []string{"-t", "-o", "ConnectTimeout=10", h.SSH, script}, Interactive: true}
}

// quietSSH drops the post-quantum advisory OpenSSH prints on every
// connection from some hosts; it is not output of the remote command.
func quietSSH(stderr []byte) []byte {
	var keep []string
	for _, line := range strings.Split(string(stderr), "\n") {
		if strings.Contains(line, "post-quantum") || strings.Contains(line, "store now, decrypt later") || strings.Contains(line, "openssh.com/pq") {
			continue
		}
		keep = append(keep, line)
	}
	return []byte(strings.TrimSpace(strings.Join(keep, "\n")))
}

// sshUnreachable: ssh itself failed (exit 255), as opposed to the remote
// command failing.
func sshUnreachable(err error) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == 255
}

// findIon is the shell that sets $ION to the host's `ion`: the Studio Server
// bundle's, then the desktop app's bundled engine, then ~/.ion/bin/ion. A
// non-interactive ssh shell does not read the profile that puts ~/.ion/bin on
// PATH, so every candidate is an absolute path.
const findIon = `ION=""
for b in "$HOME/.ion/studio-server/current/bin/ion" "/Applications/Ion.app/Contents/Resources/engine/ion" "$HOME/.ion/bin/ion"; do
  if [ -x "$b" ]; then ION="$b"; break; fi
done
if [ -z "$ION" ]; then echo "no ion binary on this host" >&2; exit 3; fi
`

// runIon runs `ion <args>` on the host with the host's own binary, in the
// host's shell.
func runIon(ctx context.Context, r Runner, h Host, args []string, stdin io.Reader) ([]byte, error) {
	p, err := r.Platform(ctx, h)
	if err != nil {
		return nil, err
	}
	var out, stderr []byte
	if p.Windows() {
		quoted := make([]string, len(args))
		for i, a := range args {
			quoted[i] = psQuote(a)
		}
		out, stderr, err = r.RunPowerShell(ctx, h, psFindIon+"& $ion "+strings.Join(quoted, " ")+"\nexit $LASTEXITCODE\n", stdin)
	} else {
		quoted := make([]string, len(args))
		for i, a := range args {
			quoted[i] = shellQuote(a)
		}
		out, stderr, err = r.Run(ctx, h, findIon+`"$ION" `+strings.Join(quoted, " "), stdin)
	}
	if err != nil {
		if len(stderr) > 0 {
			return out, fmt.Errorf("%w: %s", err, stderr)
		}
		return out, err
	}
	return out, nil
}

// shellQuote quotes s for a POSIX shell.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
