import type { CodaAPI } from '../preload/index'

declare module '*.mp3' {
  const src: string
  export default src
}

declare global {
  interface Window {
    coda: CodaAPI
  }
}
