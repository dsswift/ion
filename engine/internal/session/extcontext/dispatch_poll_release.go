package extcontext

// DispatchPollRelease is implemented by a session accessor that owns the
// polls a dispatch starts. A dispatch that ends with polls still open
// releases them, so they stop counting as the session's pending work.
type DispatchPollRelease interface {
	ReleaseDispatchPolls(dispatchID string)
}

// releaseDispatchPolls ends the polls dispatchID started, when the accessor
// owns polls.
func releaseDispatchPolls(sa SessionAccessor, dispatchID string) {
	if r, ok := sa.(DispatchPollRelease); ok {
		r.ReleaseDispatchPolls(dispatchID)
	}
}
