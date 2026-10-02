import "server-only";

// Route handlers can be bundled separately, so the counters live on globalThis to be shared.
interface Store {
  active: { chat: number; image: number };
  lastTokensPerSec: number | null;
}
const g = globalThis as unknown as { __mangoActivity?: Store };
const store = (g.__mangoActivity ??= { active: { chat: 0, image: 0 }, lastTokensPerSec: null });

/** Mark a generation as running; call the returned function when it finishes. */
export function beginActivity(kind: "chat" | "image"): () => void {
  store.active[kind]++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    store.active[kind] = Math.max(0, store.active[kind] - 1);
  };
}

export const setTokensPerSec = (v: number) => {
  store.lastTokensPerSec = v;
};
export const activitySnapshot = () => ({ ...store.active, lastTokensPerSec: store.lastTokensPerSec });
