//go:build !windows

package studioclient

import (
	"context"
	"net"
)

func localAddress(dataDir string) string { return unixAddress(dataDir) }

func dialLocal(ctx context.Context, address string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", address)
}
