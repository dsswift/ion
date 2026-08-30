import UIKit

/// Scroll positioning for the chat collection.
///
/// Extracted from ChatCollectionView to keep that file under the 600-line cap.
/// These functions form one unit: they all place `contentOffset` against a
/// layout whose cells self-size, which is the shared hazard they exist to
/// handle.
///
/// ── Why every one of them converges rather than setting an offset once ──────
/// The collection view runs with `selfSizingInvalidation = .enabledIncluding\
/// Constraints`. A row's real height is not known until it is measured, so an
/// offset computed from estimates moves the moment measurement catches up.
/// With a handful of rows two passes settle it; with a whole conversation
/// arriving in one apply, measurement runs for many frames and a single
/// correction lands partway up the transcript. Each function below therefore
/// re-resolves its target until the layout goes quiet.
extension ChatCollectionVC {

    /// Breathing room above a chart card when a jump lands on it. Enough that
    /// the card is not flush against the top edge, small enough that the card
    /// stays the subject rather than the turn above it.
    static var chartJumpTopMargin: CGFloat { 16 }

    // MARK: - Scroll

    /// Scroll a specific row into view, near the top of the viewport.
    ///
    /// Returns false when the id is not in the current data source — the caller
    /// then knows the row is not local yet rather than assuming a silent
    /// success. Background history backfill (ConversationBackfill) is what
    /// makes that miss rare: without it, a jump to an older row could not work
    /// at all because the page holding it had never been fetched.
    ///
    /// Converges in two passes for the same reason scrollToBottom does: the
    /// first offset change brings unmeasured self-sizing cells on screen, which
    /// changes contentSize and moves the target. One pass lands near the row;
    /// the second lands on it.
    @discardableResult
    func scrollToRow(id: String, chartId: String? = nil, animated: Bool) -> Bool {
        guard let indexPath = currentIndexPath(forItemId: id) else { return false }
        // Take the viewport away from any pending tail-pin.
        //
        // THE BUG THIS FIXES: dismissing the attachments sheet re-runs
        // updateUIViewController, which applies a snapshot FIRST. That apply
        // sees the view sitting at the tail, tails again, and schedules
        // holdBottomWhileSettling. The jump then set its offset — and the
        // already-queued settle loop pinned the view straight back to the
        // bottom on the next main-queue turn. The jump reported landing, the
        // scroll happened, and the operator saw nothing move.
        //
        // Bumping the generation invalidates that loop: it checks the token on
        // every turn and exits when it no longer owns the viewport.
        scrollGeneration &+= 1
        collectionView.layoutIfNeeded()

        let place: (IndexPath) -> Void = { [weak self] path in
            guard let self else { return }
            guard let frame = self.collectionView.layoutAttributesForItem(at: path)?.frame else {
                // No attributes means the layout has not sized this row yet;
                // scrollToItem still gets it on screen, which the second pass
                // then refines.
                self.collectionView.scrollToItem(at: path, at: .top, animated: false)
                return
            }
            let maxOffset = max(
                self.collectionView.contentSize.height - self.collectionView.bounds.height
                    + self.collectionView.adjustedContentInset.bottom,
                -self.collectionView.adjustedContentInset.top
            )
            let target = min(
                max(frame.minY - self.collectionView.adjustedContentInset.top, -self.collectionView.adjustedContentInset.top),
                maxOffset
            )
            self.collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: animated)
        }

        place(indexPath)
        // Converge across frames, exactly as the bottom-pin does. A single
        // placement is computed from whatever the layout has measured so far;
        // rows above the target then finish sizing, contentSize grows, and the
        // target moves out from under the offset just set. Animated placement
        // makes it worse — the animation runs against an offset that is
        // already stale.
        holdRowWhileSettling(id: id, chartId: chartId, generation: scrollGeneration)
        return true
    }

    func scrollToBottom(animated: Bool) {
        // Resolve any pending self-sizing from reconfigured cells so
        // contentSize reflects the streamed content before we compute the
        // target offset. The previous implementation used
        // `scrollToItem(at:.bottom)`, which consults the layout's stale
        // estimated frame for the last item — during streaming (reconfigure-
        // only snapshots, no structural diff) that frame already appeared
        // fully visible, so the call was a no-op and the view stalled at the
        // old bottom until a user-initiated scroll forced re-measurement.
        let sizeBefore = collectionView.contentSize.height
        collectionView.layoutIfNeeded()
        let bottom = max(
            collectionView.contentSize.height - collectionView.bounds.height
                + collectionView.adjustedContentInset.bottom,
            -collectionView.adjustedContentInset.top
        )
        collectionView.setContentOffset(CGPoint(x: 0, y: bottom), animated: animated)
        guard !animated else { return }
        // Second pass: the offset change may bring unmeasured cells on
        // screen, growing contentSize again. Re-resolve and snap once more
        // so a single scrollToBottom converges on the true bottom.
        collectionView.layoutIfNeeded()
        let newBottom = max(
            collectionView.contentSize.height - collectionView.bounds.height
                + collectionView.adjustedContentInset.bottom,
            -collectionView.adjustedContentInset.top
        )
        if abs(newBottom - bottom) > 1 {
            DiagnosticLog.trace("chat scroll second-pass correction", tag: "view.chatscroll", fields: [
                "count": String(format: "%.1f", newBottom - bottom),
                "reason": String(format: "%.1f", sizeBefore),
                "status": String(format: "%.1f", collectionView.contentSize.height)
            ])
            collectionView.setContentOffset(CGPoint(x: 0, y: newBottom), animated: false)
        }
    }

    /// Hold the viewport at the bottom while a large insert finishes measuring.
    ///
    /// Two passes converge a normal apply, where a handful of rows change. They
    /// do NOT converge a history backfill: ~2000 rows arrive unmeasured, and
    /// self-sizing resolves them over many frames as the layout works through
    /// them. Each resolution grows contentSize beneath the viewport, so the
    /// view drifts off the bottom repeatedly after the apply has "finished" —
    /// which is the intermittent flicker that survived the bulk-page fix.
    ///
    /// Re-pinning across a short window costs nothing when the size is already
    /// stable (the guard below exits on the first frame) and removes the drift
    /// when it is not. It stops early the moment the operator touches the
    /// scroll view: their gesture wins over a pin they did not ask for.
    /// Keep a jumped-to row in place while the layout finishes measuring.
    ///
    /// The mirror of `holdBottomWhileSettling`, for a target that is not the
    /// bottom. Same reasoning: with self-sizing cells an offset computed now is
    /// only correct until the rows above it measure, so the target is
    /// re-resolved until it stops moving.
    ///
    /// Stops on convergence, on a deadline, when the operator touches the
    /// scroll view, or when a newer navigation claims the viewport.
    private func holdRowWhileSettling(
        id: String,
        chartId: String? = nil,
        generation: UInt64,
        deadline: Date = Date().addingTimeInterval(2.0),
        stableFrames: Int = 0
    ) {
        guard generation == scrollGeneration, Date() < deadline else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, let cv = self.collectionView else { return }
            guard generation == self.scrollGeneration else { return }
            guard !cv.isTracking, !cv.isDragging, !cv.isDecelerating else {
                DiagnosticLog.trace("chat scroll row settle yielded to touch", tag: "view.chatscroll")
                return
            }
            guard
                let indexPath = self.currentIndexPath(forItemId: id),
                let frame = cv.layoutAttributesForItem(at: indexPath)?.frame
            else {
                // The row left the transcript mid-settle (a rewind, a heal).
                DiagnosticLog.log("chat scroll row vanished mid-settle", tag: "view.chatscroll", level: .warn, fields: [
                    "row_id": String(id.prefix(12))
                ])
                return
            }

            let maxOffset = max(
                cv.contentSize.height - cv.bounds.height + cv.adjustedContentInset.bottom,
                -cv.adjustedContentInset.top
            )
            // A row is a whole TURN, and a chart card sits at its END — after
            // the assistant text and every tool row. Landing on the row's start
            // therefore parks the operator at the top of a turn that can be
            // screens tall, with the chart they tapped still out of sight.
            //
            // Once the card has laid out it reports its own position, so the
            // exact offset is measurable rather than estimated. Until then the
            // row offset still gets the viewport into the neighbourhood, which
            // is what makes the card lay out in the first place.
            var target = min(
                max(frame.minY - cv.adjustedContentInset.top, -cv.adjustedContentInset.top),
                maxOffset
            )
            var anchoredOnCard = false
            if let chartId, let within = ChartAnchorRegistry.shared.offsetWithinRow(for: chartId) {
                // The row's frame is authoritative and current — the layout
                // just gave it to us. The card's offset within that row is
                // scroll-invariant. Their sum is the card's real position, so
                // this stays correct no matter where the list is or whether
                // the card is currently on screen.
                //
                // The previous version added a stale GLOBAL card frame to the
                // current offset, which produced an arbitrary target: jumps
                // landed at the top or bottom of the conversation and appeared
                // to work only for a chart that was already visible.
                target = min(
                    max(
                        frame.minY + within - cv.adjustedContentInset.top - Self.chartJumpTopMargin,
                        -cv.adjustedContentInset.top
                    ),
                    maxOffset
                )
                anchoredOnCard = true
            }
            let drifted = abs(cv.contentOffset.y - target) > 1
            if drifted {
                cv.setContentOffset(CGPoint(x: 0, y: target), animated: false)
            }
            let quiet = drifted ? 0 : stableFrames + 1
            guard quiet < 6 else {
                DiagnosticLog.log("chat scroll settled on row", tag: "view.chatscroll", fields: [
                    "row_id": String(id.prefix(12)),
                    "anchored_on": anchoredOnCard ? "chart_card" : "row_start",
                    "offset": String(format: "%.0f", cv.contentOffset.y)
                ])
                return
            }
            self.holdRowWhileSettling(
                id: id, chartId: chartId, generation: generation,
                deadline: deadline, stableFrames: quiet
            )
        }
    }

    func holdBottomWhileSettling(
        deadline: Date = Date().addingTimeInterval(2.0),
        stableFrames: Int = 0,
        generation: UInt64? = nil
    ) {
        // Claim the current generation on the first call; carry it afterwards.
        let token = generation ?? scrollGeneration
        guard token == scrollGeneration else {
            DiagnosticLog.trace("chat scroll settle superseded", tag: "view.chatscroll")
            return
        }
        // Stop on the FIRST of: the layout going quiet, or the deadline. A
        // frame count alone was the wrong bound — 2000 self-sizing rows take
        // far longer than a dozen main-queue hops to measure, so a fixed count
        // gave up while contentSize was still growing and the view was left
        // partway up the transcript. Convergence is the real signal; the
        // deadline only stops a pathological layout from pinning forever.
        guard Date() < deadline else {
            DiagnosticLog.log("chat scroll settle hit deadline", tag: "view.chatscroll", level: .warn, fields: [
                "stable_frames": String(stableFrames)
            ])
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, let cv = self.collectionView else { return }
            // A navigation claimed the viewport while this was queued.
            guard token == self.scrollGeneration else {
                DiagnosticLog.log("chat scroll settle superseded by jump", tag: "view.chatscroll")
                return
            }
            // The operator took over — stop pinning immediately.
            guard !cv.isTracking, !cv.isDragging, !cv.isDecelerating else {
                DiagnosticLog.trace("chat scroll settle yielded to touch", tag: "view.chatscroll")
                return
            }
            let bottom = max(
                cv.contentSize.height - cv.bounds.height + cv.adjustedContentInset.bottom,
                -cv.adjustedContentInset.top
            )
            let drifted = abs(cv.contentOffset.y - bottom) > 1
            if drifted {
                cv.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
            }
            // Quiet for several consecutive turns means measurement finished.
            let quiet = drifted ? 0 : stableFrames + 1
            guard quiet < 6 else {
                DiagnosticLog.log("chat scroll settled at bottom", tag: "view.chatscroll", fields: [
                    "offset": String(format: "%.0f", cv.contentOffset.y),
                    "content_height": String(format: "%.0f", cv.contentSize.height)
                ])
                return
            }
            self.holdBottomWhileSettling(deadline: deadline, stableFrames: quiet, generation: token)
        }
    }
}
