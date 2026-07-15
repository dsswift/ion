import Foundation

// MARK: - Event stream listening
//
// Extracted from SessionViewModel+EventHandlers.swift to stay under the 600-line
// file cap (that file is not allowlisted; split at a clean seam rather than trim
// comments). This owns the transport→batcher collector and the ~16ms flush loop
// that drains batched events onto the MainActor; event dispatch itself stays in
// SessionViewModel+EventHandlers.swift (`handleEvent`).

extension SessionViewModel {

    func startListening() {
        eventTask?.cancel()
        flushTask?.cancel()

        // Collector: read events from transport and enqueue into batcher
        eventTask = Task { [weak self] in
            guard let self, let transport = self.transport else { return }

            for await event in transport.events {
                guard !Task.isCancelled else { break }
                await self.eventBatcher.enqueue(event)
            }

            // Stream ended naturally -- flush remaining events.
            // Don't wipe state here: softReconnect keeps state alive.
            // Only wipe if cancelled explicitly via disconnect().
            guard !Task.isCancelled else { return }
            let remaining = await self.eventBatcher.drain()
            if !remaining.isEmpty {
                await MainActor.run {
                    for event in remaining { self.handleEvent(event) }
                }
            }
        }

        // Flusher: drain batched events every ~16ms and process on MainActor
        flushTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(16))
                guard !Task.isCancelled, let self else { break }
                let batch = await self.eventBatcher.drain()
                // Sync connectionQuality.transportState so signal bars update promptly.
                let latestTransport = self.transport?.state ?? .disconnected
                let needsStateSync = self.connectionQuality.transportState != latestTransport
                guard !batch.isEmpty || needsStateSync else { continue }
                await MainActor.run {
                    for event in batch {
                        self.handleEvent(event)
                    }
                    if needsStateSync {
                        self.connectionQuality.transportState = latestTransport
                    }
                }
            }
        }
    }
}
