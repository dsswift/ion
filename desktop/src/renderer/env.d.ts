/// <reference types="vite/client" />
import type { IonAPI } from '../preload/index'

import 'react'

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}

declare module '*.mp3' {
  const src: string
  export default src
}

declare global {
  interface Window {
    ion: IonAPI
  }
}
