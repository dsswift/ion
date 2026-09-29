package main

// cmd_studio_pair.go — `ion studio pair [--label L] [--as PERSON] [--scopes a,b] [--relay] [--code] [--json]`.
//
// The link-minting logic lives in the server (server/src/cli/pair.ts,
// bundled as dist/pair.js) because it is the server's own auth registry that
// records the link. This command only execs it with the bundled Node and the
// right data dir, so a consumer never has to know where either lives.

import (
	"fmt"
	"os"

	"github.com/dsswift/ion/engine/internal/utils"
)

func studioPair(l studioLayout, flags map[string]string) {
	desktop, err := locateDesktop()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, studioTag, "desktop install unreadable; pairing through the bundle only", map[string]any{"error": err.Error()})
	}
	runtimeBin, script, env, err := studioServerCLI(l, desktop, "pair.js")
	if err != nil {
		studioFail("locate pair.js", err)
	}
	args := studioPairArgs(flags)
	utils.LogWithFields(utils.LevelInfo, studioTag, "minting pairing link", map[string]any{"args": args, "pair_js": script})
	if err := runVisible(env, runtimeBin, append([]string{script}, args...)...); err != nil {
		studioFail("pair", err)
	}
}

// studioServerCLI picks a server CLI (pair.js, clients.js) to run and the
// runtime to run it with: the Studio Server bundle's with its Node, else the
// desktop app's with the app itself as Node (ELECTRON_RUN_AS_NODE), since a
// desktop host has no bundle but runs the same server.
func studioServerCLI(l studioLayout, desktop *desktopInstall, name string) (runtimeBin, script string, env []string, err error) {
	env = []string{"ION_DATA_DIR=" + l.dataDir, "HOME=" + l.home}
	bundled := l.serverScript(name)
	if _, statErr := os.Stat(bundled); statErr == nil {
		return l.nodeBin(), bundled, env, nil
	}
	if desktop != nil {
		fromDesktop := desktop.serverFile(name)
		if _, statErr := os.Stat(fromDesktop); statErr == nil {
			utils.LogWithFields(utils.LevelDebug, studioTag, "no studio server bundle; running the desktop app's server CLI", map[string]any{"app": desktop.Root, "script": name})
			return desktop.executable(), fromDesktop, append(env, "ELECTRON_RUN_AS_NODE=1"), nil
		}
	}
	return "", "", nil, fmt.Errorf("%s is missing and no Ion desktop is installed; is the Studio server installed?", bundled)
}

// studioPairArgs maps the studio flags onto pair.js's own flags. `--relay`
// is a bare switch here (parseArgs stores "true"); pair.js takes it the
// same way.
func studioPairArgs(flags map[string]string) []string {
	args := []string{}
	if v := flags["label"]; v != "" && v != "true" {
		args = append(args, "--label", v)
	}
	if v := flags["as"]; v != "" && v != "true" {
		args = append(args, "--as", v)
	}
	if v := flags["scopes"]; v != "" && v != "true" {
		args = append(args, "--scopes", v)
	}
	if flags["relay"] == "true" {
		args = append(args, "--relay")
	}
	if flags["code"] == "true" {
		args = append(args, "--code")
	}
	if flags["json"] == "true" {
		args = append(args, "--json")
	}
	return args
}
