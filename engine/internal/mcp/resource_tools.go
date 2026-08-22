package mcp

import (
	"context"
	"fmt"
)

type connectionsContextKey struct{}

// WithConnections binds the active session's MCP connections to a tool context.
// Connection identity cannot be a package-global server name: separate sessions
// may legitimately configure the same name to different endpoints.
func WithConnections(ctx context.Context, conns []*Connection) context.Context {
	return context.WithValue(ctx, connectionsContextKey{}, append([]*Connection(nil), conns...))
}

func connectionsFrom(ctx context.Context) []*Connection {
	conns, ok := ctx.Value(connectionsContextKey{}).([]*Connection)
	if !ok {
		return nil
	}
	return conns
}

func connectionFrom(ctx context.Context, serverName string) (*Connection, error) {
	for _, conn := range connectionsFrom(ctx) {
		if conn != nil && conn.Name() == serverName {
			return conn, nil
		}
	}
	return nil, fmt.Errorf("MCP server %q not connected for this session", serverName)
}

// ListMcpResourcesForContext lists resources from the caller's session-bound
// connection, never a process-global connection selected by a later session.
func ListMcpResourcesForContext(ctx context.Context, serverName string) ([]McpResource, error) {
	conn, err := connectionFrom(ctx, serverName)
	if err != nil {
		return nil, err
	}
	return conn.ListResources(ctx)
}

// ReadMcpResourceForContext reads from the caller's session-bound connection.
func ReadMcpResourceForContext(ctx context.Context, serverName, uri string) (*McpResourceContent, error) {
	conn, err := connectionFrom(ctx, serverName)
	if err != nil {
		return nil, err
	}
	return conn.ReadResource(ctx, uri)
}
