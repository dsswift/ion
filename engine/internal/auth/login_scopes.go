package auth

import "strings"

// splitLoginScopes partitions a configured scope list into the scopes a single
// interactive login may request, and the resource scopes that must be minted
// later.
//
// Microsoft Entra binds one access token to exactly one resource. An
// authorization-code exchange naming more than one fails with "AADSTS28000:
// Provided value for the input parameter scope is not valid because it
// contains more than one resource", after the user has already signed in and
// consented -- so the failure looks like a broken app registration rather than
// a request the engine could have shaped correctly.
//
// The OIDC scopes (openid, profile, offline_access, email, and any other
// non-resource value) always ride along; they belong to no resource. Of the
// resource scopes, only the first resource's are requested here. The rest are
// reachable without another interactive login: offline_access yields a refresh
// token that is not resource-bound, and GetToken(ctx, scope) mints a token per
// resource from it (RFC 6749 section 6). That is the same "one refresh token,
// many audiences" path doRefreshTokenGrant already implements.
//
// A scope is resource-scoped when it carries a '/' -- api://<id>/Scope.Name or
// https://host/Scope.Name. The resource is everything up to the last '/'.
func splitLoginScopes(scopes []string) (request []string, deferred []string) {
	var firstResource string
	for _, scope := range scopes {
		idx := strings.LastIndex(scope, "/")
		if idx < 0 {
			// No resource component: an OIDC scope, always requestable.
			request = append(request, scope)
			continue
		}
		resource := scope[:idx]
		if firstResource == "" {
			firstResource = resource
		}
		if resource == firstResource {
			request = append(request, scope)
			continue
		}
		deferred = append(deferred, scope)
	}
	return request, deferred
}
