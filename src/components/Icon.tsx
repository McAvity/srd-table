/**
 * Line icons drawn for this app (24×24, stroke 1.8, the text color), so buttons look the same on
 * every computer instead of relying on font glyphs. Decorative: the button's text or
 * `aria-label` names it.
 */

const PATHS = {
  // navigation
  table: '<path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"/><path d="M9 4v13M15 7v13"/>',
  sheet:
    '<path d="M12 3l7 3v5c0 5-3.2 8.3-7 10-3.8-1.7-7-5-7-10V6z"/><circle cx="12" cy="10" r="2.2"/><path d="M8.5 16c.8-1.8 2-2.6 3.5-2.6s2.7.8 3.5 2.6"/>',
  book: '<path d="M3 5.5C5.5 4.5 8.5 4.5 12 6.5c3.5-2 6.5-2 9-1v13c-2.5-1-5.5-1-9 1-3.5-2-6.5-2-9-1z"/><path d="M12 6.5v13"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  users:
    '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19c.8-3.4 3.1-5.2 6-5.2s5.2 1.8 6 5.2"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 6M17.5 14c1.8.6 3 2.3 3.5 5"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c1-4 3.9-6.2 7.5-6.2s6.5 2.2 7.5 6.2"/>',
  // commands
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v4h16v-4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/><path d="M10 11v5M14 11v5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  warning: '<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  // dice and rolls
  d20: '<path d="M12 2.5l8.5 5v9L12 21.5l-8.5-5v-9z"/><path d="M12 2.5L7 11h10zM3.5 7.5L7 11l-3.5 5.5M20.5 7.5L17 11l3.5 5.5M7 11l5 10.5L17 11"/>',
  d6: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.1"/><circle cx="15" cy="15" r="1.1"/><circle cx="12" cy="12" r="1.1"/>',
  advantage: '<path d="M7 14l5-5 5 5"/><path d="M7 19l5-5 5 5"/>',
  disadvantage: '<path d="M7 5l5 5 5-5"/><path d="M7 10l5 5 5-5"/>',
  // combat
  swords:
    '<path d="M4 4l9.5 9.5M4 4v3.5L13 16.5M4 4h3.5L16.5 13"/><path d="M20 4l-6 6M20 4v3.5l-2.5 2.5M20 4h-3.5l-2.5 2.5"/><path d="M12 16l-2 2M8 18l-2 2M16 12l2 2M18 16l2 2"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.8-3.2 8-7.5 9.5-4.3-1.5-7.5-4.7-7.5-9.5V6z"/>',
  heart:
    '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z"/>',
  flame:
    '<path d="M12 21c-3.6 0-6-2.4-6-5.7 0-3.6 3-5.3 3.6-9.3 2.3 1.3 3.5 3.3 3.5 5.4.9-.6 1.5-1.6 1.6-2.8 1.9 1.8 3.3 4 3.3 6.7 0 3.3-2.4 5.7-6 5.7z"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
  next: '<path d="M6 5l9 7-9 7z"/><path d="M18 5v14"/>',
  play: '<path d="M7 4.5l12 7.5-12 7.5z"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>',
  ruler:
    '<path d="M3 16.5L16.5 3 21 7.5 7.5 21z"/><path d="M7 12.5l2 2M10 9.5l1.5 1.5M13 6.5l2 2"/>',
  ping: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  target:
    '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  wall: '<path d="M3 5h18v14H3z"/><path d="M3 9.5h18M3 14h18M9 5v4.5M15 5v4.5M6 9.5V14M12 9.5V14M18 9.5V14M9 14v5M15 14v5"/>',
  terrain: '<path d="M3 19l5-8 3.5 5 3-4 6.5 7z"/><circle cx="16.5" cy="6.5" r="1.8"/>',
  area: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3 2.4"/><circle cx="12" cy="12" r="1.3"/>',
  // play
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  hourglass:
    '<path d="M6 3h12M6 21h12M7 3c0 5 10 6 10 9s-10 4-10 9M17 3c0 5-10 6-10 9s10 4 10 9"/>',
  sparkle:
    '<path d="M12 3c.7 4.3 2.7 6.3 7 7-4.3.7-6.3 2.7-7 7-.7-4.3-2.7-6.3-7-7 4.3-.7 6.3-2.7 7-7z"/>',
  potion:
    '<path d="M9.5 3h5M10 3v5.2L5.8 15a5 5 0 0 0 4.3 6h3.8a5 5 0 0 0 4.3-6L14 8.2V3"/><path d="M7 15.5h10"/>',
  bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/>',
  scroll:
    '<path d="M7 4h11a2 2 0 0 1 2 2v1h-4"/><path d="M16 7v11a2 2 0 0 1-4 0v-1H4v1a2 2 0 0 0 2 2h8"/><path d="M7 4a2 2 0 0 0-2 2v11"/><path d="M9 9h5M9 12.5h5"/>',
  concentration:
    '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/>',
  skull:
    '<path d="M12 3a7.5 7.5 0 0 0-4.5 13.5V20h9v-3.5A7.5 7.5 0 0 0 12 3z"/><circle cx="9.3" cy="11" r="1.5"/><circle cx="14.7" cy="11" r="1.5"/><path d="M10.5 20v-2.2M13.5 20v-2.2"/>',
  levelUp: '<path d="M12 20V6M6.5 11.5L12 6l5.5 5.5"/><path d="M5 3.5h14"/>',
  portrait:
    '<rect x="4" y="3.5" width="16" height="17" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7 18c.9-2.5 2.7-3.7 5-3.7s4.1 1.2 5 3.7"/>',
  // points of interest
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  door: '<path d="M6 21V4.5L15 3v18"/><path d="M15 5h3v16M4 21h16"/><circle cx="12.2" cy="12.5" r=".9"/>',
  trap: '<path d="M3 15h18"/><path d="M5 15l2-5 2 5 2-5 2 5 2-5 2 5 2-5 1 5"/><path d="M4 19h16"/>',
  puzzle:
    '<path d="M5 5h4.5a2 2 0 1 1 4 0H18v4.5a2 2 0 1 1 0 4V18h-4.5a2 2 0 1 0-4 0H5v-4.5a2 2 0 1 0 0-4z"/>',
  room: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 12h5M15 12h5"/>',
  passage: '<path d="M8 3v18M16 3v18"/><path d="M12 6v2.5M12 11v2.5M12 16v2.5"/>',
  chest:
    '<path d="M4 10.5h16V19H4z"/><path d="M4 10.5C4 7 6.5 5 12 5s8 2 8 5.5"/><path d="M10.5 13h3v2.5h-3z"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  className,
  x,
  y,
}: {
  name: IconName;
  size?: number;
  className?: string;
  /** Inside another SVG (the map): where to draw it. */
  x?: number;
  y?: number;
}) {
  return (
    <svg
      x={x}
      y={y}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      // Static, trusted markup from the table above.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: icons are constants in this file
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}
