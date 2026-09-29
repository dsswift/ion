package sysmetrics

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/shirou/gopsutil/v4/process"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// mcpBridgeArg is the subcommand the Claude CLI runs the engine's own binary
// with to reach the engine's tool server (`ion mcp-bridge --socket <path>`).
// The engine never starts these itself, so there is no spawn site to register
// them; they are recognised by their first argument instead.
const mcpBridgeArg = "mcp-bridge"

// procKey identifies one process across samples: a pid alone can be reused.
type procKey struct {
	pid     int32
	startMs int64
}

// procState is what the reader remembers about a process between samples.
type procState struct {
	role, name string
	cpuMs      int64
	atMs       int64
}

// procReader walks the engine's process tree and remembers each process's
// previous CPU time, so CPU use can be reported per interval.
type procReader struct {
	rootPid int32
	selfExe string
	prev    map[procKey]procState
	// table is swappable so tests can supply a synthetic process table.
	table func() (map[int32]int32, error)
}

func newProcReader() *procReader {
	exe, err := os.Executable()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "sysmetrics", "own executable path unreadable", map[string]any{"error": err.Error()})
	} else if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil {
		exe = resolved
	}
	return &procReader{
		rootPid: int32(os.Getpid()),
		selfExe: exe,
		prev:    map[procKey]procState{},
		table:   parentTable,
	}
}

// walkTree returns root and every descendant of it, in breadth-first order.
func walkTree(root int32, parents map[int32]int32) []int32 {
	children := map[int32][]int32{}
	for pid, ppid := range parents {
		if pid != ppid {
			children[ppid] = append(children[ppid], pid)
		}
	}
	out := []int32{root}
	seen := map[int32]bool{root: true}
	for i := 0; i < len(out); i++ {
		kids := children[out[i]]
		sort.Slice(kids, func(a, b int) bool { return kids[a] < kids[b] })
		for _, k := range kids {
			if !seen[k] {
				seen[k] = true
				out = append(out, k)
			}
		}
	}
	return out
}

// read samples every process in the engine's tree at nowMs.
func (r *procReader) read(ctx context.Context, nowMs int64) []types.SystemMetricsProcess {
	pids := []int32{r.rootPid}
	tableOK := false
	if parents, err := r.table(); err != nil {
		utils.LogWithFields(utils.LevelWarn, "sysmetrics", "process table read failed; reporting the engine only", map[string]any{"error": err.Error()})
	} else {
		pids = walkTree(r.rootPid, parents)
		tableOK = true
	}

	live := make(map[int32]bool, len(pids))
	next := make(map[procKey]procState, len(pids))
	out := make([]types.SystemMetricsProcess, 0, len(pids))
	for _, pid := range pids {
		live[pid] = true
		p, err := process.NewProcessWithContext(ctx, pid)
		if err != nil {
			continue // exited since the table was read
		}
		start, _ := p.CreateTimeWithContext(ctx) //nolint:errcheck // 0 start time only weakens the pid-reuse guard
		key := procKey{pid: pid, startMs: start}
		st, known := r.prev[key]
		if !known {
			st.role, st.name = r.identify(ctx, p, start)
		}
		row := types.SystemMetricsProcess{Pid: pid, StartTimeMs: start, Role: st.role, Name: st.name}
		if t, err := p.TimesWithContext(ctx); err == nil {
			row.CPUTimeMs = int64((t.User + t.System) * 1000)
			if known {
				if pct, ok := processCPUPercent(st.cpuMs, row.CPUTimeMs, st.atMs, nowMs); ok {
					row.CPUPercent = &pct
				}
			}
			st.cpuMs, st.atMs = row.CPUTimeMs, nowMs
		}
		if m, err := p.MemoryInfoWithContext(ctx); err == nil {
			row.RSSBytes = m.RSS
		}
		next[key] = st
		out = append(out, row)
	}
	r.prev = next
	// Prune only from a complete walk: a failed table read sees the engine
	// alone and would otherwise forget every live child's registration.
	if tableOK {
		pruneRegistry(live)
	}
	return out
}

// identify decides a process's role and name the first time it is seen.
func (r *procReader) identify(ctx context.Context, p *process.Process, startMs int64) (string, string) {
	if p.Pid == r.rootPid {
		return types.SystemMetricsRoleEngine, "ion"
	}
	if reg, ok := lookupRegistration(p.Pid, startMs); ok && isKnownRole(reg.role) {
		return reg.role, reg.name
	}
	if r.isMcpBridge(ctx, p) {
		return types.SystemMetricsRoleMcp, mcpBridgeArg
	}
	name, err := p.NameWithContext(ctx)
	if err != nil || name == "" {
		name = "unknown"
	}
	return types.SystemMetricsRoleTool, filepath.Base(name)
}

// isMcpBridge reports whether p is the engine's own binary running the
// mcp-bridge subcommand. The arguments are read only to decide this; they are
// never stored or sent.
func (r *procReader) isMcpBridge(ctx context.Context, p *process.Process) bool {
	if r.selfExe == "" {
		return false
	}
	exe, err := p.ExeWithContext(ctx)
	if err != nil {
		return false
	}
	if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil {
		exe = resolved
	}
	if exe != r.selfExe {
		return false
	}
	args, err := p.CmdlineSliceWithContext(ctx)
	return err == nil && len(args) > 1 && strings.TrimSpace(args[1]) == mcpBridgeArg
}
