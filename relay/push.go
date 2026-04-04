package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/net/http2"
)

const (
	apnsProductionURL = "https://api.push.apple.com"
	apnsSandboxURL    = "https://api.sandbox.push.apple.com"
	apnsTopic         = "com.dsswift.coda.remote"
	tokenTTL          = 50 * time.Minute // Apple requires refresh within 60 min
)

// APNsPusher sends push notifications via Apple's HTTP/2 APNs API.
type APNsPusher struct {
	client  *http.Client
	baseURL string
	keyID   string
	teamID  string
	key     *ecdsa.PrivateKey

	mu          sync.Mutex
	cachedToken string
	tokenExpiry time.Time
}

func NewAPNsPusher(keyPath, keyID, teamID string) (*APNsPusher, error) {
	keyData, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("read APNs key: %w", err)
	}

	block, _ := pem.Decode(keyData)
	if block == nil {
		return nil, fmt.Errorf("invalid PEM in APNs key file")
	}

	parsedKey, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse APNs key: %w", err)
	}

	ecKey, ok := parsedKey.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("APNs key is not ECDSA")
	}

	transport := &http2.Transport{}
	client := &http.Client{Transport: transport}

	// Use sandbox for development; production in release builds.
	baseURL := apnsSandboxURL
	if os.Getenv("APNS_PRODUCTION") == "1" {
		baseURL = apnsProductionURL
	}

	return &APNsPusher{
		client:  client,
		baseURL: baseURL,
		keyID:   keyID,
		teamID:  teamID,
		key:     ecKey,
	}, nil
}

func (p *APNsPusher) getToken() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.cachedToken != "" && time.Now().Before(p.tokenExpiry) {
		return p.cachedToken, nil
	}

	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": p.teamID,
		"iat": now.Unix(),
	})
	token.Header["kid"] = p.keyID

	signed, err := token.SignedString(p.key)
	if err != nil {
		return "", fmt.Errorf("sign APNs token: %w", err)
	}

	p.cachedToken = signed
	p.tokenExpiry = now.Add(tokenTTL)
	return signed, nil
}

type apnsPayload struct {
	Aps apsPayload `json:"aps"`
}

type apsPayload struct {
	Alert            apsAlert `json:"alert"`
	Sound            string   `json:"sound,omitempty"`
	Category         string   `json:"category,omitempty"`
	ContentAvailable int      `json:"content-available,omitempty"`
}

type apsAlert struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

func (p *APNsPusher) Send(deviceToken, title, body string) {
	go p.sendAsync(deviceToken, title, body)
}

func (p *APNsPusher) sendAsync(deviceToken, title, body string) {
	token, err := p.getToken()
	if err != nil {
		log.Printf("APNs token error: %v", err)
		return
	}

	payload := apnsPayload{
		Aps: apsPayload{
			Alert: apsAlert{
				Title: title,
				Body:  body,
			},
			Sound:            "default",
			Category:         "PERMISSION_REQUEST",
			ContentAvailable: 1,
		},
	}

	data, err := json.Marshal(payload)
	if err != nil {
		log.Printf("APNs marshal error: %v", err)
		return
	}

	url := fmt.Sprintf("%s/3/device/%s", p.baseURL, deviceToken)
	req, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		log.Printf("APNs request error: %v", err)
		return
	}

	req.Header.Set("Authorization", "bearer "+token)
	req.Header.Set("apns-topic", apnsTopic)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")

	resp, err := p.client.Do(req)
	if err != nil {
		log.Printf("APNs send error: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		log.Printf("APNs response %d: %s", resp.StatusCode, string(respBody))
	}
}
