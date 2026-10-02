package types

import "testing"

func TestDispatchConversationReadConfigResolved(t *testing.T) {
	defaults := DispatchConversationReadConfig{
		DefaultEntries: DefaultDispatchConversationReadEntries,
		MaxEntries:     DefaultDispatchConversationReadMaxEntries,
		DefaultBytes:   DefaultDispatchConversationReadBytes,
		MaxBytes:       DefaultDispatchConversationReadMaxBytes,
	}
	cases := []struct {
		name string
		in   *DispatchConversationReadConfig
		want DispatchConversationReadConfig
	}{
		{"nil uses defaults", nil, defaults},
		{"zero uses defaults", &DispatchConversationReadConfig{}, defaults},
		{"negative uses defaults", &DispatchConversationReadConfig{MaxEntries: -1, MaxBytes: -1}, defaults},
		{
			"positive overrides",
			&DispatchConversationReadConfig{DefaultEntries: 5, MaxEntries: 10, DefaultBytes: 100, MaxBytes: 200},
			DispatchConversationReadConfig{DefaultEntries: 5, MaxEntries: 10, DefaultBytes: 100, MaxBytes: 200},
		},
		{
			"default lowered to maximum",
			&DispatchConversationReadConfig{MaxEntries: 10, MaxBytes: 1024},
			DispatchConversationReadConfig{DefaultEntries: 10, MaxEntries: 10, DefaultBytes: 1024, MaxBytes: 1024},
		},
	}
	for _, tc := range cases {
		if got := tc.in.Resolved(); got != tc.want {
			t.Errorf("%s: got %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func TestDispatchConversationReadConfigClamp(t *testing.T) {
	limits := (&DispatchConversationReadConfig{DefaultEntries: 5, MaxEntries: 10, DefaultBytes: 100, MaxBytes: 200}).Resolved()
	cases := []struct {
		name                   string
		entries, bytes         int
		wantEntries, wantBytes int
	}{
		{"unset uses defaults", 0, 0, 5, 100},
		{"within bounds kept", 7, 150, 7, 150},
		{"above maximum clamped", 1000, 1 << 30, 10, 200},
		{"negative uses defaults", -3, -3, 5, 100},
	}
	for _, tc := range cases {
		entries, bytes := limits.Clamp(tc.entries, tc.bytes)
		if entries != tc.wantEntries || bytes != tc.wantBytes {
			t.Errorf("%s: got (%d, %d), want (%d, %d)", tc.name, entries, bytes, tc.wantEntries, tc.wantBytes)
		}
	}
}
