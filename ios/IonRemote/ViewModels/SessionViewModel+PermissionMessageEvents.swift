import Foundation

// MARK: - Permission and input-prefill event handlers
//
// Extracted from SessionViewModel+EventHandlers.swift to keep that file
// under the 600-line Swift cap. The handlers continue to be members of
// the same `extension SessionViewModel` and are dispatched from
// handleEvent in the original file.

extension SessionViewModel {

    @MainActor
    func handlePermissionRequest(tabId: String, instanceId: String? = nil, questionId: String, toolName: String, toolInput: [String: AnyCodable]?, options: [PermissionOption]) {
        let inputKeys = toolInput?.keys.sorted() ?? []
        let inputSummary = toolInput?.map { "\($0.key): \(type(of: $0.value.value))" }.joined(separator: ", ") ?? "nil"
        let hasEngineExtension = tabs.first(where: { $0.id == tabId })?.hasEngineExtension == true
        DiagnosticLog.log("permission request", tag: "session.perm", fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": instanceId?.prefix(8).description ?? "nil",
            "question_id": String(questionId.prefix(16)),
            "tool": toolName,
            "count": String(inputKeys.count),
            "status": inputSummary,
            "agent": String(hasEngineExtension)
        ])

        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            // RC-19: a fresh permission request means a NEW special card for this
            // tab — clear any prior dismissal so the snapshot sweep / restored-card
            // path does not strip it as "already dismissed".
            dismissedLiveSpecialTabs.remove(tabId)
            if let instanceId {
                dismissedLiveSpecialTabs.remove("\(tabId):\(instanceId)")
            }
            // Normalize AnyCodable toolInput to Foundation types so the
            // card views can parse with simple `as?` casts. The Codable
            // decoder wraps nested values as [AnyCodable]/[String: AnyCodable],
            // but the card views expect Foundation types (NSArray/NSDictionary)
            // which is what JSONSerialization produces.
            var normalizedInput = toolInput
            if let input = toolInput,
               // Normalization round-trip only: if re-encoding fails, normalizedInput keeps the original toolInput.
               // swiftlint:disable:next silent_try_optional
               let data = try? JSONEncoder().encode(input),
               // Normalization round-trip only: if re-parsing fails, normalizedInput keeps the original toolInput.
               // swiftlint:disable:next silent_try_optional
               let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                normalizedInput = dict.mapValues { AnyCodable($0) }
                let normalizedSummary = normalizedInput?.map { "\($0.key): \(type(of: $0.value.value))" }.joined(separator: ", ") ?? "nil"
                DiagnosticLog.log("permission request normalized tool input", tag: "session.perm", fields: [
                    "status": normalizedSummary
                ])
            } else {
                DiagnosticLog.log("PERM: handlePermissionRequest: normalization failed or skipped, using raw toolInput")
            }
            let request = PermissionRequest(
                questionId: questionId,
                toolName: toolName,
                toolInput: normalizedInput,
                options: options,
                instanceId: instanceId
            )
            DiagnosticLog.log("permission request queued", tag: "session.perm", fields: [
                "tab_id": String(tabId.prefix(8)),
                "count": String(self.tabs[idx].permissionQueue.count + 1)
            ])
            tabs[idx].permissionQueue.append(request)
        } else {
            DiagnosticLog.log("permission request tab not found", tag: "session.perm", level: .warn, fields: [
                "tab_id": String(tabId.prefix(8))
            ])
        }
    }

    @MainActor
    func handleInputPrefill(tabId: String, text: String, switchTo: Bool, instanceId: String?) {
        // Engine-instance prefill (engine_rewind): seed the engine instance's
        // draft, not the CLI input. The rewind's shortened transcript arrives
        // as a transcript patch like any other change; here we only place the
        // rewound user message back in the input box.
        if let instanceId {
            DiagnosticLog.log("input prefill to engine draft", tag: "session.prefill", fields: [
                "tab_id": String(tabId.prefix(8)),
                "reason": String(instanceId.prefix(8)),
                "count": String(text.count)
            ])
            setEngineDraft(tabId: tabId, instanceId: instanceId, text)
            if switchTo {
                pendingNavigationTabId = tabId
            }
            return
        }

        // A fork creates a new Plain tab and replies without an instanceId.
        // Plain is still a normal one-instance conversation, so its visible
        // input reads the SAME bare-tab draft store as every other tab. The
        // retired prefill map was never read by any view, which made
        // a successful fork appear without its promised editable prefill.
        setTabDraft(tabId, text)
        if switchTo {
            pendingNavigationTabId = tabId
        }
    }
}
