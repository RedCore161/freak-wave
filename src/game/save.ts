import type { SkillId } from './skills.ts';

const KEY = 'freakwave.save.v1';

export interface SaveData {
  chaos: number;
  skills: SkillId[];
  bestLevel: number;
}

const EMPTY: SaveData = { chaos: 0, skills: [], bestLevel: 0 };

// Meta-progression lives in browser storage; it may be unavailable (private
// mode, blocked storage), in which case the game still works for the session.
export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, skills: [] };
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    return {
      chaos: typeof parsed.chaos === 'number' ? parsed.chaos : 0,
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      bestLevel: typeof parsed.bestLevel === 'number' ? parsed.bestLevel : 0,
    };
  } catch {
    return { ...EMPTY, skills: [] };
  }
}

export function writeSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable; progress lasts for this session only.
  }
}
