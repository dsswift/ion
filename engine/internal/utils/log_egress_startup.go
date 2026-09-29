package utils

// The engine logs its first lines (process start, data directory, how the
// previous run exited) before engine.json is read, so before any egress
// forwarder exists. Those lines are held here and handed to the forwarder
// that ConfigureLogging builds, so a shipped log starts where the file does.
// Holding stops at the first ConfigureLogging call whether or not it builds a
// forwarder; a process that never configures logging keeps at most
// maxHeldStartupRecords.

const maxHeldStartupRecords = 2000

var (
	// heldStartupRecords and startupHoldDone are guarded by logMu.
	heldStartupRecords []egressRecord
	startupHoldDone    bool
	heldStartupDropped int
)

// holdStartupRecordLocked keeps rec for the first forwarder. Caller holds
// logMu and has no active forwarder.
func holdStartupRecordLocked(rec egressRecord) {
	if startupHoldDone {
		return
	}
	if len(heldStartupRecords) >= maxHeldStartupRecords {
		heldStartupRecords = heldStartupRecords[1:]
		heldStartupDropped++
	}
	heldStartupRecords = append(heldStartupRecords, rec)
}

// takeHeldStartupRecordsLocked ends holding and returns what was held, plus
// how many older records the cap dropped. Caller holds logMu.
func takeHeldStartupRecordsLocked() ([]egressRecord, int) {
	if startupHoldDone {
		return nil, 0
	}
	startupHoldDone = true
	held, dropped := heldStartupRecords, heldStartupDropped
	heldStartupRecords, heldStartupDropped = nil, 0
	return held, dropped
}
