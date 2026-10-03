package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// rpcScanWikiLinks answers ext/scan_wiki_links: the read-only link integrity
// scan of the calling session's working directory. The result is the report
// itself. A disabled scan, or a context with no session behind it, answers
// with a JSON-RPC error rather than an empty report, so a caller can tell
// "nothing is broken" from "nothing was scanned".
func (h *Host) rpcScanWikiLinks(ctx *Context, id int64, _ []byte) {
	if ctx == nil || ctx.ScanWikiLinks == nil {
		utils.Debug("extension", "ext/scan_wiki_links: no ctx or no scanner wired")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "wiki link scan not available on this context"})
		return
	}
	report, err := ctx.ScanWikiLinks()
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/scan_wiki_links: scan returned error", map[string]any{"error": err.Error()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	data, err := json.Marshal(report)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/scan_wiki_links: marshal failed", map[string]any{"error": err.Error()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/scan_wiki_links: returning", map[string]any{"broken": len(report.Broken), "documents": report.DocumentsScanned})
	h.sendResponse(id, json.RawMessage(data), nil)
}
