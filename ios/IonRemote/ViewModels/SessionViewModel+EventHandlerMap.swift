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
//    handleRelayConfig                    → SessionViewModel+RelayAuth
//
//  Permission / message events
//    handlePermissionRequest, handleConversationHistory, handleMessageAdded,
//    handleMessageUpdated, handleInputPrefill
//                                         → SessionViewModel+PermissionMessageEvents
//
//  Engine events
//    handleContextBreakdown               → SessionViewModel+EngineEvents
//
//  Conversation helpers
//    deduplicateMessages                  → SessionViewModel+ConversationHelpers
//
//  Uploads
//    handleUploadAttachmentResult         → SessionViewModel+UploadEvents
//
//  Thinking events
//    the thinking-block accumulator       → SessionViewModel+ThinkingEvents
