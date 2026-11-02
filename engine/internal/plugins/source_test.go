package plugins

import (
	"reflect"
	"testing"
)

func TestParseSource(t *testing.T) {
	cases := []struct {
		in   string
		id   string
		urls []string
	}{
		{"dsswift/vantage", "dsswift/vantage", []string{"https://github.com/dsswift/vantage.git", "git@github.com:dsswift/vantage.git"}},
		{"git@github.com:dsswift/vantage.git", "dsswift/vantage", []string{"git@github.com:dsswift/vantage.git"}},
		{"https://github.com/dsswift/vantage", "dsswift/vantage", []string{"https://github.com/dsswift/vantage"}},
		{"https://GitLab.example.com/group/sub/repo.git", "gitlab.example.com/group/sub/repo", []string{"https://GitLab.example.com/group/sub/repo.git"}},
		{"ssh://git@gitlab.example.com:2222/group/repo.git", "gitlab.example.com/group/repo", []string{"ssh://git@gitlab.example.com:2222/group/repo.git"}},
	}
	for _, c := range cases {
		got, err := ParseSource(c.in)
		if err != nil {
			t.Errorf("ParseSource(%q): %v", c.in, err)
			continue
		}
		if got.ID != c.id || !reflect.DeepEqual(got.URLs, c.urls) {
			t.Errorf("ParseSource(%q) = %+v, want id %q urls %v", c.in, got, c.id, c.urls)
		}
	}
}

func TestParseSource_Rejects(t *testing.T) {
	for _, in := range []string{"", "not-a-valid-source", "a/b/c", "../evil", "https://github.com/", "file:///tmp/repo", "git@github.com:../x.git"} {
		if _, err := ParseSource(in); err == nil {
			t.Errorf("ParseSource(%q) accepted it", in)
		}
	}
}
