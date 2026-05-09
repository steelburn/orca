// Why: tests run in a Node environment whose globalThis.crypto may lack
// randomUUID, and embedded Electron preloads on older Node builds can also
// be missing it. Fall back to a v4-style polyfill so PaneManager always
// produces a valid stablePaneId — the v4 UUID guard at IPC ingress keys off
// the 8-4-4-4-12 hex shape, not a runtime check on crypto.randomUUID.
export function mintStablePaneId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
