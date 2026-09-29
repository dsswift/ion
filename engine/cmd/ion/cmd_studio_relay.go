package main

// cmd_studio_relay.go — `ion studio relay list|set|remove`.
//
// `ion studio install --relay` names a relay only on a first install, because
// an existing server.json is the operator's and is never rewritten. This verb
// is how an install that already exists gains, changes, or loses a relay: it
// edits the one `relays` key and leaves every other key as it found it.
//
// A pre-shared key never rides the command line, where a process listing
// would show it: it is read from standard input or from a file.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

const studioRelayUsage = `Usage: ion studio relay <command>

  list                          Show the relays in server.json (keys are never printed; --json)
  set wss://URL --oidc          The relay authenticates with OIDC: the server joins with a token
                                from its own operator's identity
  set wss://URL --key-stdin     The relay's pre-shared key is the first line of standard input
  set wss://URL --key-file PATH ... or the first line of a file
  remove wss://URL              Stop using a relay

  --no-restart                  Leave the services running; the change applies at their next start
`

// studioRelayEntry is one server.json `relays[]` entry.
type studioRelayEntry struct {
	url  string
	psk  string
	oidc bool
}

func (e studioRelayEntry) json() map[string]any {
	if e.oidc {
		return map[string]any{"url": e.url, "auth": "oidc"}
	}
	return map[string]any{"url": e.url, "psk": e.psk}
}

func studioRelay(l studioLayout, rest []string, flags map[string]string) {
	if len(rest) == 0 {
		fmt.Fprint(os.Stderr, studioRelayUsage)
		os.Exit(1)
	}
	switch rest[0] {
	case "list":
		relays, err := readStudioRelays(l.dataDir)
		if err != nil {
			studioFail("read relays", err)
		}
		printStudioRelays(relays, flags["json"] == "true")
	case "set":
		if len(rest) < 2 {
			studioFail("relay set", errors.New("name the relay: ion studio relay set wss://URL --oidc | --key-stdin | --key-file PATH"))
		}
		entry, err := studioRelayEntryFromFlags(rest[1], flags, os.Stdin)
		if err != nil {
			studioFail("relay set", err)
		}
		changed, err := setStudioRelay(l.dataDir, entry)
		if err != nil {
			studioFail("relay set", err)
		}
		studioSay("relay %s %s (%s)", entry.url, map[bool]string{true: "saved", false: "already set"}[changed], map[bool]string{true: "oidc", false: "pre-shared key"}[entry.oidc])
		applyStudioRelayChange(l, changed, flags["no-restart"] == "true")
	case "remove":
		if len(rest) < 2 {
			studioFail("relay remove", errors.New("name the relay: ion studio relay remove wss://URL"))
		}
		changed, err := removeStudioRelay(l.dataDir, rest[1])
		if err != nil {
			studioFail("relay remove", err)
		}
		studioSay("relay %s %s", rest[1], map[bool]string{true: "removed", false: "was not configured"}[changed])
		applyStudioRelayChange(l, changed, flags["no-restart"] == "true")
	default:
		fmt.Fprintf(os.Stderr, "Unknown relay subcommand: %s\n\n", rest[0])
		fmt.Fprint(os.Stderr, studioRelayUsage)
		os.Exit(1)
	}
}

// studioRelayEntryFromFlags validates the URL and resolves how the relay
// authenticates. Exactly one of --oidc, --key-stdin, --key-file is required.
func studioRelayEntryFromFlags(url string, flags map[string]string, stdin io.Reader) (studioRelayEntry, error) {
	if !strings.HasPrefix(url, "wss://") && !strings.HasPrefix(url, "ws://") {
		return studioRelayEntry{}, fmt.Errorf("the relay URL must be ws(s)://, got %q", url)
	}
	url = strings.TrimRight(url, "/")
	chosen := 0
	for _, f := range []string{"oidc", "key-stdin", "key-file"} {
		if flags[f] != "" {
			chosen++
		}
	}
	if chosen != 1 {
		return studioRelayEntry{}, errors.New("say how the relay authenticates with exactly one of --oidc, --key-stdin, --key-file PATH")
	}
	if flags["oidc"] != "" {
		return studioRelayEntry{url: url, oidc: true}, nil
	}
	source := stdin
	if path := flags["key-file"]; path != "" {
		f, err := os.Open(path)
		if err != nil {
			return studioRelayEntry{}, fmt.Errorf("open key file: %w", err)
		}
		defer f.Close() //nolint:errcheck // read-only file; a close error changes nothing
		source = f
	}
	line, err := bufio.NewReader(source).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return studioRelayEntry{}, fmt.Errorf("read the relay key: %w", err)
	}
	key := strings.TrimSpace(line)
	if key == "" {
		return studioRelayEntry{}, errors.New("the relay key is empty")
	}
	return studioRelayEntry{url: url, psk: key}, nil
}

// readServerConfigMap reads server.json as a generic map so an edit keeps
// every key it does not understand. A missing file is an empty map: a
// desktop install has none until something writes one.
func readServerConfigMap(dataDir string) (map[string]any, error) {
	data, err := os.ReadFile(filepath.Join(dataDir, "server.json"))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read server.json: %w", err)
	}
	cfg := map[string]any{}
	if err := json.Unmarshal(data, &cfg); err != nil {
		// Refuse rather than guess: rewriting a file that does not parse
		// would destroy whatever the operator has in it.
		return nil, fmt.Errorf("server.json does not parse, so it was left alone: %w", err)
	}
	return cfg, nil
}

func writeServerConfigMap(dataDir string, cfg map[string]any) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dataDir, "server.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readStudioRelays(dataDir string) ([]studioRelayEntry, error) {
	cfg, err := readServerConfigMap(dataDir)
	if err != nil {
		return nil, err
	}
	return studioRelaysOf(cfg), nil
}

func studioRelaysOf(cfg map[string]any) []studioRelayEntry {
	raw, _ := cfg["relays"].([]any) //nolint:errcheck // an absent or non-array relays key reads as none
	var out []studioRelayEntry
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		url, _ := m["url"].(string) //nolint:errcheck // a non-string url is skipped below
		if url == "" {
			continue
		}
		psk, _ := m["psk"].(string) //nolint:errcheck // absent on an oidc entry
		out = append(out, studioRelayEntry{url: url, psk: psk, oidc: m["auth"] == "oidc"})
	}
	return out
}

// setStudioRelay adds the relay, or replaces the entry with the same URL.
// Returns whether server.json changed.
func setStudioRelay(dataDir string, entry studioRelayEntry) (bool, error) {
	cfg, err := readServerConfigMap(dataDir)
	if err != nil {
		return false, err
	}
	relays := studioRelaysOf(cfg)
	replaced := false
	for i, r := range relays {
		if r.url != entry.url {
			continue
		}
		if r == entry {
			utils.LogWithFields(utils.LevelInfo, studioTag, "relay already configured; server.json unchanged", map[string]any{"relay_url": entry.url, "oidc": entry.oidc})
			return false, nil
		}
		relays[i] = entry
		replaced = true
	}
	if !replaced {
		relays = append(relays, entry)
	}
	cfg["relays"] = studioRelaysJSON(relays)
	if err := writeServerConfigMap(dataDir, cfg); err != nil {
		return false, err
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "relay saved to server.json", map[string]any{"relay_url": entry.url, "oidc": entry.oidc, "replaced": replaced, "relay_count": len(relays)})
	return true, nil
}

func removeStudioRelay(dataDir, url string) (bool, error) {
	url = strings.TrimRight(url, "/")
	cfg, err := readServerConfigMap(dataDir)
	if err != nil {
		return false, err
	}
	relays := studioRelaysOf(cfg)
	kept := relays[:0:0]
	for _, r := range relays {
		if r.url != url {
			kept = append(kept, r)
		}
	}
	if len(kept) == len(relays) {
		utils.LogWithFields(utils.LevelInfo, studioTag, "relay was not configured; server.json unchanged", map[string]any{"relay_url": url})
		return false, nil
	}
	cfg["relays"] = studioRelaysJSON(kept)
	if err := writeServerConfigMap(dataDir, cfg); err != nil {
		return false, err
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "relay removed from server.json", map[string]any{"relay_url": url, "relay_count": len(kept)})
	return true, nil
}

func studioRelaysJSON(relays []studioRelayEntry) []any {
	out := make([]any, 0, len(relays))
	for _, r := range relays {
		out = append(out, r.json())
	}
	return out
}

func printStudioRelays(relays []studioRelayEntry, asJSON bool) {
	if asJSON {
		out := make([]map[string]any, 0, len(relays))
		for _, r := range relays {
			out = append(out, map[string]any{"url": r.url, "auth": map[bool]string{true: "oidc", false: "psk"}[r.oidc]})
		}
		data, err := json.Marshal(out)
		if err != nil {
			studioFail("encode relays", err)
		}
		fmt.Println(string(data))
		return
	}
	if len(relays) == 0 {
		fmt.Println("no relays configured")
		return
	}
	for _, r := range relays {
		fmt.Printf("%s  (%s)\n", r.url, map[bool]string{true: "oidc", false: "pre-shared key"}[r.oidc])
	}
}

// applyStudioRelayChange restarts the services so the server reads the new
// relays. A desktop install has no services of its own (its server is the
// desktop's child), so there the change waits for Ion to be relaunched.
func applyStudioRelayChange(l studioLayout, changed, noRestart bool) {
	if !changed {
		return
	}
	if noRestart {
		studioSay("not restarting (--no-restart); the change applies when the server next starts")
		return
	}
	if _, err := os.Stat(l.current); err != nil {
		utils.LogWithFields(utils.LevelInfo, studioTag, "no studio server bundle installed; nothing to restart", map[string]any{"current": l.current})
		studioSay("no Studio server service on this host; quit and reopen Ion to apply the change")
		return
	}
	studioRestart(l)
}
