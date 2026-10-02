import "server-only";

// Route handlers can be bundled separately, so the counters live on globalThis to be shared.
interface Store {
  active: { chat: number; image: number };
  lastTokensPerSec: number | null;
  perUser: Map<string, number>;
}
const g = globalThis as unknown as { __mangoActivity?: Store };
const store = (g.__mangoActivity ??= { active: { chat: 0, image: 0 }, lastTokensPerSec: null, perUser: new Map() });

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

/** Most generations (chat answers + images) one person may have running at once. */
export const MAX_PER_USER = Number(process.env.MAX_CONCURRENT_PER_USER ?? 2);

/**
 * Reserve one of the user's generation slots, or return null if they already use all of them.
 * The model serves a limited number of chats at once, so without a cap one person could queue a
 * pile of requests and make everyone else wait. Call the returned function when the generation ends.
 */
export function acquireUserSlot(userId: string): (() => void) | null {
  const n = store.perUser.get(userId) ?? 0;
  if (n >= MAX_PER_USER) return null;
  store.perUser.set(userId, n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = store.perUser.get(userId) ?? 1;
    if (cur <= 1) store.perUser.delete(userId);
    else store.perUser.set(userId, cur - 1);
  };
}
