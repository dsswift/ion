package fleet

import (
	"context"
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/studioclient"
)

// A server reached only at its own address (a cluster deployment) is read
// there: over a Studio connection with the device's sign-in when it holds
// one, else what the server publishes to anyone.

// ViaHTTPS is the reach of a host read at its own address with a sign-in,
// or with none.
const ViaHTTPS = "https"

// publicOnlyProblem starts the problem a publicly read host carries.
const publicOnlyProblem = "load, running conversations, devices, and accounts: "

// SignedIn is a completed sign-in to a server at its own address.
type SignedIn struct {
	Entry        Entry
	RefreshToken string
}

// SignIn signs this device in to the server at base with the server's own
// published sign-in (a device code the person enters in a browser), and
// returns the catalog entry and the refresh token to keep.
func SignIn(ctx context.Context, label, base string, prompt studioclient.DevicePrompt) (SignedIn, error) {
	pub, err := studioclient.ReadPublic(ctx, base)
	if err != nil {
		return SignedIn{}, fmt.Errorf("%s does not answer as an Ion server: %w", base, err)
	}
	if pub.Auth.OIDC == nil {
		return SignedIn{}, errors.New("the server accepts no sign-in (it has no oidc settings); pair with it over SSH or with a pairing link in Studio")
	}
	s, err := studioclient.SignInWithDeviceCode(ctx, *pub.Auth.OIDC, prompt)
	if err != nil {
		return SignedIn{}, err
	}
	o := pub.Auth.OIDC
	return SignedIn{
		Entry:        Entry{Kind: EntryBearer, Label: label, URL: base, EnvironmentID: pub.Auth.EnvironmentID, OIDC: &EntryOIDC{Issuer: o.Issuer, Audience: o.Audience, Scope: o.Scope, ClientID: o.ClientID}},
		RefreshToken: s.RefreshToken,
	}, nil
}
