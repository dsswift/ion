/**
 * Stacking layers for overlay conversation chrome.
 *
 * Queued attachment previews expand the composer upward. Their containing row
 * must remain above the conversation surface or cards exist in state but paint
 * behind transcript content. Studio uses flex flow, so these layers only apply
 * to the overlay host in App.tsx.
 */
export const OVERLAY_CONVERSATION_LAYER = 20
export const OVERLAY_COMPOSER_LAYER = 21
