/**
 * What an image attachment is prepared to before the model sees it. One place,
 * so the server's encoder (`server/src/remote/attachment-encoder.ts`) and a
 * browser that shrinks a photo before uploading it aim at the same numbers.
 */

/**
 * The longest edge worth sending. The model resamples anything wider than
 * this, so pixels past it are paid for and never seen.
 */
export const ATTACHMENT_IMAGE_MAX_DIM = 1568

/**
 * The encoded size an image is recompressed to. About what the iOS app
 * compresses to before upload; far under the model's per-image input cap and
 * the engine's line cap.
 */
export const ATTACHMENT_IMAGE_TARGET_BYTES = 1_000_000
