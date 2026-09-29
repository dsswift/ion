package providers

import "fmt"

// providerAPIError builds the error text for a response the provider refused.
//
// It names the configured provider first and the wire format second. One wire
// format serves many providers: a gateway registered as its own provider
// speaks the Anthropic or OpenAI wire, so a message that named only the wire
// told the operator the wrong company refused the request.
//
// status is 0 for a failure reported inside an otherwise successful stream.
func providerAPIError(providerID, wire string, status int, body string) error {
	if status == 0 {
		return fmt.Errorf("provider %q (%s API) reported an error: %s", providerID, wire, body)
	}
	return fmt.Errorf("provider %q (%s API) returned HTTP %d: %s", providerID, wire, status, body)
}
