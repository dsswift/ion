package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
)

// hookRelayBlockExit is the exit status a hook command uses to refuse the tool
// call. The Claude CLI treats exactly this status as blocking and gives the
// hook's stderr to the model; every other non-zero status is a non-blocking
// error and the tool runs anyway.
const hookRelayBlockExit = 2

// hookRelayUnreachable is what the model is told when the relay could not get
// a decision from the engine.
const hookRelayUnreachable = "Ion could not check this tool call against its permission rules, so the call was refused. Do not retry it. Tell the user that the Ion permission hook is unavailable."

// cmdHookRelay implements `ion hook-relay --url <url>`: the command a delegated
// CLI runs for its PreToolUse hook. It posts the hook payload from stdin to the
// engine's permission hook server and prints the decision it gets back.
//
// The relay exists to fail closed. The hook server is the permission rail for a
// delegated-CLI run, and the CLI lets a tool run whenever its hook command
// fails in any way other than exit status 2. A relay that cannot reach the
// engine, or gets anything but a decision back, therefore exits with status 2.
func cmdHookRelay(flags map[string]string) {
	url := flags["url"]
	if url == "" {
		fmt.Fprintln(os.Stderr, "hook-relay: --url <url> is required")
		os.Exit(hookRelayBlockExit)
	}
	// No client timeout: the engine may hold the request open while a person
	// decides, and the CLI cancels the hook process when the run ends.
	os.Exit(runHookRelay(url, os.Stdin, os.Stdout, os.Stderr, http.DefaultClient))
}

// runHookRelay posts in to url and writes the response body to out. It returns
// the process exit status: 0 when the engine answered, hookRelayBlockExit
// otherwise, with the model-facing reason written to errOut.
func runHookRelay(url string, in io.Reader, out, errOut io.Writer, client *http.Client) int {
	block := func(detail string) int {
		// The first line is for the model; the detail after it is for whoever
		// reads the CLI's hook log.
		fmt.Fprintf(errOut, "%s\n(hook-relay: %s)\n", hookRelayUnreachable, detail) //nolint:errcheck // nothing to do if stderr is gone
		return hookRelayBlockExit
	}

	payload, err := io.ReadAll(in)
	if err != nil {
		return block("read hook payload: " + err.Error())
	}
	resp, err := client.Post(url, "application/json", bytes.NewReader(payload))
	if err != nil {
		return block("post to engine: " + err.Error())
	}
	defer resp.Body.Close() //nolint:errcheck // response body cleanup
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return block("read engine response: " + err.Error())
	}
	if resp.StatusCode != http.StatusOK {
		return block(fmt.Sprintf("engine answered HTTP %d", resp.StatusCode))
	}
	if !bytes.Contains(body, []byte(`"permissionDecision"`)) {
		return block("engine response carried no decision")
	}
	if _, err := out.Write(body); err != nil {
		return block("write decision: " + err.Error())
	}
	return 0
}
