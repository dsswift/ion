package main

// cmd_mcp_oauth.go — the OAuth client flags shared by `ion mcp add` and
// `ion mcp update`, and the update subcommand itself.

import (
	"fmt"
	"os"
)

// mcpOAuthFlags maps each CLI flag to its mcpOAuth wire key. --oauth-scope, not
// --scope: on add, --scope already names the config layer.
var mcpOAuthFlags = []struct{ flag, key string }{
	{"client-id", "clientId"},
	{"client-secret", "clientSecret"},
	{"auth-url", "authUrl"},
	{"token-url", "tokenUrl"},
	{"oauth-scope", "scope"},
	{"resource", "resource"},
}

// mcpOAuthFromFlags lays the OAuth flags given on the command line over base
// and reports whether any was given. An empty value (--client-id "") clears
// that setting and leaves it to discovery.
func mcpOAuthFromFlags(flags map[string]string, base map[string]interface{}) (map[string]interface{}, bool) {
	out := make(map[string]interface{}, len(base)+len(mcpOAuthFlags))
	for key, value := range base {
		out[key] = value
	}
	touched := false
	for _, f := range mcpOAuthFlags {
		value, given := flags[f.flag]
		if !given {
			continue
		}
		touched = true
		out[f.key] = value
	}
	return out, touched
}

// currentMcpOAuth returns a server's configured OAuth settings as mcp_list
// reports them, without the secret flag, so an update that names one setting
// keeps the others.
func currentMcpOAuth(name string) map[string]interface{} {
	result := mcpSend(map[string]interface{}{"cmd": "mcp_list"})
	data, _ := result["data"].(map[string]interface{}) //nolint:errcheck // handled as "not configured" below
	rawServers, _ := data["servers"].([]interface{})   //nolint:errcheck // handled as "not configured" below
	for _, raw := range rawServers {
		server, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if serverName, _ := server["name"].(string); serverName != name { //nolint:errcheck // mismatch skips
			continue
		}
		oauth, _ := server["oauth"].(map[string]interface{}) //nolint:errcheck // absent means no configured client
		base := make(map[string]interface{}, len(oauth))
		for key, value := range oauth {
			if key != "hasClientSecret" {
				base[key] = value
			}
		}
		return base
	}
	fmt.Fprintf(os.Stderr, "Error: MCP server %q is not configured\n", name)
	os.Exit(1)
	return nil
}

func cmdMcpUpdate(args []string, flags map[string]string, listFlags map[string][]string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Error: ion mcp update requires a server name")
		os.Exit(1)
	}
	name := args[0]

	msg := map[string]interface{}{"cmd": "mcp_update", "mcpName": name}
	url := flags["url"]
	if len(args) > 1 && url == "" {
		url = args[1]
	}
	if url != "" {
		msg["mcpUrl"] = url
	}
	if transport := flags["transport"]; transport != "" {
		msg["mcpTransport"] = transport
	}
	if command := flags["command"]; command != "" {
		msg["mcpCommand"] = command
	}
	if cmdArgs := listFlags["arg"]; len(cmdArgs) > 0 {
		msg["mcpArgs"] = cmdArgs
	}
	if _, touched := mcpOAuthFromFlags(flags, nil); touched {
		oauth, _ := mcpOAuthFromFlags(flags, currentMcpOAuth(name))
		msg["mcpOAuth"] = oauth
	}
	if len(msg) == 2 {
		fmt.Fprintln(os.Stderr, "Error: ion mcp update needs at least one setting to change")
		printMcpUsage()
		os.Exit(1)
	}

	result := mcpSend(msg)
	data, _ := result["data"].(map[string]interface{}) //nolint:errcheck // absent data prints the generic line
	changed, _ := data["changed"].(bool)               //nolint:errcheck // absent means unchanged
	cleared, _ := data["credentialsCleared"].(bool)    //nolint:errcheck // absent means kept

	if !changed {
		fmt.Printf("MCP server %q already has these settings\n", name)
		return
	}
	fmt.Printf("Updated MCP server %q\n", name)
	if cleared {
		fmt.Printf("Its stored authorization no longer applies. Run: ion mcp login %s\n", name)
	}
}
