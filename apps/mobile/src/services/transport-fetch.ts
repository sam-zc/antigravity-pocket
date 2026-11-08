export const transportFetch: typeof fetch = (...args) =>
  globalThis.fetch(...args);
