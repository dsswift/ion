//go:build darwin && cgo

package network

/*
#cgo LDFLAGS: -framework Network

#include <stdlib.h>
#include <string.h>
#include <dispatch/dispatch.h>
#include <Network/Network.h>

// ion_lan_warm completes one UDP flow to host:53 via Network.framework.
// Completing a Network.framework flow to a local host is what materializes
// the macOS Local Network privacy verdict for this process; BSD sockets can
// never do it. Returns 0 on a completed send (verdict warmed), 1 on flow
// failure, 2 on timeout.
static int ion_lan_warm(const char *host, int timeout_ms) {
	nw_endpoint_t endpoint = nw_endpoint_create_host(host, "53");
	nw_parameters_t params = nw_parameters_create_secure_udp(
		NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
	nw_connection_t conn = nw_connection_create(endpoint, params);
	nw_release(endpoint);
	nw_release(params);

	dispatch_semaphore_t done = dispatch_semaphore_create(0);
	__block int result = 2; // timeout until proven otherwise

	nw_connection_set_queue(conn, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
	nw_connection_set_state_changed_handler(conn, ^(nw_connection_state_t state, nw_error_t error) {
		if (state == nw_connection_state_failed) {
			result = 1;
			dispatch_semaphore_signal(done);
		}
	});
	nw_connection_start(conn);

	// UDP needs an actual datagram on the wire for the flow to complete.
	// 12 zero bytes; nothing has to answer.
	uint8_t payload[12] = {0};
	dispatch_data_t data = dispatch_data_create(payload, sizeof(payload),
		NULL, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
	nw_connection_send(conn, data, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, true,
		^(nw_error_t error) {
			if (error == NULL && result == 2) {
				result = 0;
			}
			dispatch_semaphore_signal(done);
		});
	dispatch_release(data);

	dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW,
		(int64_t)timeout_ms * NSEC_PER_MSEC));
	nw_connection_cancel(conn);
	nw_release(conn);
	dispatch_release(done);
	// The warmed verdict propagates asynchronously and slowly: subprocesses
	// spawned after the probe completes can still see EHOSTUNREACH for
	// seconds up to about a minute on the FIRST warmup of a given code
	// identity (measured 4-65 s on macOS 26). Once materialized, the verdict
	// persists across process restarts, so subsequent daemon starts are warm
	// immediately. The daemon probes at startup, so in steady state the
	// window never overlaps a tool call.
	return result;
}
*/
import "C"

import (
	"context"
	"errors"
	"os/exec"
	"time"
	"unsafe"
)

var lanWarmupSupported = true // var (not const) so tests can exercise the retry loop on any platform

// lanWarmProbe runs the Network.framework UDP probe against the gateway.
func lanWarmProbe(gateway string, timeoutMs int) int {
	chost := C.CString(gateway)
	defer C.free(unsafe.Pointer(chost))
	return int(C.ion_lan_warm(chost, C.int(timeoutMs)))
}

// defaultGateway resolves the IPv4 default gateway via the system route table.
func defaultGateway() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/sbin/route", "-n", "get", "default").CombinedOutput()
	if err != nil {
		return "", err
	}
	gw := parseRouteGateway(string(out))
	if gw == "" {
		return "", errors.New("no gateway in route output")
	}
	return gw, nil
}
