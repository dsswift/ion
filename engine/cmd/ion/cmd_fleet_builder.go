package main

// cmd_fleet_builder.go — `ion fleet builder`: make a host able to build what a
// deploy from source needs built there.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/dsswift/ion/engine/internal/fleet"
)

const fleetBuilderUsage = `Usage: ion fleet builder HOST [--install-tools] [--exclude-build-dir] [--source dev|PATH] [--events]

Fixes what stops a host building, then checks it again. A deploy from source
builds each platform once: on this machine when it can, else on a host of that
platform. The deploy's plan names what stops a host that cannot.

  --install-tools      Install the build tools the host lacks. On Windows this runs the
                       checkout's own make.ps1 setup (Go, Node, Python, Visual Studio Build
                       Tools, through winget). On macOS and Linux it unpacks Go and Node under
                       ~/.ion/fleet-build/tools on the host, and touches nothing else there
  --exclude-build-dir  Exclude the host's build folder from Microsoft Defender's real-time
                       scan (Windows; the host's SSH user must be an administrator)
  --source dev|PATH    The Ion checkout whose tool versions and setup script are used
                       (default: the fleet file's checkout)
  --events             Print each step, each log line, and the result as JSON, one per line
`

func fleetBuilderCommand(names []string, flags map[string]string) error {
	fix := fleet.BuilderFix{Tools: flags["install-tools"] == "true", ExcludeBuildDir: flags["exclude-build-dir"] == "true"}
	if flags["help"] == "true" || len(names) != 1 || (!fix.Tools && !fix.ExcludeBuildDir) {
		fmt.Print(fleetBuilderUsage)
		if flags["help"] == "true" {
			return nil
		}
		return errors.New("name one host, and --install-tools, --exclude-build-dir, or both")
	}
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	h, ok := cfg.Host(names[0])
	if !ok {
		return fmt.Errorf("no host named %q in the fleet (`ion fleet status` lists them)", names[0])
	}
	checkout := ""
	if fix.Tools {
		source := flagValue(flags, "source")
		if source == "" {
			source = fleet.SourceDev
		}
		kind, dir, err := fleet.ResolveSource(source, cfg)
		if err != nil {
			return err
		}
		if kind != fleet.SourceDev {
			return errors.New("--source must be dev or a path to an Ion checkout")
		}
		checkout = dir
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	events := flags["events"] == "true"
	out := &lineOut{}
	d := newDeployer(cfg, nil)
	report := func(step string) {
		if events {
			out.emit(map[string]any{"event": "stage", "host": h.Name, "stage": "preparing", "detail": step})
		}
	}
	var log *eventLog
	if events {
		log = &eventLog{out: out, hosts: []string{h.Name}}
	}
	check, err := d.PrepareBuilder(ctx, h, fix, checkout, builderLog(log), report)
	if events {
		result := map[string]any{"event": "result", "host": h.Name, "ok": err == nil, "problems": check.Problems}
		if err != nil {
			result["error"] = err.Error()
		}
		out.emit(result)
	}
	if err != nil {
		return fmt.Errorf("%s still cannot build: %w", h.Name, err)
	}
	if !events {
		fmt.Printf("%s can build\n", h.Name)
	}
	return nil
}

// eventLog turns a log into `log` events, one per line.
type eventLog struct {
	out     *lineOut
	hosts   []string
	partial []byte
}

func (l *eventLog) Write(b []byte) (int, error) {
	l.partial = append(l.partial, b...)
	for {
		i := indexNewline(l.partial)
		if i < 0 {
			return len(b), nil
		}
		line := string(l.partial[:i])
		l.partial = l.partial[i+1:]
		if line != "" {
			l.out.emit(map[string]any{"event": "log", "hosts": l.hosts, "line": line})
		}
	}
}

func indexNewline(b []byte) int {
	for i, c := range b {
		if c == '\n' {
			return i
		}
	}
	return -1
}

// builderLog is where a builder fix writes: its events, or this terminal.
func builderLog(events *eventLog) interface{ Write([]byte) (int, error) } {
	if events != nil {
		return events
	}
	return os.Stdout
}
