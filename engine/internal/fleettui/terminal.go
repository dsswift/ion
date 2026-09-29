package fleettui

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"

	tea "charm.land/bubbletea/v2"

	"github.com/dsswift/ion/engine/internal/fleet"
)

// terminalMsg asks the program to hand the terminal to a command (a deploy
// whose host's sudo asks for a password) and report back on done.
type terminalMsg struct {
	spec fleet.ExecSpec
	done chan error
}

// terminalDoneMsg marks the dashboard's return after a handed-over command.
type terminalDoneMsg struct{}

// TerminalExec is the dashboard's Deployer.Exec: a command that needs the
// terminal suspends the dashboard and runs in the foreground; every other
// command runs in the background as usual.
func TerminalExec(send func(tea.Msg)) func(ctx context.Context, spec fleet.ExecSpec) error {
	return func(ctx context.Context, spec fleet.ExecSpec) error {
		if !spec.Interactive {
			return fleet.ExecLocal(ctx, spec)
		}
		done := make(chan error, 1)
		send(terminalMsg{spec: spec, done: done})
		select {
		case err := <-done:
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// specCommand runs an ExecSpec on the terminal Bubble Tea hands over, still
// copying its output into the host's log.
type specCommand struct {
	spec   fleet.ExecSpec
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
}

func (c *specCommand) SetStdin(r io.Reader)  { c.stdin = r }
func (c *specCommand) SetStdout(w io.Writer) { c.stdout = w }
func (c *specCommand) SetStderr(w io.Writer) { c.stderr = w }

func (c *specCommand) Run() error {
	if c.spec.Banner != "" && c.stdout != nil {
		// The dashboard just left the screen; without this the person sees
		// only the command's bare prompt.
		fmt.Fprintf(c.stdout, "\n%s\n\n", c.spec.Banner) //nolint:errcheck // a terminal write; the command's own result is what is reported
	}
	cmd := exec.Command(c.spec.Name, c.spec.Args...)
	cmd.Dir = c.spec.Dir
	cmd.Env = append(os.Environ(), c.spec.Env...)
	cmd.Stdin = c.stdin
	cmd.Stdout = tee(c.spec.Stdout, c.stdout)
	cmd.Stderr = tee(c.spec.Stderr, c.stderr)
	return cmd.Run()
}

func tee(log, terminal io.Writer) io.Writer {
	switch {
	case log == nil:
		return terminal
	case terminal == nil:
		return log
	}
	return io.MultiWriter(log, terminal)
}

// handTerminal runs the command in the foreground and answers the deploy.
func handTerminal(msg terminalMsg) tea.Cmd {
	return tea.Exec(&specCommand{spec: msg.spec}, func(err error) tea.Msg {
		msg.done <- err
		return terminalDoneMsg{}
	})
}
