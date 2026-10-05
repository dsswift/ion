package fleet

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// A host that installs on itself can still fail at it: it refuses once asked,
// the sent build does not arrive, or it never comes back. When the host has
// an SSH target, the deploy then installs over SSH instead, the way it does
// for a host that cannot install on itself at all. Only a failure SSH cannot
// get around ends the deploy for that host.

// fallbackTargets are the self-install targets that failed and can be
// installed over SSH instead.
func fallbackTargets(ctx context.Context, targets []Target, results []Result) []int {
	if ctx.Err() != nil {
		return nil
	}
	var out []int
	for i, t := range targets {
		if t.Refusal == "" && t.Self && !results[i].OK && t.Host.SSH != "" {
			out = append(out, i)
		}
	}
	return out
}

// fallBack installs one target over SSH after its self-install failed with
// selfRes. The SSH attempt writes its own log, beside the first one.
func (d *Deployer) fallBack(ctx context.Context, p *Prepared, t Target, selfRes Result, arts map[string]artifact, keys map[string]string, keyErrs map[string]error, stamp string) Result {
	h := t.Host
	reason := selfRes.Error
	utils.LogWithFields(utils.LevelInfo, logTag, "self-install failed; installing over ssh", map[string]any{"fleet_host": h.Name, "error": reason})
	d.emit(h.Name, StageDeploying, "installing on itself failed; installing over SSH instead")

	ssh := t
	ssh.Self = false
	ssh.fallback = true
	key := artifactKey(ssh)
	if _, ok := arts[key]; !ok && needsArtifact(p, ssh) {
		// A release that installs on itself is downloaded by the host; over
		// SSH this machine fetches it.
		arts[key] = d.artifactFor(ctx, p, ssh, key, stamp)
	}
	res := d.deployOne(ctx, p, ssh, arts, keys, keyErrs, stamp, true)
	if res.OK {
		res.FellBack = "installing on itself failed (" + reason + "); installed over SSH instead"
	} else {
		res.Error = fmt.Sprintf("installing on itself failed (%s); over SSH: %s", reason, res.Error)
		d.emit(h.Name, StageFailed, res.Error)
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "ssh fallback finished", map[string]any{"fleet_host": h.Name, "ok": res.OK, "error": res.Error})
	return res
}

// needsArtifact: everything installed over SSH installs a file this machine
// has, except a server release, which the host's own `ion studio update`
// downloads.
func needsArtifact(p *Prepared, t Target) bool {
	return t.Component != ComponentServer || p.sourceOf(t) != SourceRelease
}
