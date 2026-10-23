// Loaded before the board's own script: the replay stands in for the server, so the board renders recorded
// states exactly as it renders live ones. It never writes anything back.
window.EventSource = class {
  constructor() {
    this.listeners = {}
    window.__stream = this
  }
  addEventListener(kind, fn) {
    this.listeners[kind] = fn
  }
}
window.fetch = (url) => Promise.resolve(new Response(String(url).endsWith('/api/tools') ? '[]' : '{}', { status: 200 }))
