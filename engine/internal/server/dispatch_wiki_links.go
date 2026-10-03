package server

import (
	"net"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchScanWikiLinks answers scan_wiki_links with the link integrity
// report for the session's working directory. The scan is read-only. A scan
// turned off in engine config, or an unknown session, answers with an error
// result and reads nothing.
func (s *Server) dispatchScanWikiLinks(conn net.Conn, cmd *protocol.ClientCommand) {
	report, err := s.manager.ScanWikiLinks(cmd.Key)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "server.wikilinks", "scan_wiki_links failed", map[string]any{
			"request_id": cmd.RequestID, "session_id": cmd.Key, "error": err.Error(),
		})
		s.sendResult(conn, cmd, err, nil)
		return
	}
	utils.LogWithFields(utils.LevelInfo, "server.wikilinks", "scan_wiki_links answered", map[string]any{
		"request_id": cmd.RequestID, "session_id": cmd.Key, "documents": report.DocumentsScanned, "broken": len(report.Broken),
	})
	s.sendResult(conn, cmd, nil, report)
}
