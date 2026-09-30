package mcp

import (
	"fmt"
	"net/http"
	"sort"

	"github.com/dsswift/ion/engine/internal/secretref"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// resolveMCPSecret is the indirection tests substitute to supply secrets
// without a credential store or application config.
var resolveMCPSecret = secretref.Resolve

// applyMCPSecretHeaders sets each configured secret header on req, resolving
// the secret now so a rotated value takes effect on the next request. MCP
// connections belong to no single extension, so an application config secret
// comes from the common section. A secret that cannot be resolved fails the
// request rather than sending it without the header.
func applyMCPSecretHeaders(req *http.Request, serverName string, headers map[string]types.McpSecretHeader) error {
	if len(headers) == 0 {
		return nil
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		header := headers[name]
		secret, err := resolveMCPSecret(secretref.Reader{}, header.SecretReference)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "mcp", "secret header unavailable", map[string]any{
				"server": serverName, "header": name, "secret_ref": header.SecretRef,
				"source": secretref.Source(header.SecretReference), "error": err.Error(),
			})
			return fmt.Errorf("resolve secret header %s for %s: %w", name, serverName, err)
		}
		req.Header.Set(name, header.Prefix+secret)
	}
	utils.LogWithFields(utils.LevelDebug, "mcp", "secret headers applied", map[string]any{"server": serverName, "headers": names})
	return nil
}
