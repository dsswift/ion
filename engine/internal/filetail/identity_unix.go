//go:build unix

package filetail

import (
	"os"
	"syscall"
)

// FileIdentity identifies a Unix file generation by device and inode.
type FileIdentity struct {
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}

func fileIdentity(_ *os.File, info os.FileInfo) (FileIdentity, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return FileIdentity{}, nil
	}
	return FileIdentity{Device: uint64(stat.Dev), Inode: uint64(stat.Ino)}, nil
}

// Equal reports whether two identities name the same file generation.
func (id FileIdentity) Equal(other FileIdentity) bool {
	return id.Device == other.Device && id.Inode == other.Inode
}
