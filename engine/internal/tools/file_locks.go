package tools

import "sync"

// fileMu is a process-wide map of absolute file path → *sync.Mutex.
// File-mutating tools (Edit, Write, NotebookEdit) acquire the lock for their
// resolved path before reading the file and hold it through the write. This
// serializes concurrent tool calls that target the same file within a single
// errgroup batch (or across batches in the same engine instance), preventing
// the read-modify-write race where parallel writers silently overwrite each
// other's results.
//
// The map grows monotonically — one entry per unique file path ever locked.
// In practice the cardinality is bounded by "files the LLM has ever edited
// in this session," which is small. A 64-byte map entry per file is negligible.
var fileMu sync.Map // map[string]*sync.Mutex

// fileLock returns the singleton mutex for the given absolute file path.
// The caller must Lock/Unlock it around their read-modify-write sequence.
func fileLock(absPath string) *sync.Mutex {
	val, _ := fileMu.LoadOrStore(absPath, &sync.Mutex{})
	return val.(*sync.Mutex)
}
