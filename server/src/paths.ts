/**
 * The server's view of the data root. The resolver itself lives in
 * `@ion/shared/data-dir`, because the shipping stack beside it runs in this
 * process AND in Electron's main process and must resolve the same directory
 * in both. Re-exported here so every `./paths` call site in this package is
 * unchanged.
 */
export { dataDir, dataDirSource } from '@ion/shared/data-dir'
