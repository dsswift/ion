/**
 * `node dist/compat.js` — print this server build's Format Versions as JSON.
 * Packaging writes its output to `compat.json` beside the bundle's `VERSION`,
 * so an installed build reports its formats while stopped, and a fresh build
 * can be compared with a fleet before it is deployed. Boots nothing.
 */
import { serverFormats } from '../compat/registry'

process.stdout.write(JSON.stringify({ formats: serverFormats() }, null, 2) + '\n')
