package types

import "testing"

func TestDispatchHistoryConfigResolved(t *testing.T) {
	defaults := DispatchHistoryConfig{MaxEntries: DefaultDispatchHistoryMaxEntries, MaxAgeMs: DefaultDispatchHistoryMaxAgeMs}
	cases := []struct {
		name string
		in   *DispatchHistoryConfig
		want DispatchHistoryConfig
	}{
		{"nil uses defaults", nil, defaults},
		{"zero uses defaults", &DispatchHistoryConfig{}, defaults},
		{"positive overrides", &DispatchHistoryConfig{MaxEntries: 5, MaxAgeMs: 1000}, DispatchHistoryConfig{MaxEntries: 5, MaxAgeMs: 1000}},
		{"negative turns off", &DispatchHistoryConfig{MaxEntries: -1, MaxAgeMs: -1}, DispatchHistoryConfig{}},
	}
	for _, tc := range cases {
		if got := tc.in.Resolved(); got != tc.want {
			t.Errorf("%s: got %+v, want %+v", tc.name, got, tc.want)
		}
	}
}
