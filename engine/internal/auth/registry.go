package auth

import "sync"

// Package-level credential registries. Bearer and AWS providers are separate
// because AWS credentials authorize a signature operation, not bearer export.
var (
	providerMu              sync.RWMutex
	tokenProvider           TokenProvider
	awsProvider             AWSCredentialsProvider
	contextIdentityProvider ContextIdentityProvider
	identitySubscribers     = make(map[uint64]func(ContextIdentityChange))
	nextIdentitySubscriber  uint64
)

func SetTokenProvider(provider TokenProvider) {
	providerMu.Lock()
	tokenProvider = provider
	providerMu.Unlock()
}
func CurrentTokenProvider() TokenProvider {
	providerMu.RLock()
	defer providerMu.RUnlock()
	return tokenProvider
}
func SetAWSCredentialsProvider(provider AWSCredentialsProvider) {
	providerMu.Lock()
	awsProvider = provider
	providerMu.Unlock()
}
func CurrentAWSCredentialsProvider() AWSCredentialsProvider {
	providerMu.RLock()
	defer providerMu.RUnlock()
	return awsProvider
}

// SetContextIdentityProvider installs the provider that exposes credential-free
// verified Context Identity state.
func SetContextIdentityProvider(provider ContextIdentityProvider) {
	providerMu.Lock()
	contextIdentityProvider = provider
	providerMu.Unlock()
}

func CurrentContextIdentityProvider() ContextIdentityProvider {
	providerMu.RLock()
	defer providerMu.RUnlock()
	return contextIdentityProvider
}

// SubscribeContextIdentityChanges receives complete defensive snapshots after
// identity transitions. The callback is always invoked outside package locks.
func SubscribeContextIdentityChanges(fn func(ContextIdentityChange)) (unsubscribe func()) {
	providerMu.Lock()
	id := nextIdentitySubscriber
	nextIdentitySubscriber++
	identitySubscribers[id] = fn
	providerMu.Unlock()
	return func() {
		providerMu.Lock()
		delete(identitySubscribers, id)
		providerMu.Unlock()
	}
}

func publishContextIdentityChange(change ContextIdentityChange) {
	providerMu.RLock()
	callbacks := make([]func(ContextIdentityChange), 0, len(identitySubscribers))
	for _, callback := range identitySubscribers {
		callbacks = append(callbacks, callback)
	}
	providerMu.RUnlock()
	for _, callback := range callbacks {
		callback(ContextIdentityChange{Identity: cloneContextIdentity(change.Identity), Reason: change.Reason})
	}
}

// Internal compatibility aliases for existing tests and callers.
func SetOperator(manager *IdentityManager) {
	if manager == nil {
		SetTokenProvider(nil)
		SetContextIdentityProvider(nil)
		return
	}
	SetTokenProvider(manager)
	SetContextIdentityProvider(manager)
}
func Operator() TokenProvider { return CurrentTokenProvider() }
