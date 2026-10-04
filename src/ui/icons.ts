// Placeholder skill and quake icons: tiny stroked SVG glyphs on a 24x24 grid.
// Swap the path data for real artwork later; ids stay the same.

const PATHS = {
  tremor: '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="6" stroke-dasharray="3 2"/>',
  quake: '<circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="9"/>',
  mega: '<path d="M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3.5 3.5M15.5 15.5 19 19M19 5l-3.5 3.5M8.5 15.5 5 19"/><circle cx="12" cy="12" r="2.5"/>',
  rift: '<path d="M4 20l4-5-2-2 5-5-2-2 6-3"/><path d="M15 9l4 2M10 14l4 2" opacity=".6"/>',
  pulse: '<path d="M3 12h2M7 8v8M11 6v12M15 8v8M19 10v4"/>',
  wave: '<path d="M2 15c3-5 5-5 8 0s5 5 8 0 3-4 4-3"/>',
  longwave: '<path d="M2 14c4-7 8-7 10 0s6 7 10 0"/>',
  deep: '<path d="M2 8c3-3 5-3 8 0s5 3 8 0 3-2 4-2"/><path d="M12 12v8M9 17l3 3 3-3"/>',
  train: '<path d="M2 7c3-3 5-3 8 0s5 3 8 0M2 12c3-3 5-3 8 0s5 3 8 0M2 17c3-3 5-3 8 0s5 3 8 0"/>',
  aftershock: '<circle cx="9" cy="12" r="4"/><circle cx="15" cy="12" r="6" stroke-dasharray="2 2"/>',
  harmonic: '<path d="M2 12c2.5-6 5-6 7.5 0s5 6 7.5 0 3-5 5-3"/><path d="M2 12c2.5 6 5 6 7.5 0s5-6 7.5 0 3 5 5 3" opacity=".6"/>',
  rings: '<circle cx="6" cy="18" r="2"/><path d="M6 11a7 7 0 0 1 7 7M6 6a12 12 0 0 1 12 12"/>',
  fuse: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M10 2h4"/>',
  fine: '<circle cx="12" cy="12" r="8"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M12 12l4-3"/>',
  eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  slow: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9"/>',
  combo: '<path d="M4 7l4 5-4 5M10 7l4 5-4 5M16 7l4 5-4 5"/>',
  ram: '<path d="M2 12h12M10 8l4 4-4 4"/><path d="M18 4v16M21 6v12"/>',
  wall: '<path d="M3 20V8h18v12zM3 14h18M9 8v6M15 14v6M12 4v4"/>',
  mirror: '<path d="M3 20L20 3"/><path d="M4 8l6 4-4 6" /><path d="M10 12l8 1"/>',
  domino: '<rect x="3" y="8" width="4" height="12" rx="1"/><rect x="9" y="6" width="4" height="12" rx="1" transform="rotate(20 11 12)"/><rect x="15" y="5" width="4" height="12" rx="1" transform="rotate(40 17 11)"/>',
  shield: '<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/>',
  chaos: '<path d="M12 12a2 2 0 1 1 2 2 4 4 0 1 1-4-4 6 6 0 1 1 6 6 8 8 0 1 1-8-8"/>',
  spawn: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  salvage: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6v2M12 16v2"/>',
  amp: '<ellipse cx="12" cy="16" rx="8" ry="3"/><path d="M12 13V3M8 7l4-4 4 4"/>',
  storm: '<path d="M13 2L5 13h6l-2 9 8-11h-6z"/>',
  city: '<path d="M3 21V11l5-3v13M8 21V5l6 3v13M14 21v-9l7 2v7M2 21h20"/>',
};

export type IconId = keyof typeof PATHS;

export function iconSvg(id: IconId, size = 22): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[id]}</svg>`
  );
}

export function iconEl(id: IconId, size = 22): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = iconSvg(id, size);
  return span;
}
