//go:build windows

package filetail

import (
	"os"

	"golang.org/x/sys/windows"
)

// FileIdentity identifies a Windows file generation by volume serial and file index.
type FileIdentity struct {
	VolumeSerial uint32 `json:"volumeSerial"`
	FileIndex    uint64 `json:"fileIndex"`
}

func fileIdentity(file *os.File, _ os.FileInfo) (FileIdentity, error) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return FileIdentity{}, err
	}
	return FileIdentity{
		VolumeSerial: info.VolumeSerialNumber,
		FileIndex:    uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow),
	}, nil
}

// Equal reports whether two identities name the same file generation.
func (id FileIdentity) Equal(other FileIdentity) bool {
	return id.VolumeSerial == other.VolumeSerial && id.FileIndex == other.FileIndex
}
