import UIKit

// MARK: - ChatTailingCollectionView

/// A collection view that can hold its own viewport at the bottom.
///
/// The tail is a property of the VIEW, re-asserted on every layout pass, rather
/// than something a caller schedules and hopes finishes in time. See
/// `tailCorrection` for the defect that made this necessary: a transcript's
/// rows keep growing after the apply that inserted them — asynchronous markdown,
/// code highlighting and remote images all resolve later and each one moves the
/// bottom — so any time-boxed pin lets go while the content is still settling.
///
/// `layoutSubviews` is the right hook because it runs after every measurement
/// the scroll view performs: a self-sizing cell resolving, a content inset
/// change, a bounds change. Writing `contentOffset` here lands in the same
/// frame as the growth that caused it, so the operator never sees an
/// intermediate position.
final class ChatTailingCollectionView: UICollectionView {

    /// The viewport belongs to the tail: nothing has claimed it since.
    ///
    /// Set when an apply (or an explicit scroll-to-bottom) puts the view at the
    /// bottom; cleared the moment the operator drags or a jump navigates
    /// elsewhere. It is intent, not geometry — which is why content growing
    /// underneath cannot revoke it.
    var tailIntent = false

    /// Reports each correction the pin applied, in points. The VC logs from
    /// here so the drift the tail absorbed is visible after the fact.
    var onTailCorrection: ((CGFloat) -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let target = tailCorrection(
            tailIntent: tailIntent,
            isUserInteracting: isTracking || isDragging || isDecelerating,
            contentOffsetY: contentOffset.y,
            contentHeight: contentSize.height,
            viewportHeight: bounds.height,
            topInset: adjustedContentInset.top,
            bottomInset: adjustedContentInset.bottom
        ) else { return }
        let drift = target - contentOffset.y
        // Assigned directly rather than through setContentOffset(_:animated:):
        // inside a layout pass the animated variant would start an animation
        // against a height that is still changing.
        contentOffset.y = target
        onTailCorrection?(drift)
    }
}

/// Scroll positioning for the chat collection.
///
/// Extracted from ChatCollectionView to keep that file under the 600-line cap.
/// These functions form one unit: they all place `contentOffset` against a
/// layout whose cells self-size, which is the shared hazard they exist to
/// handle.
///
/// ── Why the row jump converges rather than setting an offset once ──────────
/// The collection view runs with `selfSizingInvalidation = .enabledIncluding\
/// Constraints`. A row's real height is not known until it is measured, so an
/// offset computed from estimates moves the moment measurement catches up. The
/// bottom is held by `ChatTailingCollectionView` above, which needs no
/// convergence loop at all; a jump to a specific row has no such hook, so it
/// re-resolves its target until the layout goes quiet.
extension ChatCollectionVC {

    /// Breathing room above a chart card when a jump lands on it. Enough that
    /// the card is not flush against the top edge, small enough that the card
    /// stays the subject rather than the turn above it.
    static var chartJumpTopMargin: CGFloat { 16 }

    /// The offset that puts the viewport at the very bottom, for this view's
    /// current geometry.
    var bottomOffset: CGFloat {
        bottomContentOffset(
            contentHeight: collectionView.contentSize.height,
            viewportHeight: collectionView.bounds.height,
            topInset: collectionView.adjustedContentInset.top,
            bottomInset: collectionView.adjustedContentInset.bottom
        )
    }

    // MARK: - Scroll

    /// Scroll a specific row into view, near the top of the viewport.
    ///
    /// Returns false when the id is not in the current data source — the caller
    /// then knows the row is not local yet rather than assuming a silent
    /// success.
    ///
    /// Converges in repeated passes: the first offset change brings unmeasured
    /// self-sizing cells on screen, which changes contentSize and moves the
    /// target. One pass lands near the row; the rest land on it.
    @discardableResult
    func scrollToRow(id: String, chartId: String? = nil, animated: Bool) -> Bool {
        guard let indexPath = currentIndexPath(forItemId: id) else { return false }
        // Take the viewport away from the tail.
        //
        // THE BUG THIS FIXES: dismissing the attachments sheet re-runs
        // updateUIViewController, which applies a snapshot FIRST. That apply
        // sees the view sitting at the tail and tails again. The jump then set
        // its offset — and the tail pinned the view straight back to the bottom
        // on the next layout pass. The jump reported landing, the scroll
        // happened, and the operator saw nothing move.
        setTailIntent(false, reason: "row_jump")
        scrollGeneration &+= 1
        collectionView.layoutIfNeeded()

        let place: (IndexPath) -> Void = { [weak self] path in
            guard let self else { return }
            guard let frame = self.collectionView.layoutAttributesForItem(at: path)?.frame else {
                // No attributes means the layout has not sized this row yet;
                // scrollToItem still gets it on screen, which the later passes
                // then refine.
                self.collectionView.scrollToItem(at: path, at: .top, animated: false)
                return
            }
            let target = min(
                max(
                    frame.minY - self.collectionView.adjustedContentInset.top,
                    -self.collectionView.adjustedContentInset.top
                ),
                self.bottomOffset
            )
            self.collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: animated)
        }

        place(indexPath)
        // Converge across frames. A single placement is computed from whatever
        // the layout has measured so far; rows above the target then finish
        // sizing, contentSize grows, and the target moves out from under the
        // offset just set. Animated placement makes it worse — the animation
        // runs against an offset that is already stale.
        holdRowWhileSettling(id: id, chartId: chartId, generation: scrollGeneration)
        return true
    }

    /// Put the viewport at the bottom and hand it to the tail.
    ///
    /// The offset set here is only the first placement. Every later growth —
    /// a cell finishing its measurement, an image arriving, the keyboard
    /// changing the inset — is caught by `ChatTailingCollectionView`, which
    /// re-pins on the layout pass that produced it.
    func scrollToBottom(animated: Bool) {
        setTailIntent(true, reason: "scroll_to_bottom")
        // Resolve any pending self-sizing from reconfigured cells so
        // contentSize reflects the streamed content before we compute the
        // target offset. `scrollToItem(at:.bottom)` cannot be used here: it
        // consults the layout's stale estimated frame for the last item, which
        // during streaming already appears fully visible, so the call is a
        // no-op and the view stalls at the old bottom.
        collectionView.layoutIfNeeded()
        collectionView.setContentOffset(CGPoint(x: 0, y: bottomOffset), animated: animated)
    }

    /// Record who owns the viewport, and log the handover.
    ///
    /// Every transition is logged because the two failure modes — the view
    /// holding the bottom when the operator wanted to read history, and the
    /// view letting go of it while a conversation is still measuring — are
    /// indistinguishable from the outside without knowing which side held the
    /// intent and when.
    func setTailIntent(_ intent: Bool, reason: String) {
        guard let cv = collectionView else { return }
        guard cv.tailIntent != intent else { return }
        cv.tailIntent = intent
        if intent {
            tailCorrectionCount = 0
            tailDriftTotal = 0
            DiagnosticLog.log("chat tail held", tag: "view.chatscroll", fields: [
                "reason": reason,
                "content_height": String(format: "%.0f", cv.contentSize.height),
                "offset": String(format: "%.0f", cv.contentOffset.y)
            ])
        } else {
            DiagnosticLog.log("chat tail released", tag: "view.chatscroll", fields: [
                "reason": reason,
                "corrections": String(tailCorrectionCount),
                "drift_absorbed": String(format: "%.0f", tailDriftTotal),
                "content_height": String(format: "%.0f", cv.contentSize.height)
            ])
        }
    }

    /// Keep a jumped-to row in place while the layout finishes measuring.
    ///
    /// The counterpart to the tail pin, for a target that is not the bottom.
    /// Same reasoning: with self-sizing cells an offset computed now is only
    /// correct until the rows above it measure, so the target is re-resolved
    /// until it stops moving.
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

            let maxOffset = self.bottomOffset
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
}
