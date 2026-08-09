package auth

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const awsTag = "auth.aws"

// AWSCredentials holds temporary AWS credentials with an expiration.
type AWSCredentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	ExpiresAt       time.Time
}

func validateAWSCredentials(credentials *AWSCredentials, requireExpiry bool) error {
	if credentials == nil || credentials.AccessKeyID == "" || credentials.SecretAccessKey == "" {
		return fmt.Errorf("credential response is missing access key ID or secret access key")
	}
	if requireExpiry && credentials.ExpiresAt.IsZero() {
		return fmt.Errorf("temporary credential response is missing expiration")
	}
	return nil
}

// Expired reports whether the credentials have expired or will expire within
// the given threshold.
func (c *AWSCredentials) Expired(threshold time.Duration) bool {
	if c == nil {
		return true
	}
	if c.ExpiresAt.IsZero() {
		return c.AccessKeyID == "" || c.SecretAccessKey == ""
	}
	return time.Now().Add(threshold).After(c.ExpiresAt)
}

// AWSCredentialsProvider acquires temporary AWS credentials from one
// configured source. Implementations are safe for concurrent use.
type AWSCredentialsProvider interface {
	Retrieve(ctx context.Context) (*AWSCredentials, error)
	Kind() string
}

type awsCredentialFlight struct {
	done  chan struct{}
	creds *AWSCredentials
	err   error
}

// CachedAWSProvider wraps an AWSCredentialsProvider with in-memory caching.
// Credentials are refreshed when they are within refreshThreshold of expiry.
type CachedAWSProvider struct {
	inner            AWSCredentialsProvider
	refreshThreshold time.Duration

	mu     sync.Mutex
	cached *AWSCredentials
	flight *awsCredentialFlight
}

const defaultAWSRefreshThreshold = 5 * time.Minute

// NewCachedAWSProvider wraps provider with expiration-based caching.
func NewCachedAWSProvider(provider AWSCredentialsProvider, threshold time.Duration) *CachedAWSProvider {
	if threshold <= 0 {
		threshold = defaultAWSRefreshThreshold
	}
	return &CachedAWSProvider{
		inner:            provider,
		refreshThreshold: threshold,
	}
}

func (c *CachedAWSProvider) Retrieve(ctx context.Context) (*AWSCredentials, error) {
	c.mu.Lock()
	if !c.cached.Expired(c.refreshThreshold) {
		cached := *c.cached
		c.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, awsTag, "returning cached credentials", map[string]any{"source": c.inner.Kind()})
		return &cached, nil
	}
	if flight := c.flight; flight != nil {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-flight.done:
			return flight.creds, flight.err
		}
	}
	flight := &awsCredentialFlight{done: make(chan struct{})}
	c.flight = flight
	c.mu.Unlock()

	credentials, err := c.inner.Retrieve(ctx)
	if err == nil {
		err = validateAWSCredentials(credentials, c.inner.Kind() != "env")
	}
	c.mu.Lock()
	if err == nil {
		copy := *credentials
		c.cached = &copy
		flight.creds = &copy
	}
	flight.err = err
	c.flight = nil
	close(flight.done)
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	utils.LogWithFields(utils.LevelInfo, awsTag, "credentials refreshed", map[string]any{
		"source": c.inner.Kind(), "expires_at": credentials.ExpiresAt.Format(time.RFC3339),
	})
	return credentials, nil
}

func (c *CachedAWSProvider) Kind() string { return c.inner.Kind() }

// noProxyClient returns an *http.Client that skips proxies for link-local
// metadata endpoints (169.254.x.x, fd00::, [::1]). AWS metadata services
// live on link-local addresses; sending those through a corporate proxy
// breaks credential acquisition.
func noProxyClient(timeout time.Duration) *http.Client {
	transport := &http.Transport{
		DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
		Proxy:       nil,
	}
	return &http.Client{Transport: transport, Timeout: timeout}
}

// safeReadBody reads up to limit bytes from r and closes it.
func safeReadBody(r io.ReadCloser, limit int64) ([]byte, error) {
	defer r.Close() //nolint:errcheck // Read-only response; read error is authoritative.
	body, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("credential endpoint response exceeds %d bytes", limit)
	}
	return body, nil
}

// --- IMDSv2 (EC2 instance metadata) ---

type imdsProvider struct {
	endpoint string
	client   *http.Client
}

// NewIMDSProvider creates a provider that fetches credentials from EC2
// IMDSv2 (token-based). endpoint is the base URL; empty defaults to
// http://169.254.169.254.
func NewIMDSProvider(endpoint string) AWSCredentialsProvider {
	if endpoint == "" {
		endpoint = "http://169.254.169.254"
	}
	return &imdsProvider{
		endpoint: strings.TrimRight(endpoint, "/"),
		client:   noProxyClient(5 * time.Second),
	}
}

func (p *imdsProvider) Kind() string { return "imds" }

func (p *imdsProvider) Retrieve(ctx context.Context) (*AWSCredentials, error) {
	token, err := p.getToken(ctx)
	if err != nil {
		return nil, fmt.Errorf("imds: token request: %w", err)
	}

	role, err := p.getRole(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("imds: role lookup: %w", err)
	}

	creds, err := p.getCredentials(ctx, token, role)
	if err != nil {
		return nil, fmt.Errorf("imds: credential fetch for role %q: %w", role, err)
	}
	if err := validateAWSCredentials(creds, true); err != nil {
		return nil, fmt.Errorf("imds: %w", err)
	}

	utils.LogWithFields(utils.LevelInfo, awsTag, "imds credentials acquired", map[string]any{
		"source": "imds", "expires_at": creds.ExpiresAt.Format(time.RFC3339),
	})
	return creds, nil
}

func (p *imdsProvider) getToken(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		p.endpoint+"/latest/api/token", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-aws-ec2-metadata-token-ttl-seconds", "21600")

	resp, err := p.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("IMDSv2 token request failed; containers may require HttpPutResponseHopLimit=2: %w", err)
	}
	body, err := safeReadBody(resp.Body, 4096)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token endpoint returned %d", resp.StatusCode)
	}
	return string(body), nil
}

func (p *imdsProvider) getRole(ctx context.Context, token string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		p.endpoint+"/latest/meta-data/iam/security-credentials/", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-aws-ec2-metadata-token", token)

	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	body, err := safeReadBody(resp.Body, 4096)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("role listing returned %d", resp.StatusCode)
	}
	role := strings.TrimSpace(string(body))
	if role == "" {
		return "", fmt.Errorf("no IAM role attached to instance")
	}
	return role, nil
}

type imdsCredResponse struct {
	Code            string    `json:"Code"`
	AccessKeyID     string    `json:"AccessKeyId"`
	SecretAccessKey string    `json:"SecretAccessKey"`
	Token           string    `json:"Token"`
	Expiration      time.Time `json:"Expiration"`
}

func (p *imdsProvider) getCredentials(ctx context.Context, token, role string) (*AWSCredentials, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		p.endpoint+"/latest/meta-data/iam/security-credentials/"+url.PathEscape(role), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-aws-ec2-metadata-token", token)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	body, err := safeReadBody(resp.Body, 16384)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("credentials endpoint returned %d", resp.StatusCode)
	}

	var cr imdsCredResponse
	if err := json.Unmarshal(body, &cr); err != nil {
		return nil, fmt.Errorf("decode credentials: %w", err)
	}
	if cr.Code != "Success" {
		return nil, fmt.Errorf("credentials response code: %s", cr.Code)
	}

	return &AWSCredentials{
		AccessKeyID:     cr.AccessKeyID,
		SecretAccessKey: cr.SecretAccessKey,
		SessionToken:    cr.Token,
		ExpiresAt:       cr.Expiration,
	}, nil
}

// --- ECS container credentials ---

type ecsProvider struct {
	baseEndpoint string
	relativeURI  string
	client       *http.Client
}

// NewECSProvider creates a provider that fetches credentials from the ECS
// container credentials endpoint. relativeURI is the value of
// AWS_CONTAINER_CREDENTIALS_RELATIVE_URI. endpoint overrides the base
// (default http://169.254.170.2).
func NewECSProvider(relativeURI, endpoint string) AWSCredentialsProvider {
	if endpoint == "" {
		endpoint = "http://169.254.170.2"
	}
	return &ecsProvider{
		baseEndpoint: strings.TrimRight(endpoint, "/"),
		relativeURI:  relativeURI,
		client:       noProxyClient(5 * time.Second),
	}
}

func (p *ecsProvider) Kind() string { return "ecs" }

type ecsCredResponse struct {
	AccessKeyID     string    `json:"AccessKeyId"`
	SecretAccessKey string    `json:"SecretAccessKey"`
	Token           string    `json:"Token"`
	Expiration      time.Time `json:"Expiration"`
}

func (p *ecsProvider) Retrieve(ctx context.Context) (*AWSCredentials, error) {
	reqURL := p.baseEndpoint + p.relativeURI
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("ecs: build request: %w", err)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ecs: credential fetch: %w", err)
	}
	body, err := safeReadBody(resp.Body, 16384)
	if err != nil {
		return nil, fmt.Errorf("ecs: read body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ecs: endpoint returned %d", resp.StatusCode)
	}

	var cr ecsCredResponse
	if err := json.Unmarshal(body, &cr); err != nil {
		return nil, fmt.Errorf("ecs: decode: %w", err)
	}

	utils.LogWithFields(utils.LevelInfo, awsTag, "ecs credentials acquired", map[string]any{
		"expires_at": cr.Expiration.Format(time.RFC3339),
	})
	credentials := &AWSCredentials{
		AccessKeyID:     cr.AccessKeyID,
		SecretAccessKey: cr.SecretAccessKey,
		SessionToken:    cr.Token,
		ExpiresAt:       cr.Expiration,
	}
	if err := validateAWSCredentials(credentials, true); err != nil {
		return nil, fmt.Errorf("ecs: %w", err)
	}
	return credentials, nil
}

// --- EKS pod identity (full URI + auth token file) ---

type eksProvider struct {
	fullURI       string
	authTokenFile string
	client        *http.Client
}

func pinnedContainerClient(fullURI string) (*http.Client, error) {
	u, err := url.Parse(fullURI)
	if err != nil || u.Scheme != "http" || u.Hostname() == "" {
		return nil, fmt.Errorf("full URI must be an absolute http URL")
	}
	host := u.Hostname()
	var validated net.IP
	if ip := net.ParseIP(host); ip != nil {
		validated = ip
	} else if host == "localhost" {
		validated = net.ParseIP("127.0.0.1")
	} else {
		ips, lookupErr := net.LookupIP(host)
		if lookupErr != nil {
			return nil, fmt.Errorf("resolve host %q: %w", host, lookupErr)
		}
		for _, ip := range ips {
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				validated = ip
				break
			}
		}
	}
	if validated == nil || (!validated.IsLoopback() && !validated.IsLinkLocalUnicast()) {
		return nil, fmt.Errorf("full URI host %q is not loopback or link-local", host)
	}
	dialer := &net.Dialer{Timeout: 2 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
			_, port, splitErr := net.SplitHostPort(address)
			if splitErr != nil {
				port = "80"
			}
			return dialer.DialContext(ctx, "tcp", net.JoinHostPort(validated.String(), port))
		},
	}
	return &http.Client{Transport: transport, Timeout: 5 * time.Second}, nil
}

// NewEKSProvider creates a provider that fetches credentials from the EKS
// pod identity agent. fullURI is AWS_CONTAINER_CREDENTIALS_FULL_URI;
// authTokenFile is AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE. fullURI must be
// a loopback or link-local address (safety validation).
func NewEKSProvider(fullURI, authTokenFile string) (AWSCredentialsProvider, error) {
	client, err := pinnedContainerClient(fullURI)
	if err != nil {
		return nil, fmt.Errorf("eks: %w", err)
	}
	return &eksProvider{
		fullURI:       fullURI,
		authTokenFile: authTokenFile,
		client:        client,
	}, nil
}

func (p *eksProvider) Kind() string { return "eks" }

func (p *eksProvider) Retrieve(ctx context.Context) (*AWSCredentials, error) {
	token, err := os.ReadFile(p.authTokenFile)
	if err != nil {
		return nil, fmt.Errorf("eks: read auth token file: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.fullURI, nil)
	if err != nil {
		return nil, fmt.Errorf("eks: build request: %w", err)
	}
	req.Header.Set("Authorization", strings.TrimSpace(string(token)))

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("eks: credential fetch: %w", err)
	}
	body, err := safeReadBody(resp.Body, 16384)
	if err != nil {
		return nil, fmt.Errorf("eks: read body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("eks: endpoint returned %d", resp.StatusCode)
	}

	var cr ecsCredResponse
	if err := json.Unmarshal(body, &cr); err != nil {
		return nil, fmt.Errorf("eks: decode: %w", err)
	}

	utils.LogWithFields(utils.LevelInfo, awsTag, "eks credentials acquired", map[string]any{
		"expires_at": cr.Expiration.Format(time.RFC3339),
	})
	credentials := &AWSCredentials{
		AccessKeyID:     cr.AccessKeyID,
		SecretAccessKey: cr.SecretAccessKey,
		SessionToken:    cr.Token,
		ExpiresAt:       cr.Expiration,
	}
	if err := validateAWSCredentials(credentials, true); err != nil {
		return nil, fmt.Errorf("eks: %w", err)
	}
	return credentials, nil
}

func isLinkLocalOrLoopback(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		return host == "localhost"
	}
	return ip.IsLoopback() || ip.IsLinkLocalUnicast()
}

// validateFullURI ensures the URI targets a safe address. It is retained as a
// pure validation helper for diagnostics/tests; NewEKSProvider additionally
// pins its dialer to the validated address to prevent DNS rebinding.
func validateFullURI(rawURI string) error {
	_, err := pinnedContainerClient(rawURI)
	return err
}

// --- IRSA (IAM Roles for Service Accounts) ---

type irsaProvider struct {
	roleARN     string
	tokenFile   string
	region      string
	stsEndpoint string
	sessionName string
	client      *http.Client
}

// NewIRSAProvider creates a provider that exchanges a projected service
// account JWT for temporary AWS credentials via STS
// AssumeRoleWithWebIdentity. tokenFile is typically the value of
// AWS_WEB_IDENTITY_TOKEN_FILE.
func NewIRSAProvider(cfg types.AWSMachineIdentityConfig, tokenFile string) AWSCredentialsProvider {
	return newIRSAProvider(cfg, tokenFile, nil)
}

func newIRSAProvider(cfg types.AWSMachineIdentityConfig, tokenFile string, clientOverride *http.Client) AWSCredentialsProvider {
	region := cfg.Region
	if region == "" {
		region = os.Getenv("AWS_DEFAULT_REGION")
	}
	if region == "" {
		region = os.Getenv("AWS_REGION")
	}

	endpoint := cfg.STSEndpoint
	if endpoint == "" {
		endpoint = regionalSTSEndpoint(region)
	}

	client := clientOverride
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
		if parsed, err := url.Parse(endpoint); err == nil && isLinkLocalOrLoopback(parsed.Hostname()) {
			client = noProxyClient(10 * time.Second)
		}
	}
	return &irsaProvider{
		roleARN:     cfg.RoleARN,
		tokenFile:   tokenFile,
		region:      region,
		stsEndpoint: endpoint,
		sessionName: "ion-engine",
		client:      client,
	}
}

func (p *irsaProvider) Kind() string { return "irsa" }

func regionalSTSEndpoint(region string) string {
	if region == "" {
		return "https://sts.amazonaws.com"
	}
	return "https://sts." + region + ".amazonaws.com"
}

type stsAssumeRoleResponse struct {
	XMLName xml.Name `xml:"AssumeRoleWithWebIdentityResponse"`
	Result  struct {
		Credentials struct {
			AccessKeyID     string `xml:"AccessKeyId"`
			SecretAccessKey string `xml:"SecretAccessKey"`
			SessionToken    string `xml:"SessionToken"`
			Expiration      string `xml:"Expiration"`
		} `xml:"Credentials"`
	} `xml:"AssumeRoleWithWebIdentityResult"`
}

func (p *irsaProvider) Retrieve(ctx context.Context) (*AWSCredentials, error) {
	tokenBytes, err := os.ReadFile(p.tokenFile)
	if err != nil {
		return nil, fmt.Errorf("irsa: read web identity token: %w", err)
	}
	webToken := strings.TrimSpace(string(tokenBytes))

	params := url.Values{
		"Action":           {"AssumeRoleWithWebIdentity"},
		"Version":          {"2011-06-15"},
		"RoleArn":          {p.roleARN},
		"RoleSessionName":  {p.sessionName},
		"WebIdentityToken": {webToken},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.stsEndpoint,
		strings.NewReader(params.Encode()))
	if err != nil {
		return nil, fmt.Errorf("irsa: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("irsa: sts request: %w", err)
	}
	body, err := safeReadBody(resp.Body, 32768)
	if err != nil {
		return nil, fmt.Errorf("irsa: read sts response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("irsa: sts returned %d: %s", resp.StatusCode, sanitizeSTSError(body))
	}

	var stsResp stsAssumeRoleResponse
	if err := xml.Unmarshal(body, &stsResp); err != nil {
		return nil, fmt.Errorf("irsa: decode sts response: %w", err)
	}

	expiry, err := time.Parse(time.RFC3339, stsResp.Result.Credentials.Expiration)
	if err != nil {
		return nil, fmt.Errorf("irsa: parse expiration: %w", err)
	}

	utils.LogWithFields(utils.LevelInfo, awsTag, "irsa credentials acquired", map[string]any{
		"source":     "irsa",
		"region":     p.region,
		"expires_at": expiry.Format(time.RFC3339),
	})
	credentials := &AWSCredentials{
		AccessKeyID:     stsResp.Result.Credentials.AccessKeyID,
		SecretAccessKey: stsResp.Result.Credentials.SecretAccessKey,
		SessionToken:    stsResp.Result.Credentials.SessionToken,
		ExpiresAt:       expiry,
	}
	if err := validateAWSCredentials(credentials, true); err != nil {
		return nil, fmt.Errorf("irsa: %w", err)
	}
	return credentials, nil
}

// sanitizeSTSError extracts the error message from an STS XML error
// response without leaking tokens or secrets.
func sanitizeSTSError(body []byte) string {
	type stsError struct {
		XMLName xml.Name `xml:"ErrorResponse"`
		Error   struct {
			Code    string `xml:"Code"`
			Message string `xml:"Message"`
		} `xml:"Error"`
	}
	var e stsError
	if xml.Unmarshal(body, &e) == nil && e.Error.Code != "" {
		return e.Error.Code + ": " + e.Error.Message
	}
	if len(body) > 256 {
		body = body[:256]
	}
	return string(body)
}

// --- Environment variable credentials ---

type envProvider struct {
	accessKeyID     string
	secretAccessKey string
	sessionToken    string
}

// NewEnvProvider captures AWS credentials from environment variables at
// construction time, then scrubs them from the process environment so they
// cannot leak to child processes or extensions. The credentials are held
// only in memory.
func NewEnvProvider() (AWSCredentialsProvider, error) {
	akid := os.Getenv("AWS_ACCESS_KEY_ID")
	secret := os.Getenv("AWS_SECRET_ACCESS_KEY")
	if akid == "" || secret == "" {
		return nil, fmt.Errorf("env: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must both be set")
	}
	token := os.Getenv("AWS_SESSION_TOKEN")

	if err := os.Unsetenv("AWS_ACCESS_KEY_ID"); err != nil {
		return nil, fmt.Errorf("env: scrub AWS_ACCESS_KEY_ID: %w", err)
	}
	if err := os.Unsetenv("AWS_SECRET_ACCESS_KEY"); err != nil {
		return nil, fmt.Errorf("env: scrub AWS_SECRET_ACCESS_KEY: %w", err)
	}
	if err := os.Unsetenv("AWS_SESSION_TOKEN"); err != nil {
		return nil, fmt.Errorf("env: scrub AWS_SESSION_TOKEN: %w", err)
	}

	utils.Log(awsTag, "env credentials captured and scrubbed from environment")

	return &envProvider{
		accessKeyID:     akid,
		secretAccessKey: secret,
		sessionToken:    token,
	}, nil
}

func (p *envProvider) Kind() string { return "env" }

func (p *envProvider) Retrieve(_ context.Context) (*AWSCredentials, error) {
	return &AWSCredentials{
		AccessKeyID:     p.accessKeyID,
		SecretAccessKey: p.secretAccessKey,
		SessionToken:    p.sessionToken,
	}, nil
}

// NewAWSCredentialsProvider builds the appropriate provider from config,
// wrapped with expiration-based caching. cfg may be nil (returns error).
// refreshThreshold controls how far before expiry cached credentials are
// refreshed; zero selects the default (5 minutes).
func NewAWSCredentialsProvider(cfg *types.AWSMachineIdentityConfig, thresholds ...time.Duration) (AWSCredentialsProvider, error) {
	if cfg == nil {
		return nil, fmt.Errorf("aws: config is nil")
	}
	refreshThreshold := time.Duration(0)
	if len(thresholds) > 0 {
		refreshThreshold = thresholds[0]
	}

	var inner AWSCredentialsProvider
	var err error

	switch cfg.Kind {
	case "imds":
		inner = NewIMDSProvider("")
	case "ecs":
		relURI := os.Getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
		if relURI == "" {
			return nil, fmt.Errorf("aws ecs: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI not set")
		}
		inner = NewECSProvider(relURI, "")
	case "eks":
		fullURI := os.Getenv("AWS_CONTAINER_CREDENTIALS_FULL_URI")
		if fullURI == "" {
			return nil, fmt.Errorf("aws eks: AWS_CONTAINER_CREDENTIALS_FULL_URI not set")
		}
		tokenFile := os.Getenv("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")
		if tokenFile == "" {
			return nil, fmt.Errorf("aws eks: AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE not set")
		}
		inner, err = NewEKSProvider(fullURI, tokenFile)
		if err != nil {
			return nil, err
		}
	case "irsa":
		tokenFile := os.Getenv("AWS_WEB_IDENTITY_TOKEN_FILE")
		if tokenFile == "" {
			return nil, fmt.Errorf("aws irsa: AWS_WEB_IDENTITY_TOKEN_FILE not set")
		}
		c := *cfg
		if c.RoleARN == "" {
			roleARN := os.Getenv("AWS_ROLE_ARN")
			if roleARN == "" {
				return nil, fmt.Errorf("aws irsa: roleArn not set in config and AWS_ROLE_ARN not set")
			}
			c.RoleARN = roleARN
		}
		inner = NewIRSAProvider(c, tokenFile)
	case "env", "environment":
		inner, err = NewEnvProvider()
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("aws: unknown credential kind %q (expected imds, ecs, eks, irsa, or env)", cfg.Kind)
	}

	return NewCachedAWSProvider(inner, refreshThreshold), nil
}
