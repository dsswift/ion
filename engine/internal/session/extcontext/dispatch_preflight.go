package extcontext

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/procres"
	"github.com/dsswift/ion/engine/internal/utils"
)

// probeDispatchSpawn starts one no-op subprocess with piped standard streams.
// A shell command and a child extension host both need exactly that from the
// engine process, so one probe answers for both. A variable so tests can
// stand in an exhausted process without exhausting the test binary.
var probeDispatchSpawn = procres.ProbeSpawn

// preflightDispatchResources checks, before any dispatch state exists, that
// the engine process can still start subprocesses. It returns nil when the
// dispatch may proceed, and a refusal result carrying
// DispatchErrorCodeResourceExhausted when the process is out of descriptors,
// process slots, or memory.
//
// A probe failure that is not resource exhaustion (a missing shell binary,
// say) does not refuse the dispatch: it says nothing about whether the child
// can run, and a child that needs no shell would be refused for no reason.
func preflightDispatchResources(sa SessionAccessor, name string, childDepth int, parentDispatchID string) *extension.DispatchAgentResult {
	descriptors := procres.ReadDescriptors()
	fields := map[string]any{
		"agent_name": name, "child_depth": childDepth,
		"parent_dispatch_id": parentDispatchID, "session_key": sa.SessionKey(),
	}
	descriptors.Fields(fields)

	err := probeDispatchSpawn(context.Background())
	if err == nil {
		utils.LogWithFields(utils.LevelDebug, "server", "dispatch preflight: passed", fields)
		return nil
	}
	fields["error"] = err.Error()
	resource, exhausted := procres.ExhaustedResource(err)
	if !exhausted {
		utils.LogWithFields(utils.LevelWarn, "server", "dispatch preflight: probe failed for a non-resource reason; allowing dispatch", fields)
		return nil
	}
	fields["resource"] = resource
	utils.LogWithFields(utils.LevelError, "server", "dispatch preflight: blocked dispatch, engine process resource exhausted", fields)

	detail := &extension.DispatchResourceExhausted{Resource: resource, Message: err.Error()}
	if descriptors.Open != procres.Unknown {
		detail.OpenDescriptors = descriptors.Open
	}
	if descriptors.Limit != procres.Unknown {
		detail.DescriptorLimit = descriptors.Limit
	}
	return &extension.DispatchAgentResult{
		Name:              name,
		ExitCode:          1,
		ErrorCode:         extension.DispatchErrorCodeResourceExhausted,
		ResourceExhausted: detail,
		Depth:             childDepth,
		ParentDispatchId:  parentDispatchID,
		Output: fmt.Sprintf(
			"dispatch refused (%s): the engine process is out of %s, so child %q was not launched; caller work is intact. "+
				"Every run shares the engine process, so a retry is refused the same way until the engine releases the resource or is restarted.",
			extension.DispatchErrorCodeResourceExhausted, resource, name),
	}
}

// logDispatchDescriptors records the engine process's descriptor reading at
// the end of a dispatch against the reading it started from. The table is
// process-wide, so the delta includes concurrent work; a dispatch that
// repeatedly ends above where it started is where to look for a leak.
func logDispatchDescriptors(sessionKey, dispatchID, name string, start procres.Descriptors) {
	end := procres.ReadDescriptors()
	fields := map[string]any{"session_key": sessionKey, "dispatch_id": dispatchID, "agent_name": name}
	end.Fields(fields)
	if start.Open != procres.Unknown {
		fields["fd_open_start"] = start.Open
	}
	if delta, ok := end.Delta(start); ok {
		fields["fd_delta"] = delta
	}
	utils.LogWithFields(utils.LevelInfo, "server", "dispatch descriptors released", fields)
}
