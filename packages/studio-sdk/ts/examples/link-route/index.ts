// link-route -- the smallest extension that registers a deep-link route.
//
// It registers one slash command with the engine SDK, then asks Studio, through
// the Studio SDK, to answer the link ion://ext/greet?args=<name> by running that
// command with the link's args. Copy this folder to ~/.ion/extensions/ to try
// it; the two imports resolve against the SDKs installed beside it.

import { createIon, log } from '../sdk/ion-sdk'
import { studio } from '../studio-sdk'

const ion = createIon()

ion.registerCommand('greet', {
  description: 'Greet someone by name',
  execute: async (args, ctx) => {
    ctx.sendMessage(`Hello, ${args.trim() || 'there'}.`)
  },
})

// Start-up registration: Studio receives this in the snapshot it asks for when
// it connects. A running extension would call links.addRoute() instead, which
// also pushes the change to every open Studio immediately.
studio(ion).links.register([
  { id: 'greet', label: 'Greet someone', command: '/greet' },
])
log.info('link-route: route registered')
