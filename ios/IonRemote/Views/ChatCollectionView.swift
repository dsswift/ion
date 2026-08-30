import SwiftUI
import UIKit

// MARK: - ChatItem

/// Identity wrapper for diffable data source. Hashes by `id` only so the
/// data source tracks item identity, not content — folding content into
/// identity would make every streamed chunk read as delete+insert and destroy
/// the scroll position.
///
/// Content changes ride `contentHash` instead: `ChatCollectionVC` diffs it
/// against the previous apply and reconfigures only the rows that actually
/// moved. It is excluded from `==`/`hash(into:)` for the reason above, so two
/// items with the same id are "the same row" to UIKit no matter their content.
struct ChatItem<Payload>: Hashable {
    let id: String
    /// Hash of every field the row renders. NOT part of identity.
    let contentHash: Int
    let payload: Payload

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

// MARK: - ChatCollectionView

/// A UICollectionView wrapper optimized for chat-style scrolling.
///
/// Replaces `LazyVStack` + `ScrollView` + `ScrollViewReader` + KVO hacks
/// with a single UIKit component that:
/// - Tracks `isNearBottom` via `UIScrollViewDelegate` (no KVO, no superview walking)
/// - Scrolls to bottom reliably (no estimated-height overshoot)
/// - Auto-tails during streaming ONLY when the user is at the bottom
/// - Holds the user's reading position steady when they are scrolled back
/// - Uses `UIHostingConfiguration` to render SwiftUI row views
///
/// Scroll-position ownership: the VC is authoritative. `isNearBottom` is an
/// OUTPUT binding (it drives the host's scroll-to-bottom button) and is never
/// read back to decide whether to tail — see `shouldAutoTail`.
struct ChatCollectionView<Payload, RowContent: View>: UIViewControllerRepresentable {
    let items: [ChatItem<Payload>]
    /// Output-only: the VC publishes its live near-bottom state here for the
    /// host's scroll-to-bottom button. Writing to it does NOT request a scroll
    /// (use `forceScrollCounter` for that).
    @Binding var isNearBottom: Bool
    /// Monotonically increasing counter. Incrementing forces a scroll-to-bottom
    /// regardless of `isNearBottom` (used by the STB button and submit actions).
    var forceScrollCounter: Int = 0
    /// A jump request: the row id to scroll to, paired with a monotonically
    /// increasing tick. The tick is what makes a repeat jump to the SAME row
    /// fire again — an id alone would compare equal and be ignored, so tapping
    /// the same chart twice would do nothing the second time.
    var jumpRequest: (id: String, chartId: String?, tick: Int)?
    let spacing: CGFloat
    let horizontalInset: CGFloat
    /// RC-15: fired when the user scrolls within a threshold of the TOP, so the
    /// host can page in older history (loadMoreMessages). Debounced in the VC to
    /// one fire per top-approach; the ViewModel additionally guards on hasMore +
    /// an in-flight load, so a burst of scroll events coalesces to one request.
    var onReachedTop: (() -> Void)?
    let rowContent: (Payload) -> RowContent

    func makeUIViewController(context: Context) -> ChatCollectionVC<Payload, RowContent> {
        let vc = ChatCollectionVC<Payload, RowContent>(
            rowContent: rowContent,
            spacing: spacing,
            horizontalInset: horizontalInset
        )
        vc.onNearBottomChanged = { [self] near in
            if isNearBottom != near {
                DispatchQueue.main.async { isNearBottom = near }
            }
        }
        vc.onReachedTop = onReachedTop
        context.coordinator.lastForceScroll = forceScrollCounter
        context.coordinator.lastJumpTick = jumpRequest?.tick ?? 0
        return vc
    }

    func updateUIViewController(
        _ vc: ChatCollectionVC<Payload, RowContent>,
        context: Context
    ) {
        vc.rowContent = rowContent
        // Keep the callback fresh (it captures the current host closure).
        vc.onReachedTop = onReachedTop

        let forceScroll = forceScrollCounter != context.coordinator.lastForceScroll
        context.coordinator.lastForceScroll = forceScrollCounter

        // isNearBottom is deliberately NOT passed: the VC decides tailing from
        // its own live geometry, because this binding's value is one async hop
        // stale and would re-open the yank-to-bottom window.
        vc.applySnapshot(items: items, forceScroll: forceScroll)

        // Jump AFTER the snapshot apply: the target row may have arrived in
        // this very update (a backfilled page), so resolving it beforehand
        // would miss.
        if let request = jumpRequest, request.tick != context.coordinator.lastJumpTick {
            context.coordinator.lastJumpTick = request.tick
            // The apply above may have tailed and queued a settle loop; the
            // jump bumps the scroll generation, which invalidates it. Without
            // that, dismissing the attachments sheet re-ran this method,
            // tailed to the bottom, and the queued pin undid the jump on the
            // next main-queue turn — the scroll happened and nothing moved.
            // Non-animated: the convergence loop re-places the row as the
            // layout measures, and an in-flight animation would be chasing an
            // offset that is already stale.
            let landed = vc.scrollToRow(id: request.id, chartId: request.chartId, animated: false)
            DiagnosticLog.log(
                landed ? "transcript jump landed" : "transcript jump target not local",
                tag: "view.transcript",
                level: landed ? .info : .warn,
                fields: ["row_id": String(request.id.prefix(12))]
            )
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var lastForceScroll = 0
        var lastJumpTick = 0
    }
}

// MARK: - Section

private enum ChatSection: Hashable { case main }

// MARK: - ChatCollectionVC

final class ChatCollectionVC<Payload, RowContent: View>:
    UIViewController, UICollectionViewDelegate, UIScrollViewDelegate
{
    var rowContent: (Payload) -> RowContent

    /// Internal rather than private: scroll positioning lives in
    /// ChatCollectionScrolling (extracted for the file-size cap) and operates
    /// directly on this view's geometry.
    var collectionView: UICollectionView!
    /// Bumped whenever a deliberate navigation claims the viewport. A queued
    /// tail-pin carries the generation it started under and exits when this no
    /// longer matches, so a scroll-to-bottom scheduled by an apply cannot undo
    /// a jump issued moments later in the same update pass.
    var scrollGeneration: UInt64 = 0
    private var dataSource: UICollectionViewDiffableDataSource<ChatSection, ChatItem<Payload>>!
    private var nearBottom = true
    var onNearBottomChanged: ((Bool) -> Void)?
    /// RC-15: fired when the user scrolls near the top (older-history prefetch).
    var onReachedTop: (() -> Void)?
    /// Debounce so one top-approach fires once: set true when we cross into the
    /// top zone, reset when we leave it. Prevents a scroll burst near the top
    /// from firing loadMoreMessages on every delegate callback.
    private var topZoneLatched = false

    private var pendingSnapshot: (items: [ChatItem<Payload>], forceScroll: Bool)?
    private var hasAppliedInitialSnapshot = false
    private let spacing: CGFloat
    private let horizontalInset: CGFloat

    /// Content hash of each item as of the last apply, keyed by item id. Diffed
    /// on every apply so only genuinely-changed rows are reconfigured. Empty
    /// before the first apply, which is why the first apply reconfigures
    /// nothing (every id is an insert).
    private var appliedContentHashes: [String: Int] = [:]

    /// Live user-interaction state read directly from the scroll view.
    ///
    /// Replaces a hand-tracked `userIsInteracting` flag that was set in
    /// `scrollViewWillBeginDragging` and cleared in `scrollViewDidEndDragging`
    /// / `scrollViewDidEndDecelerating`. That flag could stick `true` forever:
    /// if the user flicked to the bottom (ending the drag with
    /// `willDecelerate=true`) and a non-animated programmatic scroll from a
    /// snapshot apply interrupted the deceleration,
    /// `scrollViewDidEndDecelerating` never fired — permanently disabling
    /// auto-tail. UIKit's own properties cannot drift: during programmatic
    /// non-animated scrolls all three are `false`, so the "don't flip
    /// near→far on content growth" guard still holds.
    private var isUserInteracting: Bool {
        guard let cv = collectionView else { return false }
        return cv.isTracking || cv.isDragging || cv.isDecelerating
    }

    init(
        rowContent: @escaping (Payload) -> RowContent,
        spacing: CGFloat,
        horizontalInset: CGFloat
    ) {
        self.rowContent = rowContent
        self.spacing = spacing
        self.horizontalInset = horizontalInset
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()

        let layout = makeLayout()
        collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: layout)
        collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        collectionView.backgroundColor = .clear
        collectionView.delegate = self
        collectionView.keyboardDismissMode = .interactive
        collectionView.contentInsetAdjustmentBehavior = .always
        collectionView.clipsToBounds = true
        // Hosted SwiftUI cells whose content grows internally (streaming
        // text, markdown re-render) proactively invalidate their size
        // instead of waiting for the next reconfigure pass. Without this,
        // a reconfigured cell keeps its stale height until something else
        // forces a layout pass (e.g. the user scrolling).
        collectionView.selfSizingInvalidation = .enabledIncludingConstraints
        view.addSubview(collectionView)

        let reg = UICollectionView.CellRegistration<UICollectionViewCell, ChatItem<Payload>> {
            [weak self] cell, _, wrapper in
            guard let self else { return }
            cell.contentConfiguration = UIHostingConfiguration {
                self.rowContent(wrapper.payload)
            }
            .margins(.all, 0)
        }

        dataSource = UICollectionViewDiffableDataSource(
            collectionView: collectionView
        ) { cv, indexPath, item in
            cv.dequeueConfiguredReusableCell(using: reg, for: indexPath, item: item)
        }

        if let pending = pendingSnapshot {
            pendingSnapshot = nil
            applySnapshot(items: pending.items, forceScroll: pending.forceScroll)
        }
    }

    private func makeLayout() -> UICollectionViewCompositionalLayout {
        let itemSize = NSCollectionLayoutSize(
            widthDimension: .fractionalWidth(1),
            heightDimension: .estimated(44)
        )
        let item = NSCollectionLayoutItem(layoutSize: itemSize)
        let group = NSCollectionLayoutGroup.vertical(layoutSize: itemSize, subitems: [item])
        let section = NSCollectionLayoutSection(group: group)
        section.interGroupSpacing = spacing
        section.contentInsets = NSDirectionalEdgeInsets(
            top: 8, leading: horizontalInset,
            bottom: 8, trailing: horizontalInset
        )
        return UICollectionViewCompositionalLayout(section: section)
    }

    // MARK: - Snapshot

    func applySnapshot(
        items: [ChatItem<Payload>],
        forceScroll: Bool
    ) {
        guard dataSource != nil else {
            pendingSnapshot = (items, forceScroll)
            return
        }

        let isInitial = !hasAppliedInitialSnapshot && !items.isEmpty
        if isInitial { hasAppliedInitialSnapshot = true }

        // UIKit requires unique identifiers — deduplicate, keeping last occurrence.
        var seen = Set<String>()
        var uniqueItems: [ChatItem<Payload>] = []
        for item in items.reversed() {
            if seen.insert(item.id).inserted {
                uniqueItems.append(item)
            }
        }
        uniqueItems.reverse()

        // A PURE PREPEND: every row the data source already held is still
        // present, in order, at the END of the incoming list. That is exactly
        // what background history backfill produces — older rows arriving
        // behind the operator — and it must not be mistaken for the operator
        // having scrolled up.
        let previousIds = dataSource.snapshot().itemIdentifiers.map { $0.id }
        let isHistoryPrepend: Bool = {
            guard !previousIds.isEmpty, uniqueItems.count > previousIds.count else { return false }
            let tail = uniqueItems.suffix(previousIds.count).map { $0.id }
            return tail == previousIds
        }()

        // A LARGE insert is what needs post-apply settling: enough new rows
        // that self-sizing resolves them across many frames rather than one.
        // The threshold is deliberately low — the settle loop is a no-op when
        // the size is already stable, so over-triggering is cheap and
        // under-triggering is the visible bug.
        let insertedCount = uniqueItems.count - previousIds.count
        let isLargeInsert = insertedCount >= 50

        // Decide tailing from LIVE geometry, before the apply changes it. The
        // previous implementation read the round-tripped `isNearBottom` binding,
        // which lags one async hop behind the user's scroll: any apply landing
        // inside that window saw a stale `true` and yanked them to the bottom.
        let tailing = shouldAutoTail(
            nearBottom: computeNearBottom(),
            isUserInteracting: isUserInteracting,
            isInitial: isInitial,
            forceScroll: forceScroll,
            isHistoryPrepend: isHistoryPrepend
        )

        // Capture the reading position BEFORE the apply. Only meaningful when
        // we are not about to scroll to the bottom anyway.
        let anchor = tailing ? nil : captureAnchor()

        var snapshot = NSDiffableDataSourceSnapshot<ChatSection, ChatItem<Payload>>()
        snapshot.appendSections([.main])
        snapshot.appendItems(uniqueItems, toSection: .main)

        // Reconfigure ONLY rows whose rendered content changed. Reconfiguring
        // everything (the previous behavior) rebuilt every visible row's
        // UIHostingConfiguration on every apply; with
        // selfSizingInvalidation = .enabledIncludingConstraints that re-measures
        // each one, and a re-measure above the viewport shifts what the user is
        // reading. During streaming exactly one row changes.
        let plan = itemsNeedingReconfigure(
            previousHashes: appliedContentHashes,
            current: uniqueItems.map { (id: $0.id, contentHash: $0.contentHash) }
        )
        appliedContentHashes = plan.nextHashes
        if !plan.changedIds.isEmpty {
            // Reconfigure requests must reference items present in the CURRENT
            // data source; a changed id that is somehow absent would trap.
            let existing = Set(dataSource.snapshot().itemIdentifiers.map { $0.id })
            let toReconfigure = uniqueItems.filter {
                plan.changedIds.contains($0.id) && existing.contains($0.id)
            }
            if !toReconfigure.isEmpty {
                snapshot.reconfigureItems(toReconfigure)
            }
        }
        DiagnosticLog.trace("chat scroll apply", tag: "view.chatscroll", fields: [
            "count": String(uniqueItems.count),
            "max": String(plan.changedIds.count),
            "status": String(tailing),
            "reason": anchor == nil ? "no-anchor" : "anchored",
            "prepend": String(isHistoryPrepend)
        ])

        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            guard let self else { return }
            if tailing {
                self.scrollToBottom(animated: false)
                // A LARGE insert measures over many frames, so the two-pass
                // convergence in scrollToBottom is not enough on its own: each
                // self-sizing resolution grows contentSize beneath the viewport
                // and drags it off the bottom after the apply has "finished".
                //
                // This fires on the initial load (which now carries the whole
                // conversation) and on any bulk prepend. A small streaming
                // apply skips it — the guard below exits on the first frame
                // when the size is already stable, so the cost is one frame.
                if isLargeInsert {
                    DiagnosticLog.log("chat scroll holding bottom", tag: "view.chatscroll", fields: [
                        "inserted": String(insertedCount),
                        "total": String(uniqueItems.count),
                        "initial": String(isInitial)
                    ])
                    self.holdBottomWhileSettling()
                }
            } else if let anchor {
                self.restoreAnchor(anchor)
            } else {
                // Not tailing and nothing to anchor on (empty transcript, or no
                // visible row yet). Logged rather than silently doing nothing so
                // an unexplained jump is diagnosable.
                DiagnosticLog.trace("chat scroll hold no anchor", tag: "view.chatscroll", fields: [
                    "reason": String(self.collectionView.isTracking),
                    "status": String(self.collectionView.isDragging),
                    "count": String(self.collectionView.isDecelerating)
                ])
            }
        }
    }

    // MARK: - Reading-position anchor

    /// The row the user is reading, plus where its top edge sits on screen.
    private struct ScrollAnchor {
        let id: String
        /// Frame `minY` minus `contentOffset.y` — i.e. the row's top edge in
        /// viewport coordinates, which is what must stay constant.
        let topInViewport: CGFloat
    }

    /// Record the topmost visible row and its on-screen top edge.
    ///
    /// Uses a real row rather than an estimate: a diffable apply preserves
    /// `contentOffset`, not the reading position, so any insertion or height
    /// correction ABOVE the viewport slides the user's content. Measuring one
    /// concrete row makes the correction exact for all of those cases.
    private func captureAnchor() -> ScrollAnchor? {
        guard let cv = collectionView else { return nil }
        let offset = cv.contentOffset.y
        // indexPathsForVisibleItems is unordered; take the topmost.
        let visible = cv.indexPathsForVisibleItems.sorted()
        for indexPath in visible {
            guard let item = dataSource.itemIdentifier(for: indexPath),
                  let frame = cv.layoutAttributesForItem(at: indexPath)?.frame else { continue }
            return ScrollAnchor(id: item.id, topInViewport: frame.minY - offset)
        }
        return nil
    }

    /// Put the anchor row back where it was, shifting `contentOffset` by however
    /// far the row moved during the apply.
    private func restoreAnchor(_ anchor: ScrollAnchor) {
        guard let cv = collectionView else { return }
        // Resolve pending self-sizing so the anchor's post-apply frame is real
        // and not a stale estimate.
        cv.layoutIfNeeded()
        guard let indexPath = currentIndexPath(forItemId: anchor.id),
              let frame = cv.layoutAttributesForItem(at: indexPath)?.frame else {
            // The anchor row is gone from this snapshot (e.g. a heal replaced
            // it). Leaving the offset untouched is the least-wrong option:
            // there is no row left to hold steady.
            DiagnosticLog.trace("chat scroll anchor row missing", tag: "view.chatscroll", fields: [
                "reason": String(anchor.id.prefix(16))
            ])
            return
        }
        let minOffset = -cv.adjustedContentInset.top
        let maxOffset = max(
            cv.contentSize.height - cv.bounds.height + cv.adjustedContentInset.bottom,
            minOffset
        )
        let target = anchoredOffset(
            previousAnchorTop: anchor.topInViewport,
            newAnchorTop: frame.minY,
            minOffset: minOffset,
            maxOffset: maxOffset
        )
        let delta = target - cv.contentOffset.y
        guard abs(delta) > 0.5 else { return }
        DiagnosticLog.trace("chat scroll anchor restored", tag: "view.chatscroll", fields: [
            "reason": String(anchor.id.prefix(16)),
            "count": String(format: "%.1f", delta),
            "status": String(format: "%.1f", target)
        ])
        cv.setContentOffset(CGPoint(x: 0, y: target), animated: false)
    }

    /// Index path of an item id in the CURRENT data source, or nil if the id is
    /// no longer present.
    ///
    /// Internal rather than private: the scroll positioning lives in
    /// ChatCollectionScrolling (extracted for the file-size cap) and resolves
    /// every target through this one lookup, so both files agree on what "this
    /// row" means.
    func currentIndexPath(forItemId id: String) -> IndexPath? {
        let identifiers = dataSource.snapshot().itemIdentifiers
        guard let idx = identifiers.firstIndex(where: { $0.id == id }) else { return nil }
        return IndexPath(item: idx, section: 0)
    }

    // MARK: - UIScrollViewDelegate

    /// Distance-to-bottom test, read from live scroll-view geometry.
    ///
    /// This is the authoritative tail input (see `shouldAutoTail`). Returns
    /// `true` before the view exists so the very first populate still tails.
    private func computeNearBottom() -> Bool {
        guard let cv = collectionView else { return true }
        let distance = cv.contentSize.height - cv.contentOffset.y
            - cv.bounds.height + cv.adjustedContentInset.bottom
        return distance < 100
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let near = computeNearBottom()

        // Only flip near→far when the user is actively scrolling.
        // Content growth (streaming) pushes the bottom further away,
        // but the user hasn't scrolled — keep them pinned.
        if nearBottom && !near && !isUserInteracting { return }

        if nearBottom != near {
            nearBottom = near
            onNearBottomChanged?(near)
        }

        // RC-15: older-history prefetch. When the user scrolls within a threshold
        // of the TOP, fire onReachedTop once per approach (latched until they
        // leave the top zone). The host's loadMoreMessages guards on hasMore + an
        // in-flight load, so repeated fires during a load are safe no-ops; the
        // latch just avoids spamming the guard. Only fires under active user
        // interaction so a programmatic scroll (snapshot apply) can't trigger it.
        let topDistance = scrollView.contentOffset.y + scrollView.adjustedContentInset.top
        let inTopZone = topDistance < 200
        if inTopZone {
            if !topZoneLatched && isUserInteracting {
                topZoneLatched = true
                onReachedTop?()
            }
        } else {
            topZoneLatched = false
        }
    }
}
