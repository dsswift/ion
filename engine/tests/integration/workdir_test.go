//go:build integration

package integration

import (
	"os"
	"sync"
)

var (
	testWorkDirOnce sync.Once
	testWorkDirPath string
)

// testWorkDir returns an empty directory shared by tests that need a working
// directory but do not care what is in it. Sessions watch their working
// directory, so tests must not point one at a large shared tree like /tmp.
func testWorkDir() string {
	testWorkDirOnce.Do(func() {
		dir, err := os.MkdirTemp("", "ion-test-workdir-")
		if err != nil {
			panic(err)
		}
		testWorkDirPath = dir
	})
	return testWorkDirPath
}
