// Returns true at most once per key per window, for events a client can trigger on every request.
export function createLogThrottle(windowMs: number, maxKeys = 10_000): (key: string) => boolean {
  const lastLogged = new Map<string, number>();
  return (key) => {
    const now = Date.now();
    if (now - (lastLogged.get(key) ?? 0) < windowMs) return false;
    if (lastLogged.size > maxKeys) {
      for (const [k, t] of lastLogged) if (now - t >= windowMs) lastLogged.delete(k);
    }
    lastLogged.set(key, now);
    return true;
  };
}
