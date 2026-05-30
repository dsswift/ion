package utils

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// LogLevel controls which messages are written to the log file.
type LogLevel int

const (
	LevelDebug LogLevel = iota
	LevelInfo
	LevelWarn
	LevelError
)

var levelNames = [...]string{"DEBUG", "INFO", "WARN", "ERROR"}

func (l LogLevel) String() string {
	if l >= 0 && int(l) < len(levelNames) {
		return levelNames[l]
	}
	return "INFO"
}

// ParseLevel converts a string like "debug", "info", "warn", "error" to a LogLevel.
// Returns LevelInfo for unrecognized strings.
func ParseLevel(s string) LogLevel {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug
	case "info":
		return LevelInfo
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

const (
	maxLogSize   = 50 * 1024 * 1024 // 50MB per file
	rotatedFiles = 3                // keep engine.log.1 … engine.log.3
)

var (
	logFile      *os.File
	logMu        sync.Mutex
	logLevel     = LevelInfo
	bytesWritten int64
	logDir       string
)

// SetLevel sets the minimum log level. Messages below this level are discarded.
func SetLevel(level LogLevel) {
	logMu.Lock()
	logLevel = level
	logMu.Unlock()
}

// SetLevelFromString parses and sets the log level from a config string.
func SetLevelFromString(s string) {
	SetLevel(ParseLevel(s))
}

// GetLevel returns the current log level.
func GetLevel() LogLevel {
	logMu.Lock()
	defer logMu.Unlock()
	return logLevel
}

// Debug logs a message at DEBUG level.
func Debug(tag, msg string) {
	logAt(LevelDebug, tag, msg)
}

// Info logs a message at INFO level.
func Info(tag, msg string) {
	logAt(LevelInfo, tag, msg)
}

// Warn logs a message at WARN level.
func Warn(tag, msg string) {
	logAt(LevelWarn, tag, msg)
}

// Error logs a message at ERROR level.
func Error(tag, msg string) {
	logAt(LevelError, tag, msg)
}

// Log writes a tagged message at INFO level. Backward compatible.
func Log(tag, msg string) {
	logAt(LevelInfo, tag, msg)
}

func logAt(level LogLevel, tag, msg string) {
	logMu.Lock()
	defer logMu.Unlock()

	if level < logLevel {
		return
	}

	if logFile == nil {
		initLogFile()
	}
	if logFile == nil {
		return
	}

	// Rotate if over size limit
	if bytesWritten >= maxLogSize {
		rotate()
	}

	line := fmt.Sprintf("[%s] [%s] [%s] %s\n", time.Now().Format("15:04:05"), level, tag, msg)
	n, _ := logFile.WriteString(line)
	bytesWritten += int64(n)
}

// initLogFile opens the log file and seeds the byte counter.
// Must be called with logMu held.
func initLogFile() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	logDir = filepath.Join(home, ".ion")
	_ = os.MkdirAll(logDir, 0o700)

	path := filepath.Join(logDir, "engine.log")

	// Seed byte counter from existing file
	if info, err := os.Stat(path); err == nil {
		bytesWritten = info.Size()
	}

	logFile, _ = os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
}

// rotate closes the current log, shifts numbered backups, and opens a fresh
// file. Keeps up to rotatedFiles old logs (engine.log.1 … engine.log.N).
// Also maintains the legacy engine.log.old symlink pointing at engine.log.1
// so existing tooling that reads .old continues to work.
// Must be called with logMu held.
func rotate() {
	if logFile != nil {
		_ = logFile.Close()
		logFile = nil
	}

	path := filepath.Join(logDir, "engine.log")

	// Shift numbered backups: .3 → delete, .2 → .3, .1 → .2, current → .1
	for i := rotatedFiles; i >= 1; i-- {
		src := path
		if i > 1 {
			src = fmt.Sprintf("%s.%d", path, i-1)
		}
		dst := fmt.Sprintf("%s.%d", path, i)
		if i == rotatedFiles {
			_ = os.Remove(dst)
		}
		_ = os.Rename(src, dst)
	}

	// Maintain legacy .old symlink → .1 for backward compatibility.
	oldPath := filepath.Join(logDir, "engine.log.old")
	_ = os.Remove(oldPath)
	// Use a relative target so the symlink works regardless of the
	// absolute path to ~/.ion.
	_ = os.Symlink("engine.log.1", oldPath)

	logFile, _ = os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	bytesWritten = 0
}
