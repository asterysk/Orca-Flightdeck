// Builds editor/index.html (the full-width mission room) from panel/index.html.
// The two pages are the same except for one flag, because a frame cannot load other files (CSP).
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const panel = readFileSync(new URL('panel/index.html', root), 'utf8');
const marker = '<script>\n;(() => {';
if (!panel.includes(marker)) throw new Error('panel/index.html: script marker not found');
export const editorHtml = panel
  .replace('<title>Flightdeck</title>', '<title>Flightdeck · Mission room</title>')
  .replace(marker, '<script>globalThis.__MC_EDITOR = true</script>\n' + marker);

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL('editor/index.html', root), editorHtml);
  console.log('wrote editor/index.html');
}
