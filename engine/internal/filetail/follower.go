// Package filetail follows newline-delimited files across truncation and rename.
package filetail

import (
	"bytes"
	"errors"
	"io"
	"os"
)

// StartMode controls where a follower starts when it has no cursor.
type StartMode uint8

const (
	// StartAtBeginning reads content already present when the follower opens.
	StartAtBeginning StartMode = iota
	// StartAtEnd ignores content already present when the follower opens.
	StartAtEnd
)

// Cursor is durable follower state. It identifies both the file generation and
// the next unacknowledged byte offset. An uninitialized cursor uses StartMode.
type Cursor struct {
	Offset      int64        `json:"offset"`
	Identity    FileIdentity `json:"identity"`
	Initialized bool         `json:"initialized"`
}

// Options configures a Follower.
type Options struct {
	Start  StartMode
	Cursor Cursor
}

// LineHandler receives one complete line without its newline. Returning an
// error leaves that line unacknowledged, so a later Poll retries it.
type LineHandler func(line []byte) error

// Follower holds a file descriptor while it drains a pathname. This preserves
// lines written to an old file after a writer renames the pathname.
type Follower struct {
	path   string
	start  StartMode
	cursor Cursor
	file   *os.File
}

// New creates a follower. Call Poll to open and drain its path.
func New(path string, options Options) *Follower {
	return &Follower{path: path, start: options.Start, cursor: options.Cursor}
}

// Cursor returns the durable state after the most recently acknowledged line.
func (f *Follower) Cursor() Cursor { return f.cursor }

// Close releases the held descriptor.
func (f *Follower) Close() error {
	if f.file == nil {
		return nil
	}
	err := f.file.Close()
	f.file = nil
	return err
}

// Poll drains complete lines. It advances Cursor only after handler accepts a
// line. A trailing partial line remains unacknowledged until its newline exists.
func (f *Follower) Poll(handler LineHandler) error {
	if handler == nil {
		return errors.New("filetail: line handler is required")
	}
	if err := f.open(); err != nil {
		return err
	}

	for {
		if err := f.drain(handler); err != nil {
			return err
		}
		rotated, err := f.pathReplaced()
		if err != nil || !rotated {
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		// A replacement is a fresh generation, unlike a first-seen path. It
		// must drain from zero even when this follower initially used StartAtEnd.
		f.cursor = Cursor{Initialized: true}
		if err := f.open(); err != nil {
			return err
		}
	}
}

func (f *Follower) open() error {
	if f.file != nil {
		return nil
	}
	file, err := os.Open(f.path)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		closeErr := file.Close()
		if closeErr != nil {
			return closeErr
		}
		return err
	}
	identity, err := fileIdentity(file, info)
	if err != nil {
		closeErr := file.Close()
		if closeErr != nil {
			return closeErr
		}
		return err
	}
	if !f.cursor.Initialized {
		f.cursor = Cursor{Identity: identity, Initialized: true}
		if f.start == StartAtEnd {
			f.cursor.Offset, err = completeEndOffset(file)
			if err != nil {
				closeErr := file.Close()
				if closeErr != nil {
					return closeErr
				}
				return err
			}
		}
	} else if f.cursor.Identity.Equal(FileIdentity{}) {
		// Numeric cursors from older users have no inode. Bind their existing
		// offset to this generation so migration does not backfill history.
		f.cursor.Identity = identity
	} else if !f.cursor.Identity.Equal(identity) {
		// A persisted cursor belongs to a prior generation. The current file is
		// new content, so start at its beginning rather than losing it.
		f.cursor = Cursor{Identity: identity, Initialized: true}
	}
	f.file = file
	return nil
}

// completeEndOffset skips complete history but keeps a trailing partial line.
func completeEndOffset(file *os.File) (int64, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return 0, err
	}
	newline := bytes.LastIndexByte(data, '\n')
	return int64(newline + 1), nil
}

func (f *Follower) drain(handler LineHandler) error {
	info, err := f.file.Stat()
	if err != nil {
		return err
	}
	if info.Size() < f.cursor.Offset {
		// The held inode was truncated. New bytes begin at zero.
		f.cursor.Offset = 0
	}
	if _, err := f.file.Seek(f.cursor.Offset, io.SeekStart); err != nil {
		return err
	}
	data, err := io.ReadAll(f.file)
	if err != nil {
		return err
	}
	consumed := 0
	for {
		newline := bytes.IndexByte(data[consumed:], '\n')
		if newline < 0 {
			return nil
		}
		end := consumed + newline
		line := append([]byte(nil), data[consumed:end]...)
		if err := handler(line); err != nil {
			return err
		}
		consumed = end + 1
		f.cursor.Offset += int64(newline + 1)
	}
}

func (f *Follower) pathReplaced() (bool, error) {
	pathFile, err := os.Open(f.path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	defer func() { _ = pathFile.Close() }() //nolint:errcheck // read-only identity handle
	pathInfo, err := pathFile.Stat()
	if err != nil {
		return false, err
	}
	pathIdentity, err := fileIdentity(pathFile, pathInfo)
	if err != nil {
		return false, err
	}
	heldInfo, err := f.file.Stat()
	if err != nil {
		return false, err
	}
	heldIdentity, err := fileIdentity(f.file, heldInfo)
	if err != nil {
		return false, err
	}
	return !pathIdentity.Equal(heldIdentity), nil
}
