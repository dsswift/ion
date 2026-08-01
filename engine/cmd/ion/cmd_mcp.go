package main

// cmd_mcp.go — `ion mcp` server administration.
//
// Every subcommand is a thin consumer of the engine's mcp_* wire commands. No
// discovery, registration, or OAuth logic lives here: the engine owns the
// mechanism so that the CLI, the desktop, and any third-party client behave
// identically. The CLI's own contribution is the two things a terminal is good
// at — opening the operator's browser, and printing readable output.

import (
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"
)

// mcpLoginPollInterval and mcpLoginTimeout bound the wait for a login to
// complete. The engine's PKCE flow carries its own 5-minute deadline; the CLI
// waits slightly longer so the engine's own timeout is what fires first and the
// operator gets its (more specific) message.
const (
	mcpLoginPollInterval = 1 * time.Second
	mcpLoginTimeout      = 5*time.Minute + 15*time.Second
)

func cmdMcp(args []string, flags map[string]string, listFlags map[string][]string) {
	if len(args) == 0 {
		printMcpUsage()
		os.Exit(1)
	}

	switch args[0] {
	case "add":
		cmdMcpAdd(args[1:], flags, listFlags)
	case "list":
		cmdMcpList()
	case "remove":
		cmdMcpRemove(args[1:])
	case "login":
		cmdMcpLogin(args[1:], flags)
	case "logout":
		cmdMcpLogout(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "Unknown mcp subcommand: %s\n\n", args[0])
		printMcpUsage()
		os.Exit(1)
	}
}

func printMcpUsage() {
	fmt.Fprintln(os.Stderr, "Usage: ion mcp <add|list|remove|login|logout> [args]")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "  add <name> <url>         Add a remote server (http by default)")
	fmt.Fprintln(os.Stderr, "    --transport TYPE       http | sse | ws | stdio")
	fmt.Fprintln(os.Stderr, "    --command CMD          Executable for a stdio server")
	fmt.Fprintln(os.Stderr, "    --arg VALUE            Argument for a stdio server (repeatable)")
	fmt.Fprintln(os.Stderr, "    --header K=V           Static HTTP header (repeatable)")
	fmt.Fprintln(os.Stderr, "    --env K=V              Environment variable for stdio (repeatable)")
	fmt.Fprintln(os.Stderr, "    --scope user           Config layer to write (only \"user\" is supported)")
	fmt.Fprintln(os.Stderr, "  list                     List configured servers and their state")
	fmt.Fprintln(os.Stderr, "  remove <name>            Remove a server and its stored credentials")
	fmt.Fprintln(os.Stderr, "  login <name>             Authorize a server via OAuth in your browser")
	fmt.Fprintln(os.Stderr, "    --scope SCOPE          OAuth scope to request (overrides discovery)")
	fmt.Fprintln(os.Stderr, "    --no-browser           Print the URL instead of opening it")
	fmt.Fprintln(os.Stderr, "  logout <name>            Drop a server's stored credentials")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Example:")
	fmt.Fprintln(os.Stderr, "  ion mcp add mobbin https://api.mobbin.com/mcp")
	fmt.Fprintln(os.Stderr, "  ion mcp login mobbin")
}

// checkMcpScope validates the --scope flag.
//
// Ion has no per-project MCP write path — AddMcpServer edits the user config at
// ~/.ion/engine.json — so "user" is the only honest answer. Accepting and
// ignoring "project" would silently write to the wrong layer, which is worse
// than refusing.
func checkMcpScope(flags map[string]string) {
	scope := flags["scope"]
	if scope == "" || scope == "user" {
		return
	}
	fmt.Fprintf(os.Stderr, "Error: --scope %q is not supported; only \"user\" is (servers are written to ~/.ion/engine.json)\n", scope)
	os.Exit(1)
}

// parseKeyValueFlags turns repeated K=V flag values into a map. A value with no
// "=" is a usage error rather than a silently dropped entry.
func parseKeyValueFlags(label string, values []string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	out := make(map[string]string, len(values))
	for _, raw := range values {
		key, value, found := strings.Cut(raw, "=")
		if !found || key == "" {
			fmt.Fprintf(os.Stderr, "Error: --%s expects KEY=VALUE, got %q\n", label, raw)
			os.Exit(1)
		}
		out[key] = value
	}
	return out
}

func cmdMcpAdd(args []string, flags map[string]string, listFlags map[string][]string) {
	checkMcpScope(flags)

	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Error: ion mcp add requires a server name")
		os.Exit(1)
	}
	name := args[0]

	// The URL is accepted positionally (matching the shape operators copy from
	// vendor docs) or via --url.
	url := flags["url"]
	if len(args) > 1 && url == "" {
		url = args[1]
	}

	msg := map[string]interface{}{
		"cmd":     "mcp_add",
		"mcpName": name,
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
	if headers := parseKeyValueFlags("header", listFlags["header"]); headers != nil {
		msg["mcpHeaders"] = headers
	}
	if env := parseKeyValueFlags("env", listFlags["env"]); env != nil {
		msg["mcpEnv"] = env
	}

	result := mcpSend(msg)
	data, _ := result["data"].(map[string]interface{}) //nolint:errcheck // absent data only affects the echo below
	transport, _ := data["transport"].(string)         //nolint:errcheck // empty transport just prints blank

	fmt.Printf("Added MCP server %q", name)
	if transport != "" {
		fmt.Printf(" (%s)", transport)
	}
	fmt.Println()

	// Authorization is the common next step for a remote server and is easy to
	// miss, so name it rather than leaving the operator to discover a 401.
	if url != "" {
		fmt.Printf("If it requires authorization, run: ion mcp login %s\n", name)
	}
}

func cmdMcpList() {
	result := mcpSend(map[string]interface{}{"cmd": "mcp_list"})

	data, _ := result["data"].(map[string]interface{}) //nolint:errcheck // handled as "no servers" below
	rawServers, _ := data["servers"].([]interface{})   //nolint:errcheck // handled as "no servers" below
	if len(rawServers) == 0 {
		fmt.Println("No MCP servers configured.")
		fmt.Println("Add one with: ion mcp add <name> <url>")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tTRANSPORT\tENDPOINT\tCONNECTED\tAUTH\tTOOLS") //nolint:errcheck // best-effort CLI stdout write
	for _, raw := range rawServers {
		server, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		endpoint, _ := server["url"].(string) //nolint:errcheck // stdio servers report a command instead
		if endpoint == "" {
			endpoint, _ = server["command"].(string) //nolint:errcheck // empty prints blank
		}
		name, _ := server["name"].(string)            //nolint:errcheck // empty prints blank
		transport, _ := server["transport"].(string)  //nolint:errcheck // empty prints blank
		connected, _ := server["connected"].(bool)    //nolint:errcheck // absent means false
		authed, _ := server["authenticated"].(bool)   //nolint:errcheck // absent means false
		toolCount, _ := server["toolCount"].(float64) //nolint:errcheck // JSON numbers decode as float64; absent means 0

		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%d\n", //nolint:errcheck // best-effort CLI stdout write
			name, transport, endpoint, yesNo(connected), authStateLabel(authed), int(toolCount))
	}
	w.Flush() //nolint:errcheck // best-effort CLI stdout flush

	// A stored token that is still being refused is the state worth calling
	// out: "authenticated" plus "not connected" reads as a contradiction unless
	// the reason is shown.
	for _, raw := range rawServers {
		server, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		lastErr, _ := server["lastError"].(string) //nolint:errcheck // absent means no failure recorded
		if lastErr == "" {
			continue
		}
		name, _ := server["name"].(string) //nolint:errcheck // empty prints blank
		fmt.Printf("\n%s: last connection failed: %s\n", name, lastErr)
	}
}

func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}

// authStateLabel renders authorization state. "n/a" is not used: the engine
// cannot know whether a server requires authorization until it is asked, so
// reporting "no" for an unauthenticated server is the honest answer whether or
// not that server needs a token.
func authStateLabel(authenticated bool) string {
	if authenticated {
		return "yes"
	}
	return "no"
}

func cmdMcpRemove(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Error: ion mcp remove requires a server name")
		os.Exit(1)
	}
	name := args[0]
	mcpSend(map[string]interface{}{"cmd": "mcp_remove", "mcpName": name})
	fmt.Printf("Removed MCP server %q and its stored credentials\n", name)
}

func cmdMcpLogin(args []string, flags map[string]string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Error: ion mcp login requires a server name")
		os.Exit(1)
	}
	name := args[0]

	msg := map[string]interface{}{"cmd": "mcp_login", "mcpName": name}
	if scope := flags["scope"]; scope != "" {
		msg["mcpScope"] = scope
	}

	result := mcpSend(msg)
	data, _ := result["data"].(map[string]interface{}) //nolint:errcheck // missing URL handled below
	authURL, _ := data["authorizationUrl"].(string)    //nolint:errcheck // missing URL handled below
	if authURL == "" {
		fmt.Fprintln(os.Stderr, "Error: engine returned no authorization URL")
		os.Exit(1)
	}

	// The URL is always printed, not only on failure: the browser may open in a
	// different profile than the operator expects, and a headless host has no
	// browser at all.
	fmt.Printf("Authorize %s in your browser:\n  %s\n\n", name, authURL)

	if flags["no-browser"] != "true" {
		if err := openBrowser(authURL); err != nil {
			fmt.Fprintf(os.Stderr, "Could not open a browser automatically (%s).\nOpen the URL above by hand.\n\n", err)
		}
	}

	fmt.Println("Waiting for authorization to complete...")
	if waitForMcpAuth(name) {
		fmt.Printf("\n%s is authorized.\n", name)
		return
	}
	fmt.Fprintf(os.Stderr, "\nTimed out waiting for %s to be authorized.\n", name)
	fmt.Fprintf(os.Stderr, "If you completed the browser step, check `ion mcp list` and ~/.ion/engine.jsonl.\n")
	os.Exit(1)
}

// waitForMcpAuth polls mcp_list until the server reports authenticated.
//
// Polling rather than holding the socket open: the engine completes the exchange
// on its own background goroutine and broadcasts a snapshot, and a short-lived
// CLI process has no reason to keep a read loop parked for the whole browser
// round trip. This mirrors how the desktop drives operator OIDC sign-in.
func waitForMcpAuth(name string) bool {
	deadline := time.Now().Add(mcpLoginTimeout)
	for time.Now().Before(deadline) {
		time.Sleep(mcpLoginPollInterval)
		if mcpServerAuthenticated(name) {
			return true
		}
	}
	return false
}

// mcpServerAuthenticated reports one server's authenticated flag. A transport
// failure mid-poll is treated as "not yet" rather than fatal: the daemon may be
// briefly busy, and the enclosing deadline bounds the wait.
func mcpServerAuthenticated(name string) bool {
	response, err := connectAndSend(socketPath(), map[string]interface{}{"cmd": "mcp_list"})
	if err != nil {
		return false
	}
	data, _ := response["data"].(map[string]interface{}) //nolint:errcheck // treated as "not yet"
	rawServers, _ := data["servers"].([]interface{})     //nolint:errcheck // treated as "not yet"
	for _, raw := range rawServers {
		server, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if serverName, _ := server["name"].(string); serverName != name { //nolint:errcheck // mismatch skips
			continue
		}
		authed, _ := server["authenticated"].(bool) //nolint:errcheck // absent means false
		return authed
	}
	return false
}

func cmdMcpLogout(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Error: ion mcp logout requires a server name")
		os.Exit(1)
	}
	name := args[0]
	mcpSend(map[string]interface{}{"cmd": "mcp_logout", "mcpName": name})
	fmt.Printf("Dropped stored credentials for %q\n", name)
}

// mcpSend dispatches one command to the daemon, starting it if necessary, and
// exits with the engine's error message when the command fails.
//
// Starting the daemon matters for `ion mcp add` on a fresh install: the server
// map lives in engine.json, and refusing to add one because no daemon happens to
// be running would be an arbitrary obstacle.
func mcpSend(msg map[string]interface{}) map[string]interface{} {
	sock := socketPath()
	ensureServer(sock)

	response, err := connectAndSend(sock, msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	if ok, _ := response["ok"].(bool); !ok { //nolint:errcheck // absent ok is treated as failure
		errMsg, _ := response["error"].(string) //nolint:errcheck // empty falls back below
		if errMsg == "" {
			errMsg = "engine reported failure with no error message"
		}
		fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
		os.Exit(1)
	}
	return response
}
