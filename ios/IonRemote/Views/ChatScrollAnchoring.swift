import Foundation

// MARK: - Chat scroll anchoring
//
// Pure decision helpers for ChatCollectionVC. These live outside the view
// controller so they are unit-testable without a UIKit host: the iOS test
// suite is logic-level (no window, no run loop, no layout pass), and the
// scroll behaviors these encode are exactly the ones that regressed
// invisibly when they were tangled into the apply path.
//
// Three separate decisions, three separate functions:
//   1. shouldAutoTail       — may this apply move the view to the bottom?
//   2. itemsNeedingReconfigure — which rows actually changed content?
//   3. anchoredOffset       — where must contentOffset land to hold the
//                             user's reading position steady?

/// Whether a snapshot apply is allowed to scroll the view to the bottom.
///
/// The inputs are deliberately all facts the caller reads at apply time from
/// live scroll-view geometry — NOT a value that round-tripped through a
/// SwiftUI binding. That distinction is the whole point of this function.
///
/// The previous implementation decided from the `isNearBottom` @Binding, which
/// the VC publishes asynchronously (`DispatchQueue.main.async`). Between the
/// user scrolling away from the bottom and SwiftUI re-rendering the host with
/// the new value, every apply read a stale `true` and yanked the user to the
/// bottom. During streaming, applies land every few milliseconds, so that
/// window was hit constantly — the "it takes me down to the bottom" symptom.
///
/// - Parameters:
///   - nearBottom: recomputed from the scroll view at apply time.
///   - isUserInteracting: `isTracking || isDragging || isDecelerating`. A user
///     mid-drag is never yanked, even if they are technically near the bottom.
///   - isInitial: the first non-empty snapshot. Always tails — a freshly
///     opened conversation must show its newest turn.
///   - forceScroll: an explicit request (prompt submit, scroll-to-bottom
///     button, post-reconnect reload). Overrides position, but the caller
///     still owns the decision to set it.
///   - isHistoryPrepend: this apply only added rows ABOVE the existing ones
///     (background history backfill). The viewport must stay where it is
///     relative to the BOTTOM, because the operator has not navigated — rows
///     appeared behind them.
func shouldAutoTail(
    nearBottom: Bool,
    isUserInteracting: Bool,
    isInitial: Bool,
    forceScroll: Bool,
    isHistoryPrepend: Bool = false
) -> Bool {
    // A pure history prepend must not be treated as "the user scrolled up".
    //
    // THE BUG THIS FIXES: opening a conversation applied the small first page
    // (isInitial, tails to the bottom — correct), then backfill prepended
    // ~2000 rows above it. That apply is not initial and no longer reads as
    // near-bottom, so the anchor path held the row that had been at the top —
    // which, after the prepend, sits in the MIDDLE of the transcript. The
    // conversation opened halfway down.
    //
    // Tailing through the prepend keeps the newest turn on screen, which is
    // where a freshly opened conversation belongs and where the operator
    // already was.
    if isHistoryPrepend && nearBottom { return true }
    // An explicit request wins over position, but never over nothing: both of
    // these are set by a deliberate caller action, not inferred.
    if isInitial || forceScroll { return true }
    // Scrolled back through history: hold still. This is the freeze the user
    // asked for — new rows still append below, they just don't move the view.
    guard nearBottom else { return false }
    // Near the bottom but actively dragging/decelerating: let the gesture
    // finish rather than fighting it.
    return !isUserInteracting
}

/// Result of diffing content hashes across two applies.
struct ReconfigurePlan {
    /// Ids whose content changed and whose cell must be rebuilt. Excludes
    /// brand-new ids (those are inserts — the data source builds their cell
    /// from scratch, and asking to reconfigure an id that is not yet in the
    /// old snapshot is both redundant and, for UIKit, an error).
    let changedIds: Set<String>
    /// The hash map to carry into the next apply.
    let nextHashes: [String: Int]
}

/// Decide which rows need their hosting configuration rebuilt.
///
/// The previous implementation reconfigured EVERY item already present in the
/// data source on EVERY apply. Each reconfigure rebuilds that row's
/// `UIHostingConfiguration`, and because the collection view runs with
/// `selfSizingInvalidation = .enabledIncludingConstraints`, every rebuilt cell
/// re-measures. Re-measuring rows *above* the viewport changes `contentSize`
/// and shifts what the user is reading (the "sometimes it's a line" symptom),
/// and the rebuild itself is the visible flash. During streaming exactly one
/// row's content changes, so nearly all of that work was both wasted and
/// disruptive.
///
/// This mirrors the desktop's `groupedItemsEqual` memo comparator
/// (`desktop/src/renderer/components/conversation/TranscriptRows.tsx`), which
/// solves the same problem for React rows. iOS needs a hash rather than
/// reference equality because `GroupedItem` is a value-type enum rebuilt on
/// every grouping pass — there is no stable object identity to compare.
///
/// - Parameters:
///   - previousHashes: the map returned by the previous call (empty on first).
///   - current: `(id, contentHash)` for every item in the incoming snapshot,
///     in snapshot order.
func itemsNeedingReconfigure(
    previousHashes: [String: Int],
    current: [(id: String, contentHash: Int)]
) -> ReconfigurePlan {
    var changed: Set<String> = []
    var next: [String: Int] = [:]
    next.reserveCapacity(current.count)
    for item in current {
        next[item.id] = item.contentHash
        guard let old = previousHashes[item.id] else {
            // New id: an insert, not a reconfigure. Its hash is still recorded
            // so the NEXT apply can detect a change against it.
            continue
        }
        if old != item.contentHash {
            changed.insert(item.id)
        }
    }
    return ReconfigurePlan(changedIds: changed, nextHashes: next)
}

/// The `contentOffset.y` that keeps an anchor row visually stationary.
///
/// `NSDiffableDataSourceSnapshot` apply preserves `contentOffset`, not the
/// reading position. So when rows are inserted ABOVE the viewport — an older
/// history page prepended by scroll-up pagination, or a first-page/heal replace
/// whose merge changes identity above the viewport — everything the user is
/// reading slides down by the height of the inserted content while the offset
/// stays put. That is the "sometimes it's a page" symptom, and the page height
/// matches the wire page size the desktop serves.
///
/// The fix is to measure one real row rather than estimate: capture the topmost
/// visible item's top edge relative to the current offset before the apply,
/// then after the apply compute where that same row's top edge landed and shift
/// the offset by the difference. Because the anchor is a concrete row, this is
/// exact for any above-viewport change — insertion, removal, or height
/// correction — instead of approximating from counts or timestamps.
///
/// - Parameters:
///   - previousAnchorTop: anchor frame `minY` minus `contentOffset.y`, before apply.
///   - newAnchorTop: the same anchor's frame `minY`, after apply and layout.
///   - minOffset: usually `-adjustedContentInset.top`.
///   - maxOffset: usually `contentSize.height - bounds.height + adjustedContentInset.bottom`,
///     floored at `minOffset` by the caller.
/// - Returns: the clamped offset to apply.
func anchoredOffset(
    previousAnchorTop: CGFloat,
    newAnchorTop: CGFloat,
    minOffset: CGFloat,
    maxOffset: CGFloat
) -> CGFloat {
    // Solve for the offset that puts the anchor back at the same screen
    // position: newAnchorTop - offset == previousAnchorTop.
    let target = newAnchorTop - previousAnchorTop
    // A degenerate content size (maxOffset below minOffset) would otherwise
    // invert the clamp and return a nonsense offset.
    guard maxOffset > minOffset else { return minOffset }
    return min(max(target, minOffset), maxOffset)
}

// MARK: - Tail pinning

/// The `contentOffset.y` that places the viewport at the very bottom.
///
/// One definition, used by every caller that needs the bottom. It was written
/// out inline in four places, which is three chances for one of them to drift
/// away from the others.
///
/// Floors at `-topInset` so content shorter than the viewport resolves to the
/// top rather than to a negative-scroll position past it.
func bottomContentOffset(
    contentHeight: CGFloat,
    viewportHeight: CGFloat,
    topInset: CGFloat,
    bottomInset: CGFloat
) -> CGFloat {
    max(contentHeight - viewportHeight + bottomInset, -topInset)
}

/// The offset a layout pass must apply to keep the viewport at the bottom, or
/// `nil` when it must leave the offset alone.
///
/// ── Why this is decided per layout pass rather than per apply ───────────────
/// A transcript's real height is not known when its rows are applied. Rows
/// self-size, and a row's content can keep growing long after that: markdown
/// re-renders, code highlights, and remote images all resolve asynchronously,
/// and each one grows its row — which pushes the bottom further down while the
/// viewport stays where it was.
///
/// THE BUG THIS FIXES: the previous implementation pinned the bottom from a
/// timed loop that stopped after a few quiet main-queue turns. On a freshly
/// opened conversation it reported "settled at bottom" ~100ms after the apply —
/// correctly, for the height the layout knew at that instant — and then let go.
/// Every later growth moved the bottom away with nothing watching, so the
/// conversation opened part-way up and the operator had to press
/// scroll-to-bottom. Opening the same conversation a second time looked fine,
/// because the asynchronous content was cached and measured on the first pass.
///
/// Holding the tail for as long as the operator has not taken the scroll over
/// removes the guess entirely: there is no window to expire, and no assumption
/// about how long measurement takes.
///
/// - Parameters:
///   - tailIntent: the viewport belongs to the tail — nothing has claimed it
///     since (no drag, no jump).
///   - isUserInteracting: `isTracking || isDragging || isDecelerating`. Their
///     gesture always wins over a pin they did not ask for.
///   - contentOffsetY: the current offset.
/// - Returns: the offset to set, or `nil` when there is nothing to correct.
func tailCorrection(
    tailIntent: Bool,
    isUserInteracting: Bool,
    contentOffsetY: CGFloat,
    contentHeight: CGFloat,
    viewportHeight: CGFloat,
    topInset: CGFloat,
    bottomInset: CGFloat
) -> CGFloat? {
    guard tailIntent, !isUserInteracting else { return nil }
    let bottom = bottomContentOffset(
        contentHeight: contentHeight,
        viewportHeight: viewportHeight,
        topInset: topInset,
        bottomInset: bottomInset
    )
    // Sub-point differences are rounding, not drift. Correcting them would
    // write contentOffset on every layout pass forever.
    guard abs(bottom - contentOffsetY) > 0.5 else { return nil }
    return bottom
}
