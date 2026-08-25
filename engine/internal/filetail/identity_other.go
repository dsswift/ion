//go:build !unix && !windows

package filetail

import (
	"os"
	"time"
)

// FileIdentity identifies a file generation on platforms without inode access.
type FileIdentity struct {
	Modified time.Time `json:"modified"`
	Size     int64     `json:"size"`
}

func fileIdentity(_ *os.File, info os.FileInfo) (FileIdentity, error) {
	return FileIdentity{Modified: info.ModTime(), Size: info.Size()}, nil
}

// Equal reports whether two identities name the same file generation.
func (id FileIdentity) Equal(other FileIdentity) bool {
	return id.Modified.Equal(other.Modified) && id.Size == other.Size
}
