// host_rpc_delegates.go — registry entries for ext/* methods whose
// implementation already lives in its own file.
//
// Every entry in extRequestHandlers must have the same signature, but the
// handlers these wrap predate the registry and take the arguments they
// actually need (some want raw, some want ctx, most want neither). Rather
// than churn those implementations and their tests, this file adapts them.
// Each function is one line and does nothing but forward — the logic, the
// logging, and the response are all the callee's.
package extension

// --- Agents ---

func (h *Host) rpcSetDispatchContextDefaults(_ *Context, id int64, raw []byte) {
	h.handleSetDispatchContextDefaults(id, raw)
}

func (h *Host) rpcWalkContextFiles(_ *Context, id int64, raw []byte) {
	h.handleWalkContextFiles(id, raw)
}

func (h *Host) rpcRecallAgent(ctx *Context, id int64, raw []byte) {
	h.handleRecallRPC(ctx, id, raw)
}

func (h *Host) rpcAnswerDispatchQuestion(_ *Context, id int64, raw []byte) {
	h.handleAnswerDispatchQuestion(id, raw)
}

// --- Steering ---

func (h *Host) rpcSteerDispatch(ctx *Context, id int64, raw []byte) {
	h.steerDispatchByID(ctx, id, raw)
}

func (h *Host) rpcSteerDispatchByName(ctx *Context, id int64, raw []byte) {
	h.steerDispatchByName(ctx, id, raw)
}

func (h *Host) rpcSteerSelf(ctx *Context, id int64, raw []byte) {
	h.steerSelf(ctx, id, raw)
}

// --- Session memory ---

func (h *Host) rpcGetSessionMemory(ctx *Context, id int64, _ []byte) {
	h.handleGetSessionMemory(id, ctx)
}

func (h *Host) rpcSetSessionMemory(ctx *Context, id int64, raw []byte) {
	h.handleSetSessionMemory(id, raw, ctx)
}

// --- Inference and outbound HTTP ---

// rpcLlmCall performs one-shot lightweight inference.
func (h *Host) rpcLlmCall(ctx *Context, id int64, raw []byte) {
	h.handleLLMCallRPC(ctx, id, raw)
}

// rpcHTTPRequest is session-independent: minting an operator token requires
// no session state, so extensions loaded outside an active session
// (schedules, webhooks) can still make authenticated calls.
func (h *Host) rpcHTTPRequest(_ *Context, id int64, raw []byte) {
	h.handleHTTPRequest(id, raw)
}

// --- Resources, notifications, intercept, cross-session, plan mode ---

func (h *Host) rpcDeclareResource(_ *Context, id int64, raw []byte) {
	h.handleDeclareResource(id, raw)
}

func (h *Host) rpcPublishResource(_ *Context, id int64, raw []byte) {
	h.handlePublishResource(id, raw)
}

func (h *Host) rpcNotify(_ *Context, id int64, raw []byte) {
	h.handleNotify(id, raw)
}

func (h *Host) rpcIntercept(_ *Context, id int64, raw []byte) {
	h.handleIntercept(id, raw)
}

func (h *Host) rpcListSessions(_ *Context, id int64, raw []byte) {
	h.handleListSessions(id, raw)
}

func (h *Host) rpcSendToSession(_ *Context, id int64, raw []byte) {
	h.handleSendToSession(id, raw)
}

func (h *Host) rpcSetPlanMode(_ *Context, id int64, raw []byte) {
	h.handleSetPlanMode(id, raw)
}

func (h *Host) rpcGetPlanMode(_ *Context, id int64, raw []byte) {
	h.handleGetPlanMode(id, raw)
}

// --- Async triggers ---

func (h *Host) rpcRegisterWebhookReq(_ *Context, id int64, raw []byte) {
	h.rpcRegisterWebhook(id, raw)
}

func (h *Host) rpcDeregisterWebhookReq(_ *Context, id int64, raw []byte) {
	h.rpcDeregisterWebhook(id, raw)
}

func (h *Host) rpcRegisterScheduleReq(_ *Context, id int64, raw []byte) {
	h.rpcRegisterSchedule(id, raw)
}

func (h *Host) rpcDeregisterScheduleReq(_ *Context, id int64, raw []byte) {
	h.rpcDeregisterSchedule(id, raw)
}

func (h *Host) rpcFireSchedule(_ *Context, id int64, raw []byte) {
	h.handleFireSchedule(id, raw)
}

func (h *Host) rpcGetScheduleStatus(_ *Context, id int64, raw []byte) {
	h.handleGetScheduleStatus(id, raw)
}

func (h *Host) rpcRunOnceCheck(_ *Context, id int64, raw []byte) {
	h.handleRunOnceCheck(id, raw)
}

func (h *Host) rpcRunOnceComplete(_ *Context, id int64, raw []byte) {
	h.handleRunOnceComplete(id, raw)
}
