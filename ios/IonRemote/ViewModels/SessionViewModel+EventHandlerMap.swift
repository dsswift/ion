//  SessionViewModel+EventHandlerMap.swift
//
//  Navigation map for the event-handler surface. The `handleEvent` dispatch in
//  SessionViewModel+EventHandlers.swift routes every RemoteEvent case to a
//  handler, but those handlers are spread across sibling files to keep each one
//  under the 600-line cap. Every handler is a member of the same
//  `extension SessionViewModel`, so the dispatch resolves them with no further
//  wiring — which is convenient but leaves no in-file trail of where anything
//  lives. This file is that trail.
//
//  Extracted from SessionViewModel+EventHandlers.swift when it crossed the cap:
//  the signposts were the natural seam, since they are documentation about the
//  file layout rather than part of the dispatch logic.
//
//  ─── Where each handler lives ───────────────────────────────────────────────
//
//  Connection events
//    handleUnpair, handleLANAuthRejected  → SessionViewModel+ConnectionEvents
//
//  Transcript (the only writer of conversation rows)
//    handleTranscriptPage, handleTranscriptPatch, handleTranscriptUnavailable
//                                         → SessionViewModel+Transcript
//    handlePromptResult, the pending prompt overlay
//                                         → SessionViewModel+PendingPrompts
//
//  Permission / input-prefill events
//    handlePermissionRequest, handleInputPrefill
//                                         → SessionViewModel+PermissionMessageEvents
//
//  Engine events (status, context usage, pinned prompt)
//    handleEngineError, handleEngineMessageEnd, handleEngineDead,
//    handleContextBreakdown               → SessionViewModel+EngineEvents
//
//  Uploads
//    handleUploadAttachmentResult         → SessionViewModel+UploadEvents
