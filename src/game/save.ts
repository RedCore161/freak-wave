// v2: city-based rules and a new skill tree; v1 progress does not carry over.
const KEY = 'freakwave.save.v2';

export interface SaveData {
  chaos: number;
  skills: string[];
  bestLevel: number;
  /** Highest sea index the player may pick. */
  unlocked: number;
  /** Sea indices cleared at least once. */
  cleared: number[];
}

const EMPTY: SaveData = { chaos: 0, skills: [], bestLevel: 0, unlocked: 0, cleared: [] };

// Meta-progression lives in browser storage; it may be unavailable (private
// mode, blocked storage), in which case the game still works for the session.
export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, skills: [], cleared: [] };
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    return {
      chaos: typeof parsed.chaos === 'number' ? parsed.chaos : 0,
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      bestLevel: typeof parsed.bestLevel === 'number' ? parsed.bestLevel : 0,
      unlocked: typeof parsed.unlocked === 'number' ? parsed.unlocked : 0,
      cleared: Array.isArray(parsed.cleared) ? parsed.cleared : [],
    };
  } catch {
    return { ...EMPTY, skills: [], cleared: [] };
  }
}

export function writeSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable; progress lasts for this session only.
  }
}
