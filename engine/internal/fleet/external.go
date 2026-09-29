package fleet

import (
	"context"
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/studiostatus"
	"github.com/dsswift/ion/engine/internal/utils"
)

// A server deployed outside the fleet (a cluster deployment) is read at its
// own address: its public endpoints always, and a Studio connection when the
// fleet holds its own sign-in to it. Nothing here changes it.

// ViaHTTPS is the reach of an external host.
const ViaHTTPS = "https"

// publicOnlyProblem starts the problem a publicly read host carries.
const publicOnlyProblem = "load, running conversations, and devices: "

// SignInStore keeps the fleet's sign-ins to external hosts.
type SignInStore interface {
	GetSignIn(host string) (studioclient.SignIn, bool, error)
	PutSignIn(host string, s studioclient.SignIn) error
}

// ExternalReader reads external hosts; the studioclient functions by default.
type ExternalReader struct {
	Public func(ctx context.Context, base string) (studioclient.Public, error)
	Status func(ctx context.Context, base, bearer string) (studioclient.Status, error)
	// Refresh mints a bearer from a sign-in; SignIn.Refresh by default.
	Refresh func(ctx context.Context, s studioclient.SignIn) (string, studioclient.SignIn, error)
}

func (e ExternalReader) public(ctx context.Context, base string) (studioclient.Public, error) {
	if e.Public != nil {
		return e.Public(ctx, base)
	}
	return studioclient.ReadPublic(ctx, base)
}

func (e ExternalReader) status(ctx context.Context, base, bearer string) (studioclient.Status, error) {
	if e.Status != nil {
		return e.Status(ctx, base, bearer)
	}
	return studioclient.ReadDirectStatus(ctx, base, bearer)
}

func (e ExternalReader) refresh(ctx context.Context, s studioclient.SignIn) (string, studioclient.SignIn, error) {
	if e.Refresh != nil {
		return e.Refresh(ctx, s)
	}
	return s.Refresh(ctx)
}

// overHTTPS reads an external host: the signed-in read when it can, else the
// public one, with the reason the signed-in read did not happen.
func (c Collector) overHTTPS(ctx context.Context, h Host) (*studiostatus.Report, error) {
	ctx, cancel := context.WithTimeout(ctx, SSHTimeout)
	defer cancel()
	pub, err := c.External.public(ctx, h.URL)
	if err != nil {
		return nil, err
	}
	signedIn, why := c.signedInRead(ctx, h)
	if signedIn != nil {
		signedIn.Ready = pub.Ready
		utils.LogWithFields(utils.LevelInfo, logTag, "external host read signed in", map[string]any{"fleet_host": h.Name})
		return signedIn, nil
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "external host read publicly", map[string]any{"fleet_host": h.Name, "reason": why})
	r := pub.Report(publicOnlyProblem + why)
	r.Hostname = pub.Auth.Label
	return &r, nil
}

// signedInRead is the full read with the fleet's sign-in, or nil and why not.
func (c Collector) signedInRead(ctx context.Context, h Host) (*studiostatus.Report, string) {
	if c.SignIns == nil {
		return nil, "no sign-in store"
	}
	s, ok, err := c.SignIns.GetSignIn(h.Name)
	if err != nil {
		return nil, err.Error()
	}
	if !ok {
		return nil, fmt.Sprintf("not signed in (run `ion fleet pair %s`)", h.Name)
	}
	bearer, rotated, err := c.External.refresh(ctx, s)
	if err != nil {
		return nil, err.Error()
	}
	if rotated.RefreshToken != s.RefreshToken {
		if err := c.SignIns.PutSignIn(h.Name, rotated); err != nil {
			utils.LogWithFields(utils.LevelWarn, logTag, "could not keep a rotated refresh token", map[string]any{"fleet_host": h.Name, "error": err.Error()})
		}
	}
	st, err := c.External.status(ctx, h.URL, bearer)
	if err != nil {
		return nil, err.Error()
	}
	r := st.Report()
	r.Problems = []string{"services and logs: the fleet does not see inside a cluster deployment"}
	if st.Devices == nil {
		r.Problems = append(r.Problems, "devices: the server predates environment.devices")
	}
	return &r, ""
}

// SignInExternal signs the fleet in to an external host with the server's own
// published sign-in (a device code the person enters in a browser) and keeps
// the refresh token.
func SignInExternal(ctx context.Context, h Host, store SignInStore, prompt studioclient.DevicePrompt) error {
	if !h.External() {
		return errors.New("only a host with a url takes a sign-in")
	}
	pub, err := studioclient.ReadPublic(ctx, h.URL)
	if err != nil {
		return err
	}
	if pub.Auth.OIDC == nil {
		return fmt.Errorf("%s accepts no sign-in (its server has no oidc settings); the fleet reads its public status only", h.Name)
	}
	s, err := studioclient.SignInWithDeviceCode(ctx, *pub.Auth.OIDC, prompt)
	if err != nil {
		return err
	}
	return store.PutSignIn(h.Name, s)
}
