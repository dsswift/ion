declare module '*.mp3' {
  const src: string
  export default src
}

// Electron <webview> tag (Studio browser surface only; the tag is enabled
// solely on the Studio window and hardened by main/webview-policy.ts).
declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string
        partition?: string
        allowpopups?: string
      },
      HTMLElement
    >
  }
}
