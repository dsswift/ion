import { TerminalManager } from './terminal-manager'
import { broadcast } from './broadcast'

export const terminalManager = new TerminalManager(broadcast)
