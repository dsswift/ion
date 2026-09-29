// composer-action -- the smallest extension that extends Ion Studio.
//
// It registers one slash command with the engine SDK, then asks Studio, through
// the Studio SDK, to offer that command in the composer's + menu. Copy this
// folder to ~/.ion/extensions/ to try it; the two imports resolve against the
// SDKs installed beside it.

import { createIon, log } from '../sdk/ion-sdk'
import { studio } from '../studio-sdk'

const ion = createIon()

ion.registerCommand('hello-studio', {
  description: 'Say hello from an extension',
  execute: async (_args, ctx) => {
    ctx.sendMessage('Hello from the composer + menu.')
  },
})

// Start-up registration: Studio receives this in the snapshot it asks for when
// it connects. A running extension would call composer.addAction() instead,
// which also pushes the change to every open Studio immediately.
studio(ion).composer.register([
  { id: 'hello-studio', label: 'Say hello', icon: 'HandWaving', command: '/hello-studio' },
])
log.info('composer-action: action registered')
