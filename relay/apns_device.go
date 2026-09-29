package main

// APNs environments a device token can belong to. Apple issues a token from
// exactly one: a development-signed build (Xcode, `make ios`) registers with
// the sandbox, a distribution-signed build (TestFlight, App Store) with
// production. A token sent to the other environment is refused with
// BadDeviceToken, so the relay routes each push by its token's environment.
const (
	apnsEnvSandbox    = "sandbox"
	apnsEnvProduction = "production"
)

// apnsDevice is one phone's push address: its device token and the APNs
// environment that issued it. The server owns it and sends it with each push
// (relayMessage.PushToken / PushEnv). Env is empty when the server did not
// say; the pusher then uses its configured default.
type apnsDevice struct {
	Token string `json:"token"`
	Env   string `json:"env,omitempty"`
}

// parseAPNsEnv validates a push's `pushEnv`. Empty is valid and means "not
// reported"; anything else outside the two environments is not.
func parseAPNsEnv(v string) (string, bool) {
	switch v {
	case "", apnsEnvSandbox, apnsEnvProduction:
		return v, true
	default:
		return "", false
	}
}
