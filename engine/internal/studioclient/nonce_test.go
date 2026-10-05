package studioclient

import (
	"bytes"
	"testing"
)

// The server mints its nonce URL-safe and unpadded, and reads it with a
// decoder that takes either base64 alphabet. The proof must come out the
// same here: the expected value is what the server's own code computes for
// this nonce and a secret of 32 sevens.
func TestAuthProof_ReadsTheNonceAsTheServerMintsIt(t *testing.T) {
	secret := bytes.Repeat([]byte{7}, 32)
	proof, err := AuthProof("mSL9LYkSD-bZvQCVTmrX6rPgIsC3RBzS6h8HadxDhOA", secret)
	if err != nil || proof != "EfwAGPxnq8YrP+FOp1b3C+A656gKQUTVGHW9jkoeVnQ=" {
		t.Fatalf("proof = %q, err = %v", proof, err)
	}
	// The same bytes in the standard alphabet, padded, give the same proof.
	padded, err := AuthProof("mSL9LYkSD+bZvQCVTmrX6rPgIsC3RBzS6h8HadxDhOA=", secret)
	if err != nil || padded != proof {
		t.Fatalf("padded proof = %q, err = %v", padded, err)
	}
}
