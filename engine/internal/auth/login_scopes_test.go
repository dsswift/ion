package auth

import (
	"reflect"
	"testing"
)

// Entra binds one access token to one resource. A login naming two fails with
// AADSTS28000 *after* the user has signed in and consented, so the browser
// shows a token-exchange failure and the app registration looks broken.
//
// The dci tenant's configuration is exactly this shape: the app's own
// api:// scope plus two on a separate API host.
func TestSplitLoginScopes_OneResourcePerLogin(t *testing.T) {
	scopes := []string{
		"openid",
		"profile",
		"offline_access",
		"api://69d75e8e/Telemetry.Write",
		"https://ermapi.example.com/Exchange.Mail.Read",
		"https://ermapi.example.com/Directory.Read",
	}

	request, deferred := splitLoginScopes(scopes)

	wantRequest := []string{"openid", "profile", "offline_access", "api://69d75e8e/Telemetry.Write"}
	wantDeferred := []string{
		"https://ermapi.example.com/Exchange.Mail.Read",
		"https://ermapi.example.com/Directory.Read",
	}
	if !reflect.DeepEqual(request, wantRequest) {
		t.Errorf("request = %v, want %v", request, wantRequest)
	}
	if !reflect.DeepEqual(deferred, wantDeferred) {
		t.Errorf("deferred = %v, want %v", deferred, wantDeferred)
	}
}

// Every scope belonging to the first resource rides along -- the constraint is
// one resource, not one scope.
func TestSplitLoginScopes_KeepsAllScopesOfOneResource(t *testing.T) {
	request, deferred := splitLoginScopes([]string{
		"openid",
		"https://api.example.com/Read",
		"https://api.example.com/Write",
	})
	want := []string{"openid", "https://api.example.com/Read", "https://api.example.com/Write"}
	if !reflect.DeepEqual(request, want) {
		t.Errorf("request = %v, want %v", request, want)
	}
	if len(deferred) != 0 {
		t.Errorf("deferred = %v, want none", deferred)
	}
}

// offline_access must never be deferred: the refresh token it yields is what
// mints the deferred resources later. Losing it would make them unreachable
// without a second interactive login.
func TestSplitLoginScopes_KeepsOidcScopes(t *testing.T) {
	request, _ := splitLoginScopes([]string{
		"https://a.example.com/Read",
		"offline_access",
		"https://b.example.com/Read",
		"openid",
		"email",
	})
	for _, required := range []string{"offline_access", "openid", "email"} {
		found := false
		for _, got := range request {
			if got == required {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%q was not requested; request = %v", required, request)
		}
	}
}

// A configuration with no resource scopes is unchanged -- the common
// openid/profile/offline_access case must not acquire behaviour it never had.
func TestSplitLoginScopes_NoResourceScopes(t *testing.T) {
	request, deferred := splitLoginScopes([]string{"openid", "profile", "offline_access"})
	if !reflect.DeepEqual(request, []string{"openid", "profile", "offline_access"}) {
		t.Errorf("request = %v", request)
	}
	if len(deferred) != 0 {
		t.Errorf("deferred = %v, want none", deferred)
	}
}

func TestSplitLoginScopes_Empty(t *testing.T) {
	request, deferred := splitLoginScopes(nil)
	if len(request) != 0 || len(deferred) != 0 {
		t.Errorf("request = %v, deferred = %v, want both empty", request, deferred)
	}
}
