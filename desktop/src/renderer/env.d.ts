import type { IonAPI } from '../preload/index'

declare module '*.mp3' {
  const src: string
  export default src
}

declare global {
  interface Window {
    ion: IonAPI
  }
}
