//go:build windows

package studioclient

import (
	"context"
	"errors"
	"net"
	"os"
	"os/user"
	"syscall"
	"time"
)

// localAddress is the per-user named pipe: `\\.\pipe\ion-studio-<SID>`.
func localAddress(string) string {
	sid := ""
	if u, err := user.Current(); err == nil {
		sid = u.Uid
	}
	return `\\.\pipe\ion-studio-` + sid
}

// dialLocal opens the pipe for overlapped I/O, so a read waiting on the
// server does not hold up a write.
func dialLocal(_ context.Context, address string) (net.Conn, error) {
	name, err := syscall.UTF16PtrFromString(address)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		return nil, &net.OpError{Op: "dial", Net: "pipe", Err: err}
	}
	return &pipeConn{file: os.NewFile(uintptr(handle), address), name: address}, nil
}

// pipeConn is a named pipe as a net.Conn.
type pipeConn struct {
	file *os.File
	name string
}

type pipeAddr string

func (pipeAddr) Network() string  { return "pipe" }
func (a pipeAddr) String() string { return string(a) }

func (c *pipeConn) Read(b []byte) (int, error)  { return c.file.Read(b) }
func (c *pipeConn) Write(b []byte) (int, error) { return c.file.Write(b) }
func (c *pipeConn) Close() error                { return c.file.Close() }
func (c *pipeConn) LocalAddr() net.Addr         { return pipeAddr(c.name) }
func (c *pipeConn) RemoteAddr() net.Addr        { return pipeAddr(c.name) }

// A handle that takes no deadline still reads and writes; the session's own
// context bounds it.
func noDeadline(err error) error {
	if errors.Is(err, os.ErrNoDeadline) {
		return nil
	}
	return err
}

func (c *pipeConn) SetDeadline(t time.Time) error      { return noDeadline(c.file.SetDeadline(t)) }
func (c *pipeConn) SetReadDeadline(t time.Time) error  { return noDeadline(c.file.SetReadDeadline(t)) }
func (c *pipeConn) SetWriteDeadline(t time.Time) error { return noDeadline(c.file.SetWriteDeadline(t)) }
