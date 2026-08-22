// ── Vitest setup ──────────────────────────────────────────────────────
// `webextension-polyfill` throws at import time unless it can see an extension
// runtime, and unplugin-auto-import puts a top-level import of it into every
// module that touches `browser` — including `~/shared/config`. Any test that
// imports the config defaults would therefore fail before running a single
// assertion.
//
// A minimal stub satisfies the polyfill's guard. It is deliberately not a
// working mock: tests here cover pure logic, so anything that actually calls
// into `browser.*` should fail loudly rather than silently no-op.

const notImplemented = (name: string) => () => {
  throw new Error(`browser.${name} is not available in tests — this code path needs a real mock.`);
};

(globalThis as any).chrome = {
  runtime: { id: "szuruchrome-test" },
};

(globalThis as any).browser = {
  runtime: { id: "szuruchrome-test", sendMessage: notImplemented("runtime.sendMessage") },
  storage: {
    local: {
      get: notImplemented("storage.local.get"),
      set: notImplemented("storage.local.set"),
      remove: notImplemented("storage.local.remove"),
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
};
