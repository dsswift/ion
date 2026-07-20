package rpcstdio

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// RingBuffer holds the last N lines written to it. It captures a subprocess's
// stderr so diagnostics survive past process exit for error reporting. Safe for
// concurrent use.
type RingBuffer struct {
	mu    sync.Mutex
	lines []string
	size  int
}

// NewRingBuffer returns a RingBuffer retaining the most recent size lines.
func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{lines: make([]string, 0, size), size: size}
}

// Write appends a line, evicting the oldest when the buffer is full.
func (rb *RingBuffer) Write(line string) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	if len(rb.lines) >= rb.size {
		rb.lines = rb.lines[1:]
	}
	rb.lines = append(rb.lines, line)
}

// Lines returns a copy of the retained lines, oldest first.
func (rb *RingBuffer) Lines() []string {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	out := make([]string, len(rb.lines))
	copy(out, rb.lines)
	return out
}

// stderrRingSize is the number of stderr lines retained for diagnostics.
const stderrRingSize = 100

// Process is a spawned subprocess wrapped in a JSON-RPC Client. The Client
// speaks JSON-RPC over the process's stdin/stdout; Stderr captures diagnostics.
type Process struct {
	Client *Client
	Stderr *RingBuffer

	cmd      *exec.Cmd
	exited   chan struct{}
	exitOnce sync.Once
	waitErr  error
}

// Spawn launches binPath with args, wires a JSON-RPC Client to its stdin/stdout,
// and pumps its stderr into a RingBuffer. env, when non-nil, is the full
// environment for the child (callers typically append to os.Environ()); a nil
// env inherits the parent's. The returned Process is ready for RPC once this
// returns; the process is reaped in the background and Wait blocks for its exit.
func Spawn(ctx context.Context, binPath string, args []string, env []string, opts Options) (*Process, error) {
	cmd := exec.CommandContext(ctx, binPath, args...)
	if env != nil {
		cmd.Env = env
	} else {
		cmd.Env = os.Environ()
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", binPath, err)
	}
	utils.LogWithFields(utils.LevelInfo, "rpcstdio", "process spawned", map[string]any{"tag": opts.Tag, "bin": binPath, "args": args, "pid": cmd.Process.Pid})

	ring := NewRingBuffer(stderrRingSize)
	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			ring.Write(scanner.Text())
		}
	}()

	p := &Process{
		Client: NewClient(stdin, stdout, opts),
		Stderr: ring,
		cmd:    cmd,
		exited: make(chan struct{}),
	}
	go func() {
		p.waitErr = cmd.Wait()
		utils.LogWithFields(utils.LevelInfo, "rpcstdio", "process exited", map[string]any{"tag": opts.Tag, "bin": binPath, "error": errString(p.waitErr)})
		p.exitOnce.Do(func() { close(p.exited) })
	}()
	return p, nil
}

// Wait blocks until the process exits and returns cmd.Wait's error (nil on a
// clean exit; *exec.ExitError on a non-zero exit).
func (p *Process) Wait() error {
	<-p.exited
	return p.waitErr
}

// Exited returns a channel closed when the process exits.
func (p *Process) Exited() <-chan struct{} { return p.exited }

// Kill terminates the process and closes the Client. Safe to call after exit.
func (p *Process) Kill() {
	if p.cmd.Process != nil {
		p.cmd.Process.Kill() //nolint:errcheck // process teardown
	}
	p.Client.Close() //nolint:errcheck // resource close
}

// StderrTail returns the retained stderr lines for diagnostics.
func (p *Process) StderrTail() []string { return p.Stderr.Lines() }

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
