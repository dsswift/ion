package fleet

import (
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// heartbeatEvery is how often a long step says it is still running.
var heartbeatEvery = 30 * time.Second

// stampWriter starts every line it writes with the wall-clock time and the
// time since the writer was made, so a log shows where a deploy spent its
// minutes. It writes through at once, so a prompt with no newline reaches the
// log as it is shown. It also remembers when output last arrived: a step that
// has printed nothing for minutes is hung, not slow.
type stampWriter struct {
	mu      sync.Mutex
	w       io.Writer
	now     func() time.Time
	start   time.Time
	last    time.Time
	midLine bool
}

func newStampWriter(w io.Writer) *stampWriter {
	s := &stampWriter{w: w, now: time.Now}
	s.start = s.now()
	s.last = s.start
	return s
}

func (s *stampWriter) Write(b []byte) (int, error) {
	return s.write(b, true)
}

// note writes a line of the writer's own (a heartbeat) without counting it as
// the step's output.
func (s *stampWriter) note(line string) {
	s.write([]byte(line+"\n"), false) //nolint:errcheck // a log file; the step's own result is what is reported
}

func (s *stampWriter) write(b []byte, output bool) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if output {
		s.last = now
	}
	prefix := fmt.Sprintf("[%s +%s] ", now.Format("15:04:05"), formatElapsed(now.Sub(s.start)))
	out := make([]byte, 0, len(b)+len(prefix))
	for _, c := range b {
		if !s.midLine && c != '\n' {
			out = append(out, prefix...)
			s.midLine = true
		}
		out = append(out, c)
		if c == '\n' {
			s.midLine = false
		}
	}
	if _, err := s.w.Write(out); err != nil {
		return 0, err
	}
	return len(b), nil
}

// sinceOutput is how long the writer has gone without a write.
func (s *stampWriter) sinceOutput() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.now().Sub(s.last)
}

// formatElapsed prints a duration to the second: 0s, 45s, 3m12s.
func formatElapsed(d time.Duration) string {
	return d.Round(time.Second).String()
}

// heartbeat reports a long step every heartbeatEvery until stop is called:
// to the structured log, to report (the live view's detail), and, when toLog
// is set, to the step's own log through sw. sw also says how long the step
// has printed nothing; it is nil for a step that prints nothing. A hung step
// names itself within a minute instead of sitting silent.
func heartbeat(what, host string, sw *stampWriter, toLog bool, report func(detail string)) (stop func()) {
	started := time.Now()
	done := make(chan struct{})
	var once sync.Once
	go func() {
		t := time.NewTicker(heartbeatEvery)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				select {
				case <-done:
					return
				default:
				}
				elapsed := formatElapsed(time.Since(started))
				msg := fmt.Sprintf("%s: still running after %s", what, elapsed)
				fields := map[string]any{"fleet_host": host, "step": what, "elapsed_seconds": int(time.Since(started).Seconds())}
				if sw != nil {
					quiet := sw.sinceOutput()
					fields["quiet_seconds"] = int(quiet.Seconds())
					msg += fmt.Sprintf(", no output for %s", formatElapsed(quiet))
				}
				utils.LogWithFields(utils.LevelInfo, logTag, "deploy step running", fields)
				if sw != nil && toLog {
					sw.note(msg)
				}
				if report != nil {
					report(msg)
				}
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}
