/**
 * pairing-qr — a pairing link drawn as a QR code the phone's camera reads.
 *
 * The link is a bearer secret, so it is encoded here in the renderer and
 * never leaves the process to be drawn. The result is an SVG data URL: it
 * scales to any size without blurring and needs no canvas.
 */
import qrcode from 'qrcode-generator'

/** Quiet-zone width in modules. The QR specification asks for four. */
const QUIET_ZONE_MODULES = 4

/** The `text` as a QR code, as an `image/svg+xml` data URL. Error correction M: a pairing link is read off a clean screen, not a scuffed label. */
export function qrSvgDataUrl(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const svg = qr.createSvgTag({ cellSize: 4, margin: QUIET_ZONE_MODULES * 4, scalable: true })
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
