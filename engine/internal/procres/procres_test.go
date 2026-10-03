package procres

import (
	"errors"
	"fmt"
	"syscall"
	"testing"
)

func TestExhaustedResource(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
		ok   bool
	}{
		{"nil", nil, "", false},
		{"emfile", syscall.EMFILE, ResourceFileDescriptors, true},
		{"enfile wrapped", fmt.Errorf("fork/exec: %w", syscall.ENFILE), ResourceFileDescriptors, true},
		{"emfile text", errors.New("pipe: too many open files"), ResourceFileDescriptors, true},
		{"eagain", fmt.Errorf("fork/exec /bin/bash: %w", syscall.EAGAIN), ResourceProcesses, true},
		{"enomem", syscall.ENOMEM, ResourceMemory, true},
		{"not found", syscall.ENOENT, "", false},
		{"other", errors.New("exit status 1"), "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ExhaustedResource(tc.err)
			if got != tc.want || ok != tc.ok {
				t.Errorf("ExhaustedResource(%v) = %q, %v; want %q, %v", tc.err, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestDescriptorsDeltaAndFields(t *testing.T) {
	before := Descriptors{Open: 10, Limit: 100}
	after := Descriptors{Open: 14, Limit: 100}
	if d, ok := after.Delta(before); !ok || d != 4 {
		t.Errorf("Delta = %d, %v; want 4, true", d, ok)
	}
	if _, ok := after.Delta(Descriptors{Open: Unknown}); ok {
		t.Error("Delta against an Unknown reading reported ok")
	}
	fields := map[string]any{}
	Descriptors{Open: Unknown, Limit: Unknown}.Fields(fields)
	if len(fields) != 0 {
		t.Errorf("Unknown reading wrote fields: %v", fields)
	}
	after.Fields(fields)
	if fields["fd_open"] != 14 || fields["fd_limit"] != int64(100) {
		t.Errorf("fields = %v", fields)
	}
}
