# Screenshots for the README, from neutral sample data (scripts/preview-data.mjs).
# Needs Playwright for Python and Chrome:  python3 scripts/preview-shot.py
import json, pathlib, subprocess
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parent.parent
def snap(grid, page='home'):
    return subprocess.check_output(['node', str(root / 'scripts/preview-data.mjs'), grid, page], cwd=root).decode()
shots = [(380, 1500, 'sidebar', 'mini', 'home'), (1440, 980, 'wide', 'mini', 'home'), (1440, 980, 'wide-xl', 'xl', 'home'), (1440, 980, 'wide-mission', 'mini', 'mission')]
html = (root / 'editor/index.html').as_uri()
side = (root / 'panel/index.html').as_uri()
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for w, h, name, grid, page in shots:
        pg = b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=2)
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.add_init_script('globalThis.__MC_PREVIEW__ = async () => (%s)' % snap(grid, page))
        pg.goto(side)
        pg.wait_for_timeout(1500)
        pg.screenshot(path=str(root / f'images/screenshot-{name}.png'), full_page=True)
        print(name, 'errors:', errs)
    b.close()
