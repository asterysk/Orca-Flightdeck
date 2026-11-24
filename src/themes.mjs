// Whole-window colour schemes for the THEME key, in the shape Orca's appearance.apply takes:
// `app` is an app/editor theme artifact, `terminal` a terminal theme artifact, both JSON strings.
// (Orca checks both strictly: `--background` and `--foreground` are required, the terminal needs
// background, foreground and at least one ANSI colour, and both must be the same mode.)

const DARK_ANSI = {
  black: '#0A0F18', red: '#FF5D6C', green: '#5EE6CF', yellow: '#FFC34D', blue: '#7FD4FF', magenta: '#F472B6', cyan: '#38BDF8',
  brightRed: '#FF8A94', brightGreen: '#8FF5E2', brightYellow: '#FFD98A', brightBlue: '#A9E3FF', brightMagenta: '#F9A8D4', brightCyan: '#7DD3FC', brightWhite: '#FFFFFF'
};
// Darker inks so text stays readable on a light background.
const LIGHT_ANSI = {
  black: '#1B2333', red: '#C8102E', green: '#047857', yellow: '#A16207', blue: '#1D4ED8', magenta: '#A21CAF', cyan: '#0E7490',
  brightRed: '#E11D48', brightGreen: '#059669', brightYellow: '#B45309', brightBlue: '#2563EB', brightMagenta: '#C026D3', brightCyan: '#0891B2', brightWhite: '#0A0F18'
};

function scheme(name, c) {
  const mode = c.mode ?? 'dark';
  const app = {
    schemaVersion: 1,
    base: mode,
    tokens: {
      '--background': c.bg,
      '--editor-surface': c.bg,
      '--foreground': c.fg,
      '--card': c.panel,
      '--card-foreground': c.fg,
      '--popover': c.panel,
      '--popover-foreground': c.fg,
      '--primary': c.accent,
      '--primary-foreground': c.bg,
      '--accent': c.panel,
      '--accent-foreground': c.fg,
      '--muted': c.panel,
      '--muted-foreground': c.dim,
      '--border': c.line,
      '--ring': c.accent,
      '--sidebar': c.side,
      '--sidebar-foreground': c.fg,
      '--sidebar-border': c.line,
      '--worktree-sidebar': c.side,
      '--worktree-sidebar-foreground': c.fg,
      '--worktree-sidebar-active': c.panel,
      '--worktree-sidebar-active-border': c.accent,
      '--tab-bar': c.side,
      '--tab-active': c.bg,
      '--tab-active-foreground': c.fg,
      '--tab-active-indicator': c.accent,
      '--tab-inactive': c.side,
      '--tab-inactive-foreground': c.dim,
      '--split-divider': c.line
    }
  };
  const terminal = {
    schemaVersion: 1,
    mode,
    terminal: {
      background: c.bg,
      foreground: c.fg,
      cursor: c.accent,
      selectionBackground: c.line,
      ...(mode === 'light' ? LIGHT_ANSI : DARK_ANSI),
      white: c.fg,
      brightBlack: c.dim
    }
  };
  return { name, app: JSON.stringify(app), terminal: JSON.stringify(terminal) };
}

// The THEME key steps through these in order and wraps round. Dark and light alternate so
// every press is a big, visible change on a shared screen.
export const THEMES = [
  scheme('Mission', { bg: '#04101C', panel: '#0B2236', side: '#061827', fg: '#E6F6FF', dim: '#7FA3BF', line: '#1A4566', accent: '#5EE6CF' }),
  scheme('Daylight', { mode: 'light', bg: '#FFFFFF', panel: '#EEF4FB', side: '#DDE8F5', fg: '#0A1628', dim: '#4B5D75', line: '#B8C9DD', accent: '#0369A1' }),
  scheme('Red alert', { bg: '#3A0610', panel: '#5C0B1A', side: '#4A0814', fg: '#FFECEE', dim: '#E59AA5', line: '#8A1F33', accent: '#FF5D6C' }),
  scheme('Solar', { mode: 'light', bg: '#FFF6D6', panel: '#FFE9A8', side: '#FFD970', fg: '#2B1A00', dim: '#6B5315', line: '#E0B648', accent: '#B45309' }),
  scheme('Deep space', { bg: '#140A3A', panel: '#24135E', side: '#1A0E4A', fg: '#F0EBFF', dim: '#A99BE0', line: '#3D2A8A', accent: '#A78BFA' })
];

// Hold THEME: back to a copy of Orca's own default dark look (app colours from Orca's
// main.css, terminal colours from its "Ghostty Default Style Dark"). A plugin cannot switch
// Orca back to its built-in theme, only publish colours, so this is a lookalike; Settings →
// Appearance picks the real one again.
export const HOME_THEME = (() => {
  const app = {
    schemaVersion: 1,
    base: 'dark',
    tokens: {
      '--background': '#0a0a0a', '--editor-surface': '#1e1e1e', '--foreground': '#f0f0f0',
      '--card': '#171717', '--card-foreground': '#f0f0f0', '--popover': '#171717', '--popover-foreground': '#f0f0f0',
      '--primary': '#e5e5e5', '--primary-foreground': '#171717', '--muted': '#262626', '--muted-foreground': '#acacac',
      '--accent': '#404040', '--accent-foreground': '#f0f0f0', '--border': '#1c1c1c', '--ring': '#737373',
      '--sidebar': '#171717', '--sidebar-foreground': '#f0f0f0', '--sidebar-border': '#1c1c1c',
      '--worktree-sidebar': '#2a2a2a', '--worktree-sidebar-foreground': '#f0f0f0', '--worktree-sidebar-border': '#1c1c1c',
      '--split-divider': '#71717a'
    }
  };
  const terminal = {
    schemaVersion: 1,
    mode: 'dark',
    terminal: {
      background: '#0a0a0a', foreground: '#ffffff', cursor: '#ffffff', selectionBackground: '#5a7898',
      black: '#1d1f21', red: '#cc6666', green: '#b5bd68', yellow: '#f0c674', blue: '#81a2be', magenta: '#b294bb', cyan: '#8abeb7', white: '#c5c8c6',
      brightBlack: '#666666', brightRed: '#d54e53', brightGreen: '#b9ca4a', brightYellow: '#e7c547', brightBlue: '#7aa6da', brightMagenta: '#c397d8', brightCyan: '#70c0b1', brightWhite: '#eaeaea'
    }
  };
  return { name: 'Orca dark', app: JSON.stringify(app), terminal: JSON.stringify(terminal) };
})();
