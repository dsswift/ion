package network

import (
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// WarmLocalNetwork materializes the macOS Local Network privacy verdict for
// the engine process so that LAN connections succeed for the engine and every
// subprocess it spawns (bash tool children such as kubectl, ssh, curl).
//
// Why this exists: macOS gates LAN traffic per process ("Local Network"
// privacy). The verdict for a process is only materialized when the process
// completes a Network.framework flow to a local host. BSD sockets — which Go's
// net package and virtually every CLI tool use — never trigger that
// materialization; while the verdict is cold they fail with EHOSTUNREACH
// ("no route to host"), silently and with no prompt, for any process running
// in launchd context. Once the engine process completes one Network.framework
// flow, its verdict is warm and BSD-socket LAN traffic from the engine and its
// children flows normally.
//
// The probe is one UDP datagram to the default gateway on port 53 via the
// Network.framework C API (see lanwarmup_darwin.go). The gateway always exists
// when the machine is on a LAN, no service needs to answer, and a completed
// UDP flow is sufficient to warm the verdict. On non-darwin platforms, and on
// darwin builds compiled without cgo, this is a no-op.
//
// This is engine mechanism, not opinion: without it, LAN access from a
// launchd-hosted engine is silently broken on macOS for every consumer.
// Operators who manage Local Network policy externally (MDM) can disable it
// via NetworkConfig.DisableLanWarmup.
func WarmLocalNetwork(cfg *types.NetworkConfig) {
	if !lanWarmupSupported {
		utils.LogWithFields(utils.LevelDebug, "network", "lan warmup skipped: unsupported platform", map[string]any{
			"supported": false,
		})
		return
	}
	if cfg != nil && cfg.DisableLanWarmup {
		utils.LogWithFields(utils.LevelInfo, "network", "lan warmup disabled by config", map[string]any{
			"disable_lan_warmup": true,
		})
		return
	}

	// Retry with backoff rather than probing once. Two first-boot conditions
	// make a single shot unreliable: the engine starts at login, often before
	// Wi-Fi has associated, so gateway discovery can fail transiently; and on
	// the very first warmup of an identity macOS shows the Local Network
	// consent prompt, which parks the probe flow in "waiting" past the probe
	// timeout until the user clicks Allow. Retrying covers both — the loop
	// stops on the first completed flow (the verdict then persists across
	// restarts, so steady-state boots succeed on attempt one).
	for attempt, delay := range lanWarmupSchedule {
		if delay > 0 {
			time.Sleep(delay)
		}

		gateway, err := gatewayFn()
		if err != nil {
			utils.LogWithFields(utils.LevelDebug, "network", "lan warmup attempt: no default gateway yet", map[string]any{
				"attempt": attempt + 1, "attempts_total": len(lanWarmupSchedule), "error": err.Error(),
			})
			continue
		}

		status := probeFn(gateway, lanWarmupTimeoutMs)
		if status == lanWarmReady {
			utils.LogWithFields(utils.LevelInfo, "network", "lan warmup complete: local network verdict materialized", map[string]any{
				"gateway": gateway, "status": "ready", "attempt": attempt + 1,
			})
			return
		}
		utils.LogWithFields(utils.LevelInfo, "network", "lan warmup attempt did not complete, will retry", map[string]any{
			"gateway": gateway, "status": lanWarmStatusName(status), "attempt": attempt + 1,
			"attempts_total": len(lanWarmupSchedule), "timeout_ms": lanWarmupTimeoutMs,
		})
	}

	utils.LogWithFields(utils.LevelError, "network", "lan warmup exhausted all attempts: LAN access may be blocked for engine subprocesses", map[string]any{
		"attempts_total": len(lanWarmupSchedule),
	})
}

// lanWarmupSchedule is the delay before each probe attempt. The early
// attempts cover late Wi-Fi association at login; the later ones give the
// user time to accept the one-time Local Network consent prompt.
var lanWarmupSchedule = []time.Duration{
	0,
	10 * time.Second,
	30 * time.Second,
	60 * time.Second,
	2 * time.Minute,
	5 * time.Minute,
}

// Injection seams for tests; production values are the platform functions.
var (
	gatewayFn = defaultGateway
	probeFn   = lanWarmProbe
)

func lanWarmStatusName(status int) string {
	switch status {
	case lanWarmReady:
		return "ready"
	case lanWarmFailed:
		return "failed"
	case lanWarmTimeout:
		return "timeout"
	default:
		return "unknown"
	}
}

// Probe outcome codes shared between the cgo implementation and the logger.
const (
	lanWarmReady   = 0
	lanWarmFailed  = 1
	lanWarmTimeout = 2

	lanWarmupTimeoutMs = 5000
)

// parseRouteGateway extracts the gateway address from `route -n get default`
// output. Returns "" when no gateway line is present (machine not on a
// routed network).
func parseRouteGateway(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, "gateway:"); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
