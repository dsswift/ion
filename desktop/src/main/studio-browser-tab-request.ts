let requestHandler: ((url: string) => void) | null = null

/** Install the main-process handler that asks Studio to open a browser tab. */
export function setStudioBrowserTabRequestHandler(handler: ((url: string) => void) | null): void {
  requestHandler = handler
}

/** Forward a guest link to Studio when its IPC handler is available. */
export function requestStudioBrowserTab(url: string): void {
  requestHandler?.(url)
}
