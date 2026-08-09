package auth

import "sync"

// Package-level credential registries. Bearer and AWS providers are separate
// because AWS credentials authorize a signature operation, not bearer export.
var (
	providerMu    sync.RWMutex
	tokenProvider TokenProvider
	awsProvider   AWSCredentialsProvider
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

// Internal compatibility aliases for existing tests and callers.
func SetOperator(manager *IdentityManager) {
	if manager == nil {
		SetTokenProvider(nil)
		return
	}
	SetTokenProvider(manager)
}
func Operator() TokenProvider { return CurrentTokenProvider() }
