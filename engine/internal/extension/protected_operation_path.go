package extension

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// protectedPathParam matches one {name} placeholder in a protected
// operation's URL path.
var protectedPathParam = regexp.MustCompile(`\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// validateProtectedPathTemplate confirms placeholders appear only in the
// path, never in the scheme, host, user info, query, or fragment, so no
// payload value can reach a part of the URL that picks the destination.
func validateProtectedPathTemplate(target *url.URL) error {
	for part, value := range map[string]string{
		"host": target.Host, "query": target.RawQuery, "fragment": target.Fragment, "userinfo": target.User.String(),
	} {
		if strings.ContainsAny(value, "{}") {
			return fmt.Errorf("path parameters are only allowed in the url path, found one in the %s", part)
		}
	}
	return nil
}

// expandProtectedPath fills each {name} in rawURL's path with the payload's
// top-level field of that name. Each value must be a non-empty string or a
// number, is path-escaped so it stays one segment, and may not be "." or
// "..". The expanded URL must keep the declared scheme and host.
func expandProtectedPath(rawURL string, declared *url.URL, payload any) (*url.URL, error) {
	names := protectedPathParam.FindAllStringSubmatch(rawURL, -1)
	if len(names) == 0 {
		return declared, nil
	}
	fields, ok := payload.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("the url has path parameters, so the payload must be a JSON object")
	}
	var fillErr error
	expanded := protectedPathParam.ReplaceAllStringFunc(rawURL, func(match string) string {
		name := match[1 : len(match)-1]
		segment, err := protectedPathSegment(name, fields[name])
		if err != nil && fillErr == nil {
			fillErr = err
		}
		return url.PathEscape(segment)
	})
	if fillErr != nil {
		return nil, fillErr
	}
	target, err := url.Parse(expanded)
	if err != nil {
		return nil, fmt.Errorf("expanded url is invalid: %w", err)
	}
	if target.Scheme != declared.Scheme || target.Host != declared.Host {
		return nil, fmt.Errorf("path parameters changed the destination")
	}
	return target, nil
}

func protectedPathSegment(name string, value any) (string, error) {
	var segment string
	switch v := value.(type) {
	case string:
		segment = v
	case float64:
		segment = strconv.FormatFloat(v, 'f', -1, 64)
	case nil:
		return "", fmt.Errorf("path parameter %q is missing from the payload", name)
	default:
		return "", fmt.Errorf("path parameter %q must be a string or a number", name)
	}
	if segment == "" || segment == "." || segment == ".." {
		return "", fmt.Errorf("path parameter %q may not be empty, \".\", or \"..\"", name)
	}
	return segment, nil
}
