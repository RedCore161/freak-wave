import type { AudioSettings } from '../audio/Sonifier.ts';

const KEY = 'freakwave.settings.v1';

export interface Settings extends AudioSettings {
  tutorialSeen: boolean;
}

export const DEFAULT_SETTINGS: Settings = { master: 0.8, ambience: 0.7, effects: 0.9, muted: false, tutorialSeen: false };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable; settings last for this session.
  }
}
