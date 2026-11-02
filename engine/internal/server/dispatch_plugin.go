package server

// dispatch_plugin.go — handlers for the plugin_install / plugin_update /
// plugin_list / plugin_remove commands. Split out of dispatch.go, which
// crossed the 800-line file cap; plugin administration is a cohesive,
// independently growing surface that belongs in its own file rather than
// crowding the main dispatch switch.

import (
	"net"

	"github.com/dsswift/ion/engine/internal/plugins"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchPluginInstall fetches and installs a Claude Code-compatible plugin
// with git. cmd.Source carries "owner/repo" or a git URL; cmd.Label, when
// set, names the plugin to take from a marketplace that lists several.
// Returns the installed plugin record in the result data.
func (s *Server) dispatchPluginInstall(conn net.Conn, cmd *protocol.ClientCommand) {
	utils.LogWithFields(utils.LevelInfo, "server", "plugin install", map[string]any{"source": cmd.Source, "plugin": cmd.Label})
	p, err := plugins.Install(cmd.Source, cmd.Label, nil)
	if err != nil {
		s.sendResult(conn, cmd, err, nil)
		return
	}
	s.sendResult(conn, cmd, nil, pluginRecord(p))
}

// dispatchPluginUpdate fetches the current commit of one installed plugin
// (cmd.Label) from where it was installed. The result is the plugin record
// plus whether the commit moved.
func (s *Server) dispatchPluginUpdate(conn net.Conn, cmd *protocol.ClientCommand) {
	utils.LogWithFields(utils.LevelInfo, "server", "plugin update", map[string]any{"name": cmd.Label})
	p, changed, err := plugins.Update(cmd.Label, nil)
	if err != nil {
		s.sendResult(conn, cmd, err, nil)
		return
	}
	rec := pluginRecord(p)
	rec["changed"] = changed
	s.sendResult(conn, cmd, nil, rec)
}

func pluginRecord(p plugins.InstalledPlugin) map[string]any {
	return map[string]any{
		"name":    p.Name,
		"source":  p.Source,
		"version": p.Version,
		"path":    p.InstallPath,
	}
}

// dispatchPluginList returns every installed plugin as a slice of plugin
// records.
func (s *Server) dispatchPluginList(conn net.Conn, cmd *protocol.ClientCommand) {
	installed, err := plugins.ListInstalled()
	if err != nil {
		s.sendResult(conn, cmd, err, nil)
		return
	}
	var infos []map[string]any
	for _, p := range installed {
		infos = append(infos, map[string]any{
			"name":        p.Name,
			"source":      p.Source,
			"version":     p.Version,
			"installedAt": p.InstalledAt,
		})
	}
	s.sendResult(conn, cmd, nil, infos)
}

// dispatchPluginRemove uninstalls a plugin by name. cmd.Label carries the
// plugin name to remove.
func (s *Server) dispatchPluginRemove(conn net.Conn, cmd *protocol.ClientCommand) {
	utils.LogWithFields(utils.LevelInfo, "server", "plugin remove", map[string]any{"name": cmd.Label})
	if err := plugins.Remove(cmd.Label); err != nil {
		s.sendResult(conn, cmd, err, nil)
		return
	}
	s.sendResult(conn, cmd, nil, map[string]any{"removed": cmd.Label})
}
