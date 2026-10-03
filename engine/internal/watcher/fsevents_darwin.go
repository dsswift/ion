//go:build darwin && cgo

package watcher

/*
#cgo LDFLAGS: -framework CoreServices -framework CoreFoundation

#include <stdint.h>
#include <stdlib.h>
#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>

extern void ionWatcherFSEvents(uintptr_t handle, size_t n, char **paths, FSEventStreamEventFlags *flags);

static void ion_fsevents_callback(ConstFSEventStreamRef stream, void *info, size_t n,
	void *paths, const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
	ionWatcherFSEvents((uintptr_t)info, n, (char **)paths, (FSEventStreamEventFlags *)flags);
}

// ion_fsevents_start creates and starts a file-level stream on one root,
// delivering on its own serial queue. Returns NULL stream on failure.
static FSEventStreamRef ion_fsevents_start(const char *root, uintptr_t handle, double latency, dispatch_queue_t *queue) {
	CFStringRef path = CFStringCreateWithCString(NULL, root, kCFStringEncodingUTF8);
	if (path == NULL) {
		return NULL;
	}
	CFArrayRef paths = CFArrayCreate(NULL, (const void **)&path, 1, &kCFTypeArrayCallBacks);
	CFRelease(path);
	FSEventStreamContext ctx = {0, (void *)handle, NULL, NULL, NULL};
	FSEventStreamRef stream = FSEventStreamCreate(NULL, ion_fsevents_callback, &ctx, paths,
		kFSEventStreamEventIdSinceNow, latency,
		kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot | kFSEventStreamCreateFlagNoDefer);
	CFRelease(paths);
	if (stream == NULL) {
		return NULL;
	}
	dispatch_queue_t q = dispatch_queue_create("ion.watcher.fsevents", DISPATCH_QUEUE_SERIAL);
	FSEventStreamSetDispatchQueue(stream, q);
	if (!FSEventStreamStart(stream)) {
		FSEventStreamInvalidate(stream);
		FSEventStreamRelease(stream);
		dispatch_release(q);
		return NULL;
	}
	*queue = q;
	return stream;
}

static void ion_fsevents_noop(void *ctx) {}

// ion_fsevents_stop tears the stream down. The empty synchronous dispatch
// waits out a callback already running on the queue, so no callback runs
// after this returns.
static void ion_fsevents_stop(FSEventStreamRef stream, dispatch_queue_t queue) {
	FSEventStreamStop(stream);
	FSEventStreamInvalidate(stream);
	dispatch_sync_f(queue, NULL, ion_fsevents_noop);
	FSEventStreamRelease(stream);
	dispatch_release(queue);
}
*/
import "C"

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime/cgo"
	"strings"
	"sync"
	"unsafe"

	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/fsnotify/fsnotify"
)

// fseventsLatency is how long FSEvents may hold changes to batch them. The
// stream is created with NoDefer, so the first change after a quiet period is
// delivered at once; the watcher's own debounce does the coalescing.
const fseventsLatency = 0.01

// FSEvents item flags this source reads.
const (
	fsItemCreated  = uint32(C.kFSEventStreamEventFlagItemCreated)
	fsItemRemoved  = uint32(C.kFSEventStreamEventFlagItemRemoved)
	fsItemRenamed  = uint32(C.kFSEventStreamEventFlagItemRenamed)
	fsItemModified = uint32(C.kFSEventStreamEventFlagItemModified)
	fsItemMetadata = uint32(C.kFSEventStreamEventFlagItemInodeMetaMod |
		C.kFSEventStreamEventFlagItemChangeOwner |
		C.kFSEventStreamEventFlagItemXattrMod |
		C.kFSEventStreamEventFlagItemFinderInfoMod)
	fsMustScan = uint32(C.kFSEventStreamEventFlagMustScanSubDirs |
		C.kFSEventStreamEventFlagUserDropped |
		C.kFSEventStreamEventFlagKernelDropped)
	fsRootChanged = uint32(C.kFSEventStreamEventFlagRootChanged)
	fsHistoryDone = uint32(C.kFSEventStreamEventFlagHistoryDone)
)

// rawFSEvent is one FSEvents record copied out of the callback.
type rawFSEvent struct {
	path  string
	flags uint32
}

// fseventsSource is the recursive macOS source: one FSEvents stream covers
// the whole tree under the root and holds no descriptor per file or
// directory.
//
// The FSEvents callback runs on a dispatch queue thread and never blocks: it
// appends to a queue and wakes the translator goroutine, which stats each
// path and delivers fsnotify-shaped events.
type fseventsSource struct {
	root     string // the watcher root, as the watcher names paths
	realRoot string // the root with symlinks resolved, as FSEvents names paths

	handle cgo.Handle
	stream C.FSEventStreamRef
	queue  C.dispatch_queue_t

	mu      sync.Mutex
	pending []rawFSEvent
	wake    chan struct{}

	events chan fsnotify.Event
	errs   chan error
	done   chan struct{}
	exited chan struct{}
	once   sync.Once
}

func newFSEventsSource(root string) (eventSource, error) {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("watcher: resolve root %s: %w", root, err)
	}
	s := &fseventsSource{
		root:     root,
		realRoot: realRoot,
		wake:     make(chan struct{}, 1),
		events:   make(chan fsnotify.Event),
		errs:     make(chan error, 8),
		done:     make(chan struct{}),
		exited:   make(chan struct{}),
	}
	s.handle = cgo.NewHandle(s)
	croot := C.CString(realRoot)
	defer C.free(unsafe.Pointer(croot))
	var queue C.dispatch_queue_t
	stream := C.ion_fsevents_start(croot, C.uintptr_t(s.handle), C.double(fseventsLatency), &queue)
	if stream == nil {
		s.handle.Delete()
		utils.LogWithFields(utils.LevelError, "watcher", "fsevents stream start failed", map[string]any{"path": root})
		return nil, errors.New("watcher: FSEvents stream failed to start for " + root)
	}
	s.stream = stream
	s.queue = queue
	go s.translate()
	utils.LogWithFields(utils.LevelDebug, "watcher", "fsevents stream started", map[string]any{"path": root, "real_path": realRoot})
	return s, nil
}

//export ionWatcherFSEvents
func ionWatcherFSEvents(handle C.uintptr_t, n C.size_t, paths **C.char, flags *C.FSEventStreamEventFlags) {
	s, ok := cgo.Handle(handle).Value().(*fseventsSource)
	if !ok {
		return
	}
	count := int(n)
	cpaths := unsafe.Slice(paths, count)
	cflags := unsafe.Slice(flags, count)
	batch := make([]rawFSEvent, count)
	for i := range batch {
		batch[i] = rawFSEvent{path: C.GoString(cpaths[i]), flags: uint32(cflags[i])}
	}
	s.mu.Lock()
	s.pending = append(s.pending, batch...)
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// translate turns queued FSEvents records into fsnotify events until Close.
func (s *fseventsSource) translate() {
	defer close(s.exited)
	for {
		select {
		case <-s.done:
			return
		case <-s.wake:
		}
		s.mu.Lock()
		batch := s.pending
		s.pending = nil
		s.mu.Unlock()
		for _, raw := range batch {
			if !s.deliver(raw) {
				return
			}
		}
	}
}

// deliver translates one record. It returns false once the source is closed.
func (s *fseventsSource) deliver(raw rawFSEvent) bool {
	if raw.flags&fsHistoryDone != 0 {
		return true
	}
	if raw.flags&fsMustScan != 0 {
		s.report(fmt.Errorf("FSEvents dropped events under %s (flags 0x%x); changes in that subtree were not reported", raw.path, raw.flags))
	}
	if raw.flags&fsRootChanged != 0 {
		s.report(fmt.Errorf("FSEvents watch root %s was moved or deleted; no further changes will be reported", s.root))
		return true
	}
	path, ok := s.mapPath(raw.path)
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "watcher", "fsevents path outside root dropped", map[string]any{"path": raw.path, "real_path": s.realRoot})
		return true
	}
	_, statErr := os.Lstat(path)
	for _, op := range fseventOps(raw.flags, statErr == nil) {
		select {
		case s.events <- fsnotify.Event{Name: path, Op: op}:
		case <-s.done:
			return false
		}
	}
	return true
}

// fseventOps maps one FSEvents record to fsnotify ops, in delivery order.
//
// FSEvents coalesces: one record can carry every change made to a path since
// the last record, so the flags say what happened but not in what order. The
// path's current existence settles the order. A path that is gone was
// removed, whatever else happened to it. A path that exists and was created or
// renamed into place is a create, followed by a write when its content also
// changed; the watcher's debounce then settles on the last action, exactly as
// it does for fsnotify's separate create and write events.
func fseventOps(flags uint32, exists bool) []fsnotify.Op {
	item := fsItemCreated | fsItemRemoved | fsItemRenamed | fsItemModified | fsItemMetadata
	if flags&item == 0 {
		return nil
	}
	if !exists {
		return []fsnotify.Op{fsnotify.Remove}
	}
	var ops []fsnotify.Op
	if flags&(fsItemCreated|fsItemRenamed) != 0 {
		ops = append(ops, fsnotify.Create)
	}
	if flags&fsItemModified != 0 {
		ops = append(ops, fsnotify.Write)
	}
	if len(ops) == 0 && flags&fsItemMetadata != 0 {
		ops = append(ops, fsnotify.Chmod)
	}
	return ops
}

// mapPath converts an FSEvents path, which names the resolved root, into the
// watcher's naming. The root itself is not an event subject.
func (s *fseventsSource) mapPath(p string) (string, bool) {
	p = filepath.Clean(p)
	if !strings.HasPrefix(p, s.realRoot+string(filepath.Separator)) {
		return "", false
	}
	return s.root + p[len(s.realRoot):], true
}

// report hands an error to the pump without blocking the translator.
func (s *fseventsSource) report(err error) {
	select {
	case s.errs <- err:
	default:
		utils.LogWithFields(utils.LevelError, "watcher", "fsevents error dropped, error channel full", map[string]any{"path": s.root, "error": err.Error()})
	}
}

func (s *fseventsSource) Add(string) error              { return nil }
func (s *fseventsSource) Events() <-chan fsnotify.Event { return s.events }
func (s *fseventsSource) Errors() <-chan error          { return s.errs }
func (s *fseventsSource) Recursive() bool               { return true }

// Close stops the stream, then the translator. Safe to call more than once.
func (s *fseventsSource) Close() error {
	s.once.Do(func() {
		C.ion_fsevents_stop(s.stream, s.queue)
		s.handle.Delete()
		close(s.done)
		<-s.exited
		utils.LogWithFields(utils.LevelDebug, "watcher", "fsevents stream stopped", map[string]any{"path": s.root})
	})
	return nil
}
