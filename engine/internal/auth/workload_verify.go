package auth

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/types"
)

const workloadVerificationTimeout = 30 * time.Second

// WorkloadVerification is the credential-free result of proving a configured
// workload identity can authenticate with its owning provider.
type WorkloadVerification struct {
	Identity  *ContextIdentity
	ExpiresAt time.Time
}

var workloadHTTPClient = func() *http.Client { return network.GetHTTPClient() }

// VerifyConfiguredWorkload configures and proves the configured workload
// identity. No identity configuration is a successful no-op.
func VerifyConfiguredWorkload(ctx context.Context, cfg *types.AuthConfig) (*WorkloadVerification, error) {
	if cfg == nil || cfg.IdentityProvider == "" {
		return nil, nil
	}
	oauthCfg, ok := cfg.OAuth[cfg.IdentityProvider]
	if !ok {
		return nil, fmt.Errorf("auth.identityProvider %q names a missing auth.oauth entry", cfg.IdentityProvider)
	}
	if oauthCfg.MachineIdentity == nil {
		return nil, nil
	}
	provider := CurrentContextIdentityProvider()
	machine, ok := provider.(*MachineIdentityManager)
	if !ok || machine == nil || machine.Provider() != cfg.IdentityProvider {
		if _, err := ConfigureIdentityProviders(cfg); err != nil {
			return nil, err
		}
		provider = CurrentContextIdentityProvider()
		machine, ok = provider.(*MachineIdentityManager)
		if !ok || machine == nil {
			return nil, fmt.Errorf("configured workload identity %q is unavailable", cfg.IdentityProvider)
		}
	}
	return verifyMachineIdentity(ctx, machine)
}

func verifyMachineIdentity(ctx context.Context, machine *MachineIdentityManager) (*WorkloadVerification, error) {
	if machine.AWSProvider() != nil {
		return verifyAWSWorkload(ctx, machine)
	}
	token, err := machine.GetTokenWithAudience(ctx, "", "")
	if err != nil {
		return nil, fmt.Errorf("acquire workload bearer token: %w", err)
	}
	if token == "" {
		return nil, fmt.Errorf("workload bearer token is empty")
	}
	expiresAt, err := time.Parse(time.RFC3339, machine.LastExpiry("", ""))
	if err != nil {
		return nil, fmt.Errorf("read workload token expiry: %w", err)
	}
	identity := &ContextIdentity{Kind: "workload", Provider: machine.Provider(), Source: machine.SourceKind()}
	machine.setVerifiedWorkload(identity)
	return &WorkloadVerification{Identity: cloneContextIdentity(identity), ExpiresAt: expiresAt}, nil
}

type stsCallerIdentityResponse struct {
	Result struct {
		Account string `xml:"Account"`
		ARN     string `xml:"Arn"`
		UserID  string `xml:"UserId"`
	} `xml:"GetCallerIdentityResult"`
}

func verifyAWSWorkload(ctx context.Context, machine *MachineIdentityManager) (*WorkloadVerification, error) {
	region := machine.awsRegion
	if region == "" {
		region = os.Getenv("AWS_DEFAULT_REGION")
	}
	if region == "" {
		region = os.Getenv("AWS_REGION")
	}
	if region == "" {
		return nil, fmt.Errorf("AWS workload verification requires aws.region or AWS_DEFAULT_REGION/AWS_REGION")
	}
	endpoint := machine.awsSTSEndpoint
	if endpoint == "" {
		endpoint = regionalSTSEndpoint(region)
	}
	body := []byte("Action=GetCallerIdentity&Version=2011-06-15")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("build AWS STS GetCallerIdentity request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	authenticator := SigV4Authenticator{Provider: machine.AWSProvider(), Service: "sts", Region: region}
	if err := authenticator.Authenticate(ctx, req, body); err != nil {
		return nil, fmt.Errorf("sign AWS STS GetCallerIdentity request: %w", err)
	}
	client := workloadHTTPClient()
	if client == nil {
		return nil, fmt.Errorf("AWS STS HTTP client is unavailable")
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("send AWS STS GetCallerIdentity request: %w", err)
	}
	defer response.Body.Close() //nolint:errcheck // Read error is authoritative.
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 32769))
	if err != nil {
		return nil, fmt.Errorf("read AWS STS GetCallerIdentity response: %w", err)
	}
	if len(responseBody) > 32768 {
		return nil, fmt.Errorf("AWS STS GetCallerIdentity response exceeds 32768 bytes")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("AWS STS GetCallerIdentity returned HTTP %d", response.StatusCode)
	}
	var decoded stsCallerIdentityResponse
	if err := xml.Unmarshal(responseBody, &decoded); err != nil {
		return nil, fmt.Errorf("decode AWS STS GetCallerIdentity response: %w", err)
	}
	if decoded.Result.ARN == "" {
		return nil, fmt.Errorf("AWS STS GetCallerIdentity response is missing Arn")
	}
	identity := &ContextIdentity{Kind: "workload", Provider: machine.Provider(), Source: machine.SourceKind(), Subject: decoded.Result.ARN,
		Claims: map[string]any{"account": decoded.Result.Account, "arn": decoded.Result.ARN, "userId": decoded.Result.UserID}}
	machine.setVerifiedWorkload(identity)
	credentials, err := machine.AWSProvider().Retrieve(ctx)
	if err != nil {
		return nil, fmt.Errorf("read verified AWS credential expiry: %w", err)
	}
	return &WorkloadVerification{Identity: cloneContextIdentity(identity), ExpiresAt: credentials.ExpiresAt}, nil
}

// VerifyConfiguredWorkloadAtStartup bounds workload proof during engine startup.
func VerifyConfiguredWorkloadAtStartup(cfg *types.AuthConfig) (*WorkloadVerification, error) {
	ctx, cancel := context.WithTimeout(context.Background(), workloadVerificationTimeout)
	defer cancel()
	return VerifyConfiguredWorkload(ctx, cfg)
}
