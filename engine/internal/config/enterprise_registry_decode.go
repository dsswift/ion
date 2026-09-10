package config

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
)

// RegistryValueKind classifies a raw Windows registry value the way
// enterprise_windows.go reads it: REG_SZ/REG_EXPAND_SZ collapse to a single
// string, REG_MULTI_SZ to a string slice, REG_DWORD/REG_QWORD to a number.
// This file is platform-independent (no golang.org/x/sys/windows import) so
// its decoding table is unit-tested on every OS; only the registry read
// itself lives behind the windows build tag.
type RegistryValueKind int

const (
	RegString RegistryValueKind = iota
	RegMultiString
	RegInteger
)

// registryValue is one name/value pair read from the policy key, already
// classified by kind. Name is compared case-insensitively against the
// EnterpriseConfig field's json tag.
type registryValue struct {
	Name  string
	Kind  RegistryValueKind
	Str   string
	Strs  []string
	Num   uint64
}

// reservedMetadataNames are registry value names the desktop reads directly
// (machine identity stamping) and the engine explicitly ignores rather than
// reporting as unknown policy. See manifest contract C5.
var reservedMetadataNames = map[string]bool{
	"mdmdeviceid":     true,
	"mdmserialnumber": true,
}

// fieldSpec describes one EnterpriseConfig field as addressed by registry
// value name: its JSON tag (the canonical name written back into the
// assembled config) and the decoding kind rawFor must apply.
type fieldSpec struct {
	tag  string
	kind fieldKind
}

type fieldKind int

const (
	kindString fieldKind = iota
	kindStrings
	kindBool
	kindNumber
	kindObject
)

var (
	fieldIndexOnce sync.Once
	fieldIndex     map[string]fieldSpec
)

// enterpriseFieldIndex builds, once, a lower(json-tag) -> fieldSpec map by
// reflecting over types.EnterpriseConfig. This is what makes every current
// and future EnterpriseConfig field addressable by registry value name
// without a second hand-maintained list.
func enterpriseFieldIndex() map[string]fieldSpec {
	fieldIndexOnce.Do(func() {
		fieldIndex = make(map[string]fieldSpec)
		t := reflect.TypeOf(types.EnterpriseConfig{})
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			tag := f.Tag.Get("json")
			if tag == "" || tag == "-" {
				continue
			}
			name, _, _ := strings.Cut(tag, ",")
			if name == "" {
				continue
			}
			fieldIndex[strings.ToLower(name)] = fieldSpec{tag: name, kind: kindOf(f.Type)}
		}
	})
	return fieldIndex
}

// kindOf classifies a struct field's Go type into the four registry-value
// shapes rawFor's decoding table distinguishes.
func kindOf(t reflect.Type) fieldKind {
	// Unwrap a single pointer layer (every nested-block field is *T).
	if t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.String:
		return kindString
	case reflect.Bool:
		return kindBool
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return kindNumber
	case reflect.Slice:
		if t.Elem().Kind() == reflect.String {
			return kindStrings
		}
		return kindObject // slice of struct (e.g. RequiredHooks, ExtensionAllowlist)
	default:
		return kindObject // struct, map, or anything else
	}
}

// decodeWarning names a registry value that was recognized (matched a known
// field) but failed to decode into that field's shape.
type decodeWarning struct {
	Name  string
	Error error
}

// decodeRegistryValues assembles an EnterpriseConfig from the registry
// values read under the policy key, per manifest contract C5:
//
//  1. ConfigJson / Config (case-insensitive alias) applied first as a whole
//     JSON object merged at the root.
//  2. Every other recognized value overlays ConfigJson's keys.
//  3. Reserved metadata names (MDMDeviceID, MDMSerialNumber) are skipped —
//     the desktop reads them directly; the engine never treats them as
//     config.
//  4. An unrecognized name is reported (caller logs WARN) but does not fail
//     the whole read. A value that fails to decode is reported the same way
//     and skipped; every other value still applies.
func decodeRegistryValues(values []registryValue) (*types.EnterpriseConfig, []string, []decodeWarning) {
	index := enterpriseFieldIndex()
	raw := map[string]json.RawMessage{}
	var unknown []string
	var warnings []decodeWarning

	// Pass 1: ConfigJson / Config, in the order the caller's values slice
	// lists them — later of the two wins at the root level, matching the
	// registry API's own value enumeration order (documented, not
	// alphabetized, by this decoder).
	for _, v := range values {
		lower := strings.ToLower(v.Name)
		if lower != "configjson" && lower != "config" {
			continue
		}
		text := joinIfMulti(v)
		var obj map[string]json.RawMessage
		if err := json.Unmarshal([]byte(text), &obj); err != nil {
			warnings = append(warnings, decodeWarning{Name: v.Name, Error: fmt.Errorf("invalid JSON object: %w", err)})
			continue
		}
		for k, val := range obj {
			raw[k] = val
		}
	}

	// Pass 2: explicit per-field values override ConfigJson's keys.
	for _, v := range values {
		lower := strings.ToLower(v.Name)
		if lower == "configjson" || lower == "config" {
			continue
		}
		if reservedMetadataNames[lower] {
			continue
		}
		spec, ok := index[lower]
		if !ok {
			unknown = append(unknown, v.Name)
			continue
		}
		rm, err := rawFor(spec.kind, v)
		if err != nil {
			warnings = append(warnings, decodeWarning{Name: v.Name, Error: err})
			continue
		}
		raw[spec.tag] = rm
	}

	b, err := json.Marshal(raw)
	if err != nil {
		warnings = append(warnings, decodeWarning{Name: "(assembly)", Error: err})
		return nil, unknown, warnings
	}
	var cfg types.EnterpriseConfig
	if err := json.Unmarshal(b, &cfg); err != nil {
		warnings = append(warnings, decodeWarning{Name: "(assembly)", Error: err})
		return nil, unknown, warnings
	}
	return &cfg, unknown, warnings
}

// joinIfMulti renders a registry value as the text ConfigJson expects: a
// multi-line REG_MULTI_SZ delivery (the ADMX multiText element shape) is
// joined with \n before parsing.
func joinIfMulti(v registryValue) string {
	if v.Kind == RegMultiString {
		return strings.Join(v.Strs, "\n")
	}
	return v.Str
}

// rawFor decodes one registry value into the json.RawMessage the assembled
// EnterpriseConfig will unmarshal from, per the manifest contract C5 table:
//
//	Registry kind     | string field       | []string field         | bool field           | number field       | object field
//	------------------|--------------------|------------------------|----------------------|--------------------|-----------------------
//	REG_SZ/EXPAND_SZ  | verbatim           | JSON array text        | JSON true/false      | JSON number        | JSON object text
//	REG_MULTI_SZ      | lines joined \n    | one entry per line     | lines joined -> JSON | lines joined->JSON | lines joined \n->JSON
//	REG_DWORD/QWORD   | decimal text       | error                  | non-zero             | the number         | error
func rawFor(kind fieldKind, v registryValue) (json.RawMessage, error) {
	switch kind {
	case kindString:
		switch v.Kind {
		case RegString:
			return json.Marshal(v.Str)
		case RegMultiString:
			return json.Marshal(strings.Join(v.Strs, "\n"))
		case RegInteger:
			return json.Marshal(strconv.FormatUint(v.Num, 10))
		}
	case kindStrings:
		switch v.Kind {
		case RegString:
			var arr []string
			if err := json.Unmarshal([]byte(v.Str), &arr); err != nil {
				return nil, fmt.Errorf("expected a JSON array of strings: %w", err)
			}
			return json.Marshal(arr)
		case RegMultiString:
			return json.Marshal(v.Strs)
		case RegInteger:
			return nil, fmt.Errorf("a REG_DWORD/REG_QWORD cannot decode to a string list")
		}
	case kindBool:
		switch v.Kind {
		case RegString:
			b, err := parseBoolString(v.Str)
			if err != nil {
				return nil, err
			}
			return json.Marshal(b)
		case RegMultiString:
			b, err := parseBoolString(strings.Join(v.Strs, "\n"))
			if err != nil {
				return nil, err
			}
			return json.Marshal(b)
		case RegInteger:
			return json.Marshal(v.Num != 0)
		}
	case kindNumber:
		switch v.Kind {
		case RegString:
			var num json.Number
			if err := json.Unmarshal([]byte(v.Str), &num); err != nil {
				return nil, fmt.Errorf("expected a JSON number: %w", err)
			}
			return json.RawMessage(num), nil
		case RegMultiString:
			var num json.Number
			if err := json.Unmarshal([]byte(strings.Join(v.Strs, "\n")), &num); err != nil {
				return nil, fmt.Errorf("expected a JSON number: %w", err)
			}
			return json.RawMessage(num), nil
		case RegInteger:
			return json.Marshal(v.Num)
		}
	case kindObject:
		switch v.Kind {
		case RegString:
			if !json.Valid([]byte(v.Str)) {
				return nil, fmt.Errorf("expected a JSON object")
			}
			return json.RawMessage(v.Str), nil
		case RegMultiString:
			text := strings.Join(v.Strs, "\n")
			if !json.Valid([]byte(text)) {
				return nil, fmt.Errorf("expected a JSON object")
			}
			return json.RawMessage(text), nil
		case RegInteger:
			return nil, fmt.Errorf("a REG_DWORD/REG_QWORD cannot decode to an object")
		}
	}
	return nil, fmt.Errorf("unhandled registry value kind")
}

func parseBoolString(s string) (bool, error) {
	s = strings.TrimSpace(s)
	switch s {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("expected true or false, got %q", s)
	}
}
