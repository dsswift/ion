package server

// dispatch_plan_content.go — handler for the get_plan_content command.
//
// get_plan_content lets remote clients (e.g. iOS) fetch the byte content of
// a plan file that the engine emitted in a prior plan_mode_changed or
// plan_mode_auto_exit event, without needing filesystem access to the engine
// host. The desktop relays these commands and events transparently.
//
// Wire contract (see engine/docs/protocol.md for the canonical spec):
//
//	Request  → get_plan_content    { key, path, offset, limit }
//	Response → engine_plan_content { planFilePath, offset, content, totalBytes, hasMore }
//	         | result { ok: false, error: "..." }   (security rejection or I/O error)
//
// Security: the handler validates that Path is inside one of the valid plan
// directories for the session before reading any bytes. This prevents clients
// from using the command as an arbitrary host-file-read oracle.
//
// Paging: a single request returns at most defaultPlanWindowBytes (64 KB) of
// UTF-8 content. If the file is larger the client increments Offset by the
// UTF-8 byte length of the returned Content and repeats until HasMore=false.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// defaultPlanWindowBytes is the maximum number of bytes returned per
// get_plan_content request when the client sends Limit=0.
const defaultPlanWindowBytes = 64 * 1024 // 64 KB

// dispatchGetPlanContent handles the get_plan_content command.
//
// It is called from the main dispatch switch in server.go on the
// goroutine that services the requesting client connection. The method
// emits a plan_content event directly to conn (not broadcast) and, in
// error cases, sends a result with ok=false via sendResult.
func (s *Server) dispatchGetPlanContent(conn net.Conn, cmd *protocol.ClientCommand) {
	key := cmd.Key
	reqPath := filepath.Clean(cmd.Path)
	offset := cmd.Offset
	if offset < 0 {
		offset = 0
	}
	limit := cmd.Limit
	if limit <= 0 {
		limit = defaultPlanWindowBytes
	}

	utils.Info("Server", fmt.Sprintf(
		"get_plan_content: key=%s path=%s offset=%d limit=%d",
		key, reqPath, offset, limit,
	))

	// ---- Security: path containment check --------------------------------
	// The plan file must live inside one of the valid plan directories for
	// this session. An attacker who can send engine commands must not be able
	// to read arbitrary host files via this command.
	workingDir := s.manager.SessionWorkingDir(key)
	planDirs := session.PlanDirsForWorkingDir(workingDir)

	// Resolve symlinks before the containment test so a symlink placed INSIDE
	// a plan dir that targets a file OUTSIDE it cannot defeat the check. If the
	// target does not exist yet (e.g. the model is mid-write of a not-yet-
	// created plan file) EvalSymlinks errors; in that case fall back to the
	// lexical reqPath, which is still subject to the same containment test
	// below. Log which branch was taken (both sides of the conditional).
	checkPath := reqPath
	if resolved, err := filepath.EvalSymlinks(reqPath); err == nil {
		if resolved != reqPath {
			utils.Debug("Server", fmt.Sprintf(
				"get_plan_content: resolved symlink path=%s -> %s", reqPath, resolved,
			))
		}
		checkPath = resolved
	} else {
		utils.Debug("Server", fmt.Sprintf(
			"get_plan_content: EvalSymlinks fell back to lexical path=%s err=%v", reqPath, err,
		))
	}

	allowed := false
	for _, dir := range planDirs {
		// Resolve the candidate plan dir too, so the comparison is between two
		// symlink-resolved paths (e.g. /var -> /private/var on macOS). A nil
		// error from EvalSymlinks on a non-existent dir leaves dir lexical,
		// which is fine: a non-existent dir cannot contain checkPath anyway.
		resolvedDir := dir
		if rd, err := filepath.EvalSymlinks(dir); err == nil {
			resolvedDir = rd
		}
		// filepath.Rel returns an error only if the paths are on different
		// volumes (Windows). On Unix it always succeeds. checkPath is INSIDE
		// resolvedDir iff rel is neither ".." nor begins with "../" — i.e. the
		// ".." segment boundary is not crossed. A bare HasPrefix(rel, "..")
		// would over-reject a legitimate file literally named "..foo".
		rel, err := filepath.Rel(resolvedDir, checkPath)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			allowed = true
			break
		}
	}
	if !allowed {
		utils.Warn("Server", fmt.Sprintf(
			"get_plan_content: rejected path outside plan dirs key=%s path=%s checkPath=%s planDirs=%v",
			key, reqPath, checkPath, planDirs,
		))
		s.sendResult(conn, cmd, fmt.Errorf(
			"path %q is outside the plan directory for this session", reqPath,
		), nil)
		return
	}

	// ---- Read the byte window --------------------------------------------
	f, err := os.Open(reqPath)
	if err != nil {
		utils.Warn("Server", fmt.Sprintf(
			"get_plan_content: open failed key=%s path=%s err=%v", key, reqPath, err,
		))
		s.sendResult(conn, cmd, fmt.Errorf("could not open plan file: %w", err), nil)
		return
	}
	defer func() {
		if cerr := f.Close(); cerr != nil {
			utils.Log("Server", fmt.Sprintf("get_plan_content: close failed path=%s err=%v", reqPath, cerr))
		}
	}()

	// Stat for totalBytes and to detect past-EOF requests.
	fi, err := f.Stat()
	if err != nil {
		s.sendResult(conn, cmd, fmt.Errorf("could not stat plan file: %w", err), nil)
		return
	}
	totalBytes := int(fi.Size())

	// Past-EOF request → empty content, hasMore=false.
	if offset >= totalBytes {
		s.emitPlanContent(conn, cmd, reqPath, offset, "", totalBytes, false)
		return
	}

	// Seek to the requested offset.
	if _, err := f.Seek(int64(offset), 0); err != nil {
		s.sendResult(conn, cmd, fmt.Errorf("seek failed: %w", err), nil)
		return
	}

	// Read up to limit bytes.
	buf := make([]byte, limit)
	n, err := f.Read(buf)
	// io.EOF on a successful partial read is normal; treat it as non-error.
	if err != nil && !errors.Is(err, io.EOF) {
		s.sendResult(conn, cmd, fmt.Errorf("read failed: %w", err), nil)
		return
	}
	content := string(buf[:n])
	nextOffset := offset + n
	hasMore := nextOffset < totalBytes

	s.emitPlanContent(conn, cmd, reqPath, offset, content, totalBytes, hasMore)
}

// emitPlanContent serializes an engine_plan_content EngineEvent and delivers it
// directly to the requesting client (not broadcast).
func (s *Server) emitPlanContent(conn net.Conn, cmd *protocol.ClientCommand, planFilePath string, offset int, content string, totalBytes int, hasMore bool) {
	evt := types.EngineEvent{
		Type:                  types.EventPlanContent,
		PlanModeFilePath:      planFilePath, // reuses json:"planFilePath" from plan_mode_changed
		PlanContentOffset:     offset,
		PlanContentBody:       content,
		PlanContentTotalBytes: totalBytes,
		PlanContentHasMore:    hasMore,
	}
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.Warn("Server", "get_plan_content: marshal failed: "+err.Error())
		s.sendResult(conn, cmd, fmt.Errorf("internal marshal error: %w", err), nil)
		return
	}
	line := protocol.SerializeServerEvent(cmd.Key, json.RawMessage(raw))
	s.writeToClient(conn, line)

	// Also send a result acknowledgement when the client included a requestId,
	// so the desktop's await-result pattern resolves cleanly. The event carries
	// the actual payload; the result is just the transport handshake.
	if cmd.RequestID != "" {
		s.sendResult(conn, cmd, nil, nil)
	}
}
