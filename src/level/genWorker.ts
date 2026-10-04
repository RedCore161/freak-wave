/// <reference lib="webworker" />
import { generateLevel } from './generator.ts';
import type { LevelRequest } from './types.ts';

// Level generation runs several headless simulations, so it lives off the
// main thread. Requests are answered in order, tagged with their id.
self.onmessage = (e: MessageEvent<{ id: number; req: LevelRequest }>) => {
  const { id, req } = e.data;
  try {
    const level = generateLevel(req);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, level }, [level.land.buffer]);
  } catch (err) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) });
  }
};
