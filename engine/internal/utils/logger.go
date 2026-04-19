package utils

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	logFile *os.File
	logMu   sync.Mutex
)

// Log writes a tagged message to ~/.ion/engine.log.
// Errors are swallowed (disk full, permissions).
func Log(tag, msg string) {
	logMu.Lock()
	defer logMu.Unlock()
	if logFile == nil {
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, ".ion")
		os.MkdirAll(dir, 0o700)
		logFile, _ = os.OpenFile(filepath.Join(dir, "engine.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	}
	if logFile != nil {
		fmt.Fprintf(logFile, "[%s] [%s] %s\n", time.Now().Format("15:04:05"), tag, msg)
	}
}
