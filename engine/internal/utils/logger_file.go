package utils

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// engine.jsonl is shared. The daemon writes it, and so does every short-lived
// `ion` process, each with its own open handle. Any of them may rotate it. Two
// rules keep that safe:
//
//   - Every writer follows the file. At most once per logFollowInterval it
//     checks that the file it holds is still the one named engine.jsonl, and
//     reopens when it is not. A writer whose file was rotated away by another
//     process therefore moves to the new live file within that interval,
//     instead of appending to an archived generation indefinitely.
//   - Rotation is decided by the real size of the live file and done under a
//     cross-process lock, rechecked once the lock is held. Two writers that
//     reach the cap together cannot both rotate and push a live generation
//     out of the history.
//
// On Windows, every writer opens the file with delete sharing so the rename
// that rotation performs is not refused while others hold it open.

// logFollowInterval bounds how long a writer can keep appending to a file
// another process rotated away.
const logFollowInterval = time.Second

// logRotateLockName is the cross-process rotation lock, in the log directory.
// Named so that globs over engine.jsonl* never pick it up.
const logRotateLockName = "engine.rotate.lock"

// logFollowCheckedAt is when this process last confirmed its open file is the
// live engine.jsonl. Guarded by logMu.
var logFollowCheckedAt time.Time

func liveLogPath() string {
	return filepath.Join(logDir, "engine.jsonl")
}

// maintainLogFileLocked runs before every file write: it follows a file
// rotated by another process and rotates when the live file is over the cap.
// bytesWritten holds this process's view of the live file's size: refreshed
// from the file itself on every follow check, advanced by this process's own
// writes in between. Must be called with logMu held and the logger open.
func maintainLogFileLocked(now time.Time) {
	if logFile == nil || logDir == "" {
		return
	}
	if now.Sub(logFollowCheckedAt) >= logFollowInterval {
		logFollowCheckedAt = now
		followLiveFileLocked()
	}
	if !disableRotation && bytesWritten >= maxLogSize {
		rotateLocked()
	}
}

// followLiveFileLocked reopens the log when the file this process holds is no
// longer the one named engine.jsonl, and otherwise refreshes the known size.
func followLiveFileLocked() {
	path := liveLogPath()
	live, liveErr := os.Stat(path)
	held, heldErr := logFile.Stat()
	if liveErr == nil && heldErr == nil && os.SameFile(live, held) {
		bytesWritten = live.Size()
		return
	}
	reason := "replaced"
	if os.IsNotExist(liveErr) {
		reason = "missing"
	}
	reopenLogLocked()
	noteLogFileLocked(slog.LevelInfo, "log file reopened", map[string]any{"reason": reason, "path": path})
}

// rotateLocked renames the live engine.jsonl to engine.jsonl.1, shifting
// older generations up to maxLogFiles, then reopens. It runs only while
// holding the cross-process rotation lock, and rotates only if the live file
// is still over the cap once the lock is held: a writer that lost the race to
// another rotator just follows the new file. Must be called with logMu held.
func rotateLocked() {
	if logFile == nil || logDir == "" {
		return
	}
	unlock, locked, lockErr := tryLogRotateLock(filepath.Join(logDir, logRotateLockName))
	if !locked {
		// Another process is rotating. Follow its result on the next write.
		logFollowCheckedAt = time.Time{}
		if lockErr != nil {
			noteLogFileLocked(slog.LevelWarn, "log rotation lock failed", map[string]any{"error": lockErr.Error()})
			// Without the lock this writer cannot rotate safely; stop trying
			// until the live file is measured again.
			bytesWritten = 0
		}
		return
	}
	defer unlock()

	path := liveLogPath()
	live, err := os.Stat(path)
	if err != nil || live.Size() < maxLogSize {
		// Someone else rotated between our size check and the lock.
		reopenLogLocked()
		return
	}

	var failures []string
	for i := maxLogFiles; i >= 2; i-- {
		older := fmt.Sprintf("%s.%d", path, i)
		newer := fmt.Sprintf("%s.%d", path, i-1)
		// Rename replaces the older generation in one step, which works on
		// Windows even while another process still holds that file open.
		if err := os.Rename(newer, older); err != nil && !os.IsNotExist(err) {
			failures = append(failures, err.Error())
		}
	}
	renameErr := os.Rename(path, path+".1")
	if renameErr != nil {
		failures = append(failures, renameErr.Error())
	}
	reopenLogLocked()

	fields := map[string]any{"path": path, "rotated_bytes": live.Size(), "max_files": maxLogFiles}
	if len(failures) > 0 {
		fields["errors"] = failures
	}
	if renameErr != nil {
		// The live file could not be moved, so it is still over the cap. Stop
		// retrying on every write until the next follow check measures it.
		bytesWritten = 0
		noteLogFileLocked(slog.LevelError, "log rotation failed", fields)
		return
	}
	noteLogFileLocked(slog.LevelInfo, "log file rotated", fields)
}

// reopenLogLocked closes the held file and opens the current engine.jsonl.
func reopenLogLocked() {
	if logFile != nil {
		logFile.Close() //nolint:errcheck // abandoning a handle to a file that is no longer live
		logFile = nil
	}
	logger = nil
	initLogger()
}

// noteLogFileLocked records a log-file maintenance outcome in the log itself.
// It writes through the handler directly because logAtFull, which holds
// logMu, is not reentrant.
func noteLogFileLocked(level slog.Level, msg string, fields map[string]any) {
	if logger == nil {
		return
	}
	fields["pid"] = os.Getpid()
	logger.LogAttrs(context.Background(), level, msg,
		slog.String("component", "engine"),
		slog.String("tag", "logger"),
		slog.Any("fields", fields),
	)
}
