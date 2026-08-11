// hook_reflect.go — reflection over hook descriptors.
//
// The descriptor table in hook_descriptors.go is a list of Hook[P, R] values
// with different type parameters, so it cannot be a homogeneous slice.
// descriptorOf erases the parameters into a descriptorInfo carrying the two
// reflect.Types, which is what the parity test compares against the engine's
// contract manifest.
package ion

import "reflect"

// descriptorInfo is a type-erased hook descriptor.
type descriptorInfo struct {
	// Name is the wire hook name.
	Name string
	// Payload is the descriptor's P.
	Payload reflect.Type
	// Result is the descriptor's R.
	Result reflect.Type
}

// descriptorOf erases a typed descriptor's parameters.
func descriptorOf[P any, R any](h Hook[P, R]) descriptorInfo {
	var p P
	var r R
	return descriptorInfo{
		Name:    h.Name,
		Payload: reflect.TypeOf(p),
		Result:  reflect.TypeOf(r),
	}
}

// HookDescriptors returns every hook this SDK version models, with the payload
// and result types it will decode and encode. Exported so an extension can
// introspect its own coverage, and used by the parity test to check this SDK
// against the engine's contract manifest.
func HookDescriptors() []HookInfo {
	descs := allHookDescriptors()
	out := make([]HookInfo, 0, len(descs))
	for _, d := range descs {
		out = append(out, HookInfo{
			Name:        d.Name,
			PayloadType: d.Payload,
			ResultType:  d.Result,
		})
	}
	return out
}
