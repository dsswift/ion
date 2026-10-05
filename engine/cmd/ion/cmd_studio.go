package main

// cmd_studio.go — `ion studio <install|status|restart|update|uninstall|pair>`.
//
// The Ion Studio Server bundle (scripts/package-studio-server.sh) ships the
// engine binary, a Node runtime, and the built server under one directory:
//
//	~/.ion/studio-server/
//	  versions/<server version>/   one extracted bundle per installed version
//	    VERSION                    {"server":..,"engine":..,"node":..}
//	    bin/ion                    this binary
//	    node/bin/node              the bundled Node runtime
//	    server/dist/main.js        the Studio server
//	    server/dist/pair.js        the headless pairing CLI
//	  current -> versions/<v>      the version the services run
//
// The services reference `current`, so an update is "extract the new
// version, repoint the symlink, restart". The engine binary is the natural
// owner of these commands: it is the one thing in the bundle that runs
// before Node does, it already downloads and verifies GitHub releases
// (cmd_upgrade.go), and a consumer gets a single command name on the host.
//
// Every step logs to engine.jsonl under the "studio" tag and prints a human
// line, so a failed install over SSH is diagnosable from the log alone.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/utils"
)

const studioTag = "studio"

// studioServerPort is the TCP port a host's FIRST install listens on. It
// matches the server's own default (server/src/config/server-config.ts
// `listen.tcp.port`). A host is one machine but an install is one account
// on it, so a second account's install takes the next free port; every
// command reads the install's real port from its server.json
// (`resolveStudioPort`) and never assumes this one.
const studioServerPort = 7331

// Service labels. launchd uses them verbatim; systemd derives its unit names
// from the short forms.
const (
	studioEngineLabel = "com.ion.engine"
	studioServerLabel = "com.ion.studio-server"
	studioEngineUnit  = "ion-engine"
	studioServerUnit  = "ion-studio-server"
)

// studioLayout is every path the studio commands touch, resolved once.
type studioLayout struct {
	// dataDir is ION_DATA_DIR for both services: engine.json, engine.sock,
	// studio.sock, server.json, conversations.
	dataDir string
	// root is <dataDir>/studio-server.
	root string
	// current is <root>/current, the symlink the services run from.
	current string
	// versions is <root>/versions.
	versions string
	// home is the service user's home, exported to both services because
	// launchd gives daemons no HOME at all.
	home string
	// user is the service user's login name.
	user string
	// port is the TCP port THIS install's server listens on: read from an
	// existing server.json, else chosen at install (see resolveStudioPort).
	port int
}

func (l studioLayout) nodeBin() string { return filepath.Join(l.current, "node", "bin", "node") }
func (l studioLayout) ionBin() string  { return filepath.Join(l.current, "bin", "ion") }
func (l studioLayout) serverMain() string {
	return filepath.Join(l.current, "server", "dist", "main.js")
}
func (l studioLayout) serverScript(name string) string {
	return filepath.Join(l.current, "server", "dist", name)
}
func (l studioLayout) serverDir() string { return filepath.Join(l.current, "server") }

// resolveStudioLayout builds the layout from --data-dir (else ION_DATA_DIR,
// else ~/.ion) and the current user.
func resolveStudioLayout(flags map[string]string) (studioLayout, error) {
	home, err := utils.UserHomeDir()
	if err != nil {
		return studioLayout{}, fmt.Errorf("resolve home: %w", err)
	}
	dataDir := flags["data-dir"]
	if dataDir == "" {
		dataDir = utils.IonDir()
	}
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		return studioLayout{}, fmt.Errorf("resolve data dir: %w", err)
	}
	// Windows names the account in USERNAME; POSIX shells in USER or LOGNAME.
	user := firstNonEmpty(os.Getenv("USER"), firstNonEmpty(os.Getenv("LOGNAME"), os.Getenv("USERNAME")))
	if user == "" {
		return studioLayout{}, errors.New("cannot determine the service user: none of USER, LOGNAME, or USERNAME is set")
	}
	root := filepath.Join(dataDir, "studio-server")
	l := studioLayout{
		dataDir:  dataDir,
		root:     root,
		current:  filepath.Join(root, "current"),
		versions: filepath.Join(root, "versions"),
		home:     home,
		user:     user,
	}
	l.port, err = resolveStudioPort(l, flags, portFree)
	if err != nil {
		return studioLayout{}, err
	}
	return l, nil
}

// resolveStudioPort decides which port this install's server owns.
//
//   - An existing server.json is authoritative: its listen.tcp.port (else
//     the server's own default) is the port, whatever flags say.
//   - Otherwise --port, when given, is taken as-is and must be free.
//   - Otherwise the first free port from studioServerPort upward. The port
//     is busy when another account's install (or anything else) already
//     listens on it -- a host is shared between accounts and each account
//     is its own install, so the second one moves along rather than
//     colliding with the first.
//
// `free` reports whether a port can be bound; tests substitute it.
func resolveStudioPort(l studioLayout, flags map[string]string, free func(int) bool) (int, error) {
	if port, ok, err := readServerConfigPort(l.dataDir); err != nil {
		return 0, err
	} else if ok {
		utils.LogWithFields(utils.LevelInfo, studioTag, "port from existing server.json", map[string]any{"port": port, "data_dir": l.dataDir})
		return port, nil
	}
	if v := flags["port"]; v != "" && v != "true" {
		port, err := strconv.Atoi(v)
		if err != nil || port < 1 || port > 65535 {
			return 0, fmt.Errorf("--port must be a number between 1 and 65535, got %q", v)
		}
		if !free(port) {
			return 0, fmt.Errorf("--port %d is already in use on this host", port)
		}
		utils.LogWithFields(utils.LevelInfo, studioTag, "port from --port", map[string]any{"port": port})
		return port, nil
	}
	for port := studioServerPort; port < studioServerPort+100; port++ {
		if free(port) {
			if port != studioServerPort {
				utils.LogWithFields(utils.LevelInfo, studioTag, "default port is taken (another account's install?); chose the next free one", map[string]any{"port": port, "default": studioServerPort})
			} else {
				utils.LogWithFields(utils.LevelDebug, studioTag, "default port is free", map[string]any{"port": port})
			}
			return port, nil
		}
	}
	return 0, fmt.Errorf("no free port between %d and %d", studioServerPort, studioServerPort+99)
}

// readServerConfigPort reads listen.tcp.port from an existing server.json.
// ok is false when there is no server.json; a file that exists but names no
// port means the server's own default.
func readServerConfigPort(dataDir string) (port int, ok bool, err error) {
	data, err := os.ReadFile(filepath.Join(dataDir, "server.json"))
	if errors.Is(err, os.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("read server.json: %w", err)
	}
	var cfg struct {
		Listen struct {
			TCP struct {
				Port int `json:"port"`
			} `json:"tcp"`
		} `json:"listen"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return 0, false, fmt.Errorf("parse server.json: %w", err)
	}
	if cfg.Listen.TCP.Port == 0 {
		return studioServerPort, true, nil
	}
	return cfg.Listen.TCP.Port, true, nil
}

// portFree reports whether a TCP port can be bound on every interface.
func portFree(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return false
	}
	ln.Close() //nolint:errcheck // probe listener, nothing to flush
	return true
}

// studioBundleVersion is the VERSION file every bundle carries.
type studioBundleVersion struct {
	Server string `json:"server"`
	Engine string `json:"engine"`
	Node   string `json:"node"`
}

func readBundleVersion(dir string) (studioBundleVersion, error) {
	var v studioBundleVersion
	data, err := os.ReadFile(filepath.Join(dir, "VERSION"))
	if err != nil {
		return v, err
	}
	if err := json.Unmarshal(data, &v); err != nil {
		return v, fmt.Errorf("parse VERSION: %w", err)
	}
	return v, nil
}

// studioUsage is the `ion studio` help text.
const studioUsage = `Usage: ion studio <command> [options]

Manage the Ion Studio Server (engine + server) as a background service on this host.

Commands:
  install      Install and start the engine and Studio server services
    --data-dir DIR          ION_DATA_DIR for both services (default: ~/.ion)
    --port N                TCP port for the server (default: 7331, or the next free port when another
                            account's install already has it; an existing server.json keeps its own)
    --label NAME            Server label shown to clients (default: short hostname)
    --advertise-url URL     Address clients dial from pairing links (default: http://<hostname>:<port>)
    --tenancy shared|isolated
                            shared: every paired device of yours sees every conversation (default)
    --discoverable          Announce this server on the LAN for as long as it runs, so a desktop finds it
                            under Add Environment -> Nearby (default: silent). Pairing still needs a code
                            (ion studio pair --code) or a link. An enterprise seal overrides this.
    --relay wss://URL       Relay this server announces itself on (repeatable with --relay-key)
    --relay-key KEY         Pre-shared key for --relay
    --system                macOS: install system LaunchDaemons (headless host), needs sudo
  status       The whole host: installs (bundle, desktop app), engine running vs installed, load,
               conversations running now, relays, Format Versions, services, logs
               (--json; --no-latest skips the release lookup)
  restart      Restart both services
  update       Download and install the latest bundle, then restart (--yes to skip the prompt).
               --bundle FILE installs a bundle tarball already on this host instead
    [VERSION]               Install this exact server version instead of the latest
  uninstall    Stop and remove the services and the bundle (--purge-data also removes the data dir)
  pair         Mint a one-time pairing link (--label, --as PERSON, --scopes a,b, --relay, --json),
               or a short code for a desktop that found this server nearby (--code)
  relay        Add, change, or remove a relay on an existing install (list | set | remove);
               run 'ion studio relay' for the forms
  open-at-login on|off
               Have the Ion desktop app on this computer open when its person signs in.
               --if-unset leaves a choice already made on this computer alone
`

func cmdStudio(positional []string, flags map[string]string) {
	if len(positional) == 0 {
		fmt.Fprint(os.Stderr, studioUsage)
		os.Exit(1)
	}
	sub, rest := positional[0], positional[1:]
	layout, err := resolveStudioLayout(flags)
	if err != nil {
		studioFail("resolve layout", err)
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "studio command", map[string]any{
		"subcommand": sub, "data_dir": layout.dataDir, "goos": runtime.GOOS,
	})
	switch sub {
	case "install":
		studioInstall(layout, flags)
	case "status":
		studioStatus(layout, flags)
	case "restart":
		studioRestart(layout)
	case "update":
		if bundle := flags["bundle"]; bundle != "" {
			studioUpdateFromBundle(layout, bundle, flags["yes"] == "true")
			return
		}
		studioUpdate(layout, rest, flags["yes"] == "true")
	case "uninstall":
		studioUninstall(layout, flags["purge-data"] == "true")
	case "pair":
		studioPair(layout, flags)
	case "relay":
		studioRelay(layout, rest, flags)
	case "open-at-login":
		studioOpenAtLogin(layout, rest, flags)
	case "help":
		fmt.Print(studioUsage)
	default:
		fmt.Fprintf(os.Stderr, "Unknown studio subcommand: %s\n\n", sub)
		fmt.Fprint(os.Stderr, studioUsage)
		os.Exit(1)
	}
}

// studioFail logs and exits. Every failure branch in this file routes here so
// the log line and the stderr line always agree.
func studioFail(step string, err error) {
	utils.LogWithFields(utils.LevelError, studioTag, "studio command failed", map[string]any{"step": step, "error": err.Error()})
	fmt.Fprintf(os.Stderr, "ion studio: %s: %s\n", step, err)
	os.Exit(1)
}

func studioSay(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	utils.Log(studioTag, msg)
	fmt.Println("==> " + msg)
}

// ---------------------------------------------------------------- install

func studioInstall(l studioLayout, flags map[string]string) {
	if _, err := os.Stat(l.serverMain()); err != nil {
		studioFail("locate bundle", fmt.Errorf("%s is missing; run the installer (install-studio-server.sh) rather than `ion studio install` directly: %w", l.serverMain(), err))
	}
	bundle, err := readBundleVersion(l.current)
	if err != nil {
		studioFail("read bundle VERSION", err)
	}
	studioSay("installing Ion Studio Server %s (engine %s, node %s) into %s", bundle.Server, bundle.Engine, bundle.Node, l.dataDir)

	if err := os.MkdirAll(l.dataDir, 0o700); err != nil {
		studioFail("create data dir", err)
	}
	cfg, err := studioServerConfigDefaults(l, flags)
	if err != nil {
		studioFail("build server.json", err)
	}
	wrote, err := writeServerConfigIfAbsent(l.dataDir, cfg.json)
	if err != nil {
		studioFail("write server.json", err)
	}
	if wrote {
		studioSay("wrote %s (label %q, advertise %s, tenancy %s)", filepath.Join(l.dataDir, "server.json"), cfg.label, cfg.advertiseURL, cfg.tenancy)
	} else {
		studioSay("kept the existing %s", filepath.Join(l.dataDir, "server.json"))
	}
	backendNote, err := ensureStudioEngineBackend(l.dataDir)
	if err != nil {
		studioFail("set engine backend", err)
	}
	studioSay("%s", backendNote)

	mgr, err := newServiceManager(execRunner{}, l, flags["system"] == "true")
	if err != nil {
		studioFail("select service manager", err)
	}
	units := studioUnits(l)
	if mgr.EngineOwnedElsewhere() {
		studioSay("an engine service is already loaded on this host; installing only the Studio server against it")
		units = units[1:]
	}
	for _, u := range units {
		studioSay("installing %s", u.Label)
		if err := mgr.Install(u); err != nil {
			studioFail("install "+u.Label, err)
		}
	}
	studioSay("waiting for the server at http://127.0.0.1:%d/readyz", l.port)
	if err := waitStudioReady(l.port, 90*time.Second); err != nil {
		studioFail("readiness", fmt.Errorf("%w (logs: %s)", err, studioLogHint(l)))
	}
	studioSay("Ion Studio Server %s is running", bundle.Server)
	fmt.Println()
	fmt.Println("Next: mint a pairing link with `ion studio pair --label \"my laptop\"` and paste it into")
	fmt.Println("Settings -> Environments -> Add Environment -> Pairing link on your desktop.")
	// The last stdout line is a machine-readable receipt for the desktop's
	// SSH door, which pipes the installer and reads this one line.
	receipt, err := json.Marshal(map[string]any{"ok": true, "version": bundle.Server, "engine": bundle.Engine, "port": l.port, "user": l.user, "dataDir": l.dataDir})
	if err != nil {
		studioFail("marshal receipt", err)
	}
	fmt.Println(string(receipt))
}

func studioLogHint(l studioLayout) string {
	return fmt.Sprintf("%s, %s", filepath.Join(l.dataDir, "studio-server-stderr.log"), filepath.Join(l.dataDir, "engine-stderr.log"))
}

// studioServerConfig is the resolved server.json the installer writes, with
// the fields the human summary names kept typed beside the JSON shape.
type studioServerConfig struct {
	label        string
	advertiseURL string
	tenancy      string
	scopes       []string
	relays       []map[string]any
	json         map[string]any
}

// studioServerConfigDefaults is the server.json a fresh host gets. Only the
// fields whose defaults differ from the server's own are written, so the
// operator can hand-edit the rest later without fighting the installer.
func studioServerConfigDefaults(l studioLayout, flags map[string]string) (studioServerConfig, error) {
	label := flags["label"]
	if label == "" {
		label = shortHostname()
	}
	tenancy := flags["tenancy"]
	if tenancy == "" {
		tenancy = "shared"
	}
	if tenancy != "shared" && tenancy != "isolated" {
		return studioServerConfig{}, fmt.Errorf("--tenancy must be shared or isolated, got %q", tenancy)
	}
	advertise := flags["advertise-url"]
	if advertise == "" {
		advertise = defaultAdvertiseURL(runtime.GOOS, shortHostname(), l.port)
	}
	if !strings.HasPrefix(advertise, "http://") && !strings.HasPrefix(advertise, "https://") {
		return studioServerConfig{}, fmt.Errorf("--advertise-url must be http(s)://, got %q", advertise)
	}
	// A shared-tenancy host is one person's lab box: every device they pair
	// is theirs, so a pairing link grants admin by default and Settings ->
	// Providers can store keys on this environment. An isolated host is a
	// team pod where admin stays an explicit grant.
	scopes := []string{"conversations:read", "conversations:operate", "terminal:operate", "git:write"}
	if tenancy == "shared" {
		scopes = append(scopes, "admin")
	}
	cfg := studioServerConfig{label: label, advertiseURL: advertise, tenancy: tenancy, scopes: scopes}
	cfg.json = map[string]any{
		"label": label,
		"listen": map[string]any{
			"local": true,
			"lan":   true,
			"tcp":   map[string]any{"host": "0.0.0.0", "port": l.port},
		},
		"pairing": map[string]any{"advertiseUrl": advertise, "defaultScopes": scopes},
		"tenancy": map[string]any{"mode": tenancy},
	}
	if flags["discoverable"] == "true" {
		cfg.json["discovery"] = map[string]any{"advertise": true}
	}
	if relay := flags["relay"]; relay != "" && relay != "true" {
		key := flags["relay-key"]
		if key == "" {
			return studioServerConfig{}, errors.New("--relay needs --relay-key")
		}
		cfg.relays = []map[string]any{{"url": relay, "psk": key}}
		cfg.json["relays"] = cfg.relays
	}
	utils.LogWithFields(utils.LevelDebug, studioTag, "server.json defaults resolved", map[string]any{
		"label": label, "advertise_url": advertise, "tenancy": tenancy, "scopes": scopes, "relay_count": len(cfg.relays), "data_dir": l.dataDir, "port": l.port,
	})
	return cfg, nil
}

// defaultAdvertiseURL picks the address a LAN client is most likely to
// resolve: mDNS `<host>.local` on macOS (Bonjour is always on), the bare
// hostname elsewhere (a Linux box on a home network usually resolves through
// the router's DNS, and `.local` needs avahi).
func defaultAdvertiseURL(goos, host string, port int) string {
	if goos == "darwin" && !strings.HasSuffix(host, ".local") {
		host += ".local"
	}
	return fmt.Sprintf("http://%s:%d", host, port)
}

func shortHostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "ion-host"
	}
	if i := strings.Index(h, "."); i > 0 {
		h = h[:i]
	}
	return strings.ToLower(h)
}

// writeServerConfigIfAbsent writes server.json only when none exists. Returns
// whether it wrote. An existing file is the operator's, never overwritten.
func writeServerConfigIfAbsent(dataDir string, cfg map[string]any) (bool, error) {
	path := filepath.Join(dataDir, "server.json")
	if _, err := os.Stat(path); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return false, err
	}
	return true, os.WriteFile(path, append(data, '\n'), 0o600)
}

// studioEngineBackend is the backend a Studio host's engine gets when its
// engine.json names none: hybrid serves both API and CLI-backed conversations,
// which a remote client cannot switch between without a desktop.
const studioEngineBackend = "hybrid"

// ensureStudioEngineBackend sets the service engine's backend when unset. The
// engine.json is the one in the install's data dir, which is the service's
// ION_DATA_DIR. An explicit backend is the operator's and is kept.
func ensureStudioEngineBackend(dataDir string) (string, error) {
	path := filepath.Join(dataDir, "engine.json")
	wrote, existing, err := config.SetBackendIfUnset(path, studioEngineBackend)
	var managed *config.ManagedConfigWriteError
	if errors.As(err, &managed) {
		return "engine configuration is managed; the backend is left to the managed file", nil
	}
	if err != nil {
		return "", err
	}
	if wrote {
		return fmt.Sprintf("set backend %q in %s", studioEngineBackend, path), nil
	}
	return fmt.Sprintf("kept backend %q in %s", existing, path), nil
}

// waitStudioReady polls /readyz until it answers 200 or the deadline passes.
func waitStudioReady(port int, timeout time.Duration) error {
	url := fmt.Sprintf("http://127.0.0.1:%d/readyz", port)
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close() //nolint:errcheck // probe response body, nothing to read
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			last = fmt.Sprintf("status %d", resp.StatusCode)
		} else {
			last = err.Error()
		}
		time.Sleep(1 * time.Second)
	}
	return fmt.Errorf("server did not become ready within %s (last: %s)", timeout, last)
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// ---------------------------------------------------------------- restart / uninstall

func studioRestart(l studioLayout) {
	mgr, err := newServiceManager(execRunner{}, l, false)
	if err != nil {
		studioFail("select service manager", err)
	}
	for _, u := range studioUnits(l) {
		if mgr.EngineOwnedElsewhere() && u.Label == studioEngineLabel {
			continue
		}
		studioSay("restarting %s", u.Label)
		if err := mgr.Restart(u); err != nil {
			studioFail("restart "+u.Label, err)
		}
	}
	if err := waitStudioReady(l.port, 90*time.Second); err != nil {
		studioFail("readiness", err)
	}
	studioSay("services are back")
}

func studioUninstall(l studioLayout, purgeData bool) {
	mgr, err := newServiceManager(execRunner{}, l, false)
	if err != nil {
		studioFail("select service manager", err)
	}
	units := studioUnits(l)
	for i := len(units) - 1; i >= 0; i-- {
		u := units[i]
		if mgr.EngineOwnedElsewhere() && u.Label == studioEngineLabel {
			continue
		}
		studioSay("removing %s", u.Label)
		if err := mgr.Uninstall(u); err != nil {
			studioFail("uninstall "+u.Label, err)
		}
	}
	studioSay("removing %s", l.root)
	if err := os.RemoveAll(l.root); err != nil {
		studioFail("remove bundle", err)
	}
	if purgeData {
		studioSay("removing data dir %s", l.dataDir)
		if err := os.RemoveAll(l.dataDir); err != nil {
			studioFail("remove data dir", err)
		}
	} else {
		studioSay("kept data dir %s (conversations, engine.json, server.json)", l.dataDir)
	}
}

// ---------------------------------------------------------------- exec helper

// runVisible runs a command with the operator's stdio attached, for the
// interactive steps (a sudo prompt, the pairing CLI).
func runVisible(env []string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = append(os.Environ(), env...)
	return cmd.Run()
}
