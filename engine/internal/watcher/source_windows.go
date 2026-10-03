//go:build windows

package watcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/fsnotify/fsnotify"
	"golang.org/x/sys/windows"
)

// On Windows a directory cannot be renamed or moved while any directory below
// it is held open. Watching each directory with its own handle, as fsnotify
// does, would make every folder with subfolders in a watched workspace
// impossible to rename for as long as the session lives. The source holds one
// handle, on the root, and asks the OS to report the whole subtree through it.

// recursiveBufferSize is the change buffer handed to ReadDirectoryChangesW.
// 64 KiB is the largest size the call accepts for a directory on a network
// share.
const recursiveBufferSize = 64 * 1024

const recursiveNotifyFilter = windows.FILE_NOTIFY_CHANGE_FILE_NAME |
	windows.FILE_NOTIFY_CHANGE_DIR_NAME |
	windows.FILE_NOTIFY_CHANGE_SIZE |
	windows.FILE_NOTIFY_CHANGE_LAST_WRITE |
	windows.FILE_NOTIFY_CHANGE_CREATION

// errChangeOverflow reports that more changes happened than the buffer could
// hold, so some were not reported.
var errChangeOverflow = errors.New("watcher: change buffer overflowed, events were lost")

type recursiveSource struct {
	root   string
	handle windows.Handle
	ov     windows.Overlapped
	buf    []byte

	events chan fsnotify.Event
	errors chan error
	done   chan struct{}
	exited chan struct{}

	// mu orders issuing a read against Close's cancellation, so a read can
	// never start after Close has cancelled and leave the reader blocked.
	mu        sync.Mutex
	closeOnce sync.Once
}

func newEventSource(root string) (eventSource, error) {
	rootPtr, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(rootPtr,
		windows.FILE_LIST_DIRECTORY,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OVERLAPPED,
		0)
	if err != nil {
		return nil, os.NewSyscallError("CreateFile", err)
	}
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		windows.CloseHandle(handle) //nolint:errcheck // already failing; the CreateEvent error is the one returned
		return nil, os.NewSyscallError("CreateEvent", err)
	}
	s := &recursiveSource{
		root:   root,
		handle: handle,
		buf:    make([]byte, recursiveBufferSize),
		events: make(chan fsnotify.Event, 256),
		errors: make(chan error, 8),
		done:   make(chan struct{}),
		exited: make(chan struct{}),
	}
	s.ov.HEvent = event
	// The OS records changes only once the first read is issued, so it must be
	// pending before the source is handed back and the Watcher walks the tree.
	if err := s.issueRead(); err != nil {
		windows.CloseHandle(handle) //nolint:errcheck // already failing; the read error is the one returned
		windows.CloseHandle(event)  //nolint:errcheck // already failing; the read error is the one returned
		return nil, err
	}
	go s.read()
	utils.LogWithFields(utils.LevelDebug, "watcher", "recursive source opened", map[string]any{"path": root})
	return s, nil
}

// Add accepts the root and any directory under it: the root handle already
// reports the whole subtree, so there is nothing to open.
func (s *recursiveSource) Add(dir string) error {
	if dir == s.root || strings.HasPrefix(dir, s.root+string(filepath.Separator)) {
		return nil
	}
	return fmt.Errorf("watcher: %s is outside the watched root %s", dir, s.root)
}

func (s *recursiveSource) Events() <-chan fsnotify.Event { return s.events }
func (s *recursiveSource) Errors() <-chan error          { return s.errors }

func (s *recursiveSource) Close() error {
	var err error
	s.closeOnce.Do(func() {
		// Abort the pending read so the reader returns, then release the
		// handles only after it has stopped using them.
		s.mu.Lock()
		close(s.done)
		if cerr := windows.CancelIoEx(s.handle, &s.ov); cerr != nil && !errors.Is(cerr, windows.ERROR_NOT_FOUND) {
			utils.LogWithFields(utils.LevelDebug, "watcher", "recursive source cancel failed", map[string]any{"path": s.root, "error": cerr.Error()})
		}
		s.mu.Unlock()
		<-s.exited
		if cerr := windows.CloseHandle(s.handle); cerr != nil {
			err = os.NewSyscallError("CloseHandle", cerr)
		}
		if cerr := windows.CloseHandle(s.ov.HEvent); cerr != nil && err == nil {
			err = os.NewSyscallError("CloseHandle", cerr)
		}
	})
	return err
}

// errSourceClosed stops the reader when Close won the race to the next read.
var errSourceClosed = errors.New("watcher: event source closed")

// issueRead starts one asynchronous change read on the root handle.
func (s *recursiveSource) issueRead() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing() {
		return errSourceClosed
	}
	if err := windows.ResetEvent(s.ov.HEvent); err != nil {
		return os.NewSyscallError("ResetEvent", err)
	}
	if err := windows.ReadDirectoryChanges(s.handle, &s.buf[0], uint32(len(s.buf)), true, recursiveNotifyFilter, nil, &s.ov, 0); err != nil {
		return os.NewSyscallError("ReadDirectoryChanges", err)
	}
	return nil
}

// read waits for each pending read, forwards what it returned, and issues the
// next. Changes made between two reads are held by the OS. It closes Events
// when it stops, which tells the Watcher's pump to exit.
func (s *recursiveSource) read() {
	defer close(s.exited)
	defer close(s.events)
	for {
		var n uint32
		if err := windows.GetOverlappedResult(s.handle, &s.ov, &n, true); err != nil {
			if !s.closing() {
				utils.LogWithFields(utils.LevelError, "watcher", "recursive source read failed", map[string]any{"path": s.root, "error": err.Error()})
				s.sendError(os.NewSyscallError("GetOverlappedResult", err))
			}
			return
		}
		if n == 0 {
			s.sendError(errChangeOverflow)
		} else if !s.forward(n) {
			return
		}
		if err := s.issueRead(); err != nil {
			if !errors.Is(err, errSourceClosed) {
				utils.LogWithFields(utils.LevelError, "watcher", "recursive source read failed", map[string]any{"path": s.root, "error": err.Error()})
				s.sendError(err)
			}
			return
		}
	}
}

// forward decodes the n bytes of change records in the buffer. It returns
// false once the source is closing.
func (s *recursiveSource) forward(n uint32) bool {
	var offset uint32
	for {
		if offset+uint32(unsafe.Sizeof(windows.FileNotifyInformation{})) > n {
			return true
		}
		info := (*windows.FileNotifyInformation)(unsafe.Pointer(&s.buf[offset]))
		name := windows.UTF16ToString(unsafe.Slice(&info.FileName, info.FileNameLength/2))
		if op, ok := opForAction(info.Action); ok {
			ev := fsnotify.Event{Name: filepath.Join(s.root, name), Op: op}
			select {
			case s.events <- ev:
			case <-s.done:
				return false
			}
		}
		if info.NextEntryOffset == 0 {
			return true
		}
		offset += info.NextEntryOffset
	}
}

// opForAction maps a change record's action to the fsnotify op the Watcher
// already understands. The new name of a rename arrives as a creation, which
// is what the old name's removal pairs with.
func opForAction(action uint32) (fsnotify.Op, bool) {
	switch action {
	case windows.FILE_ACTION_ADDED, windows.FILE_ACTION_RENAMED_NEW_NAME:
		return fsnotify.Create, true
	case windows.FILE_ACTION_REMOVED:
		return fsnotify.Remove, true
	case windows.FILE_ACTION_RENAMED_OLD_NAME:
		return fsnotify.Rename, true
	case windows.FILE_ACTION_MODIFIED:
		return fsnotify.Write, true
	}
	return 0, false
}

func (s *recursiveSource) closing() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

func (s *recursiveSource) sendError(err error) {
	select {
	case s.errors <- err:
	case <-s.done:
	}
}
