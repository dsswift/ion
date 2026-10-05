/** The server's one LinkRoutesBoard, bound to the live command registry. */
import { extensionCommandRegistry } from '../state'
import { LinkRoutesBoard } from './link-routes'

export const linkRoutesBoard = new LinkRoutesBoard({
  ownedCommands: (key) => extensionCommandRegistry.get(key),
})
