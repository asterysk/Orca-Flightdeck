# Changelog

## Unreleased

- **UPDATE key** on a new Plugin page (last page on every deck): the first tap checks GitHub for a newer release and shows it on the key, the second tap installs it. Installs go through `orca plugin update`, so an update that asks for new access still waits for your approval in Orca. A quick-start clone (dev-loaded folder) updates with `git pull --ff-only`. Installing needs `allow-shell = true`; checking does not. Already have your own `update` key? The page is not added.
- **Leave the full-width view from its own arrows:** in the full-width tab the ⤢ button turns into a collapse button. Orca does not let plugins close tabs, so with `allow-shell = true` it presses ⌘W in Orca through Orca's computer use (`orca computer hotkey`), closing the tab you just clicked in. Without `allow-shell` it jumps back to the agent most in need and leaves the tab open behind it.
- **Pinned mini deck:** a PIN button on the deck keeps a small deck (about 56px keys) under the counts in the sidebar, always open. UNPIN puts it back with the folded sections. Remembered between sessions.

## 0.6.0 · 2026-11-24 · plain words by default, renamed to Flightdeck for Orca

- **Renamed to Flightdeck for Orca.** The Orca plugin directory reserves display names that start with "Orca" for official plugins. The plugin id (`flightdeck`), settings and `~/.flightdeck/` are unchanged, and so is the repository URL.

From first-user feedback: a new user should understand the screen in seconds, without the flight-control vocabulary.

- **Plain words by default:** Running / Needs you / Failed / Done instead of GO / HOLD / NO-GO. Sections are **Agents**, **Needs you**, **Activity** and **Tokens today**, and the clock reads `Session 3h 12m` instead of `T+`. The status bar and desktop alerts use the same words.
- **Agents named by what they are:** workspace, agent kind and branch. No callsigns.
- **Colour means status everywhere:** blue running, orange needs you, red failed, green done, on counts, cards and deck keys. Deck keys show the workspace and agent. When two keys share a workspace, they show the branch.
- **Simpler sidebar:** counts, Needs you and one line per agent. Deck, Activity and Tokens fold away and remember your choice. The full-width view keeps everything open, with the deck on top.
- **First-run help:** a short "How Flightdeck works" card with a colour legend (dismiss with GOT IT), plus hover tips on counts and sections, and a one-line how-to under the deck.
- **Mission mode** (new setting, off by default): the original GO / HOLD / NO-GO wording, callsigns, per-agent key colours and `T+` clock.
- The demo deck's ANSWER key reads "needs you".
- Tests: a failing worker test no longer leaves the run hanging (`--test-force-exit`, `try/finally`).
- `scripts/deck-pages.mjs` draws the README's deck pages picture from the real key renderer. README and screenshots updated.

## 0.5.1 · 2026-11-24 · security fixes

- **EXPAND** no longer follows symlinks: a repo that plants a `.flightdeck` link (or a link inside it) is refused instead of having the link's target overwritten.
- **ANSWER** now takes two presses: the first shows what the agent is asking, the second (within 5 s, same agent) sends. One press can no longer approve something unseen.
- **allow-shell** also requires that you own `deck.vrx` and that its folder is not writable by others.
- **Deck link:** a connection that does not log in within 5 seconds is dropped.
- **deck.vrx:** key `color` must be a hex code.
- Removed the deprecated `publisher` field (Orca takes it from the repository owner).

## 0.5.0 · 2026-11-24 · listed in the Orca plugin directory

- Same code as 0.5.0-beta.1, still a beta. Version is plain `0.5.0` because the Orca directory only lists `vX.Y.Z` tags.
- Added `publisher` to the manifest (required by the directory).

## 0.5.0-beta.1 · 2026-11-24 · first public beta

- Renamed to **Orca Flightdeck** (plugin id `flightdeck`, config in `~/.flightdeck/`).
- **Hardware optional:** the on-screen deck takes any grid (`@deck <id> grid = mini|neo|plus|mk2|original|xl|"COLSxROWS"`); a connected Stream Deck still wins.
- **Three-page deck:** agents, Mission (RACE, PREVIEW, EXPAND, URGENT, THEME), Tools (GRID, DRIVE, ANSWER, NEW, ABORT).
- **Page key:** tap for the next page, hold for the agents page, on hardware and on screen.
- **Agent keys:** one colour per agent in a fixed order; GO / HOLD / NO-GO band; HOLD and NO-GO flash.
- **Feedback:** slow keys show "working" until done; failures show a desktop notification with the reason.
- **RACE / NEW:** fan out agents into new workspaces (optionally pinned to a named project); ABORT stops them and removes their workspaces.
- **THEME:** whole-app colour schemes, dark and light in turn; hold to go back to an Orca-dark lookalike.
- **orca CLI keys** (GRID, PREVIEW, DRIVE) gated by `allow-shell` and a private `deck.vrx`.
- Agents whose workspace disappears are dropped from the view.
- Fix: the deck helper no longer writes to the Stream Deck library's frozen key objects.

## 0.3.0 and earlier (private)

Mission room, Awaiting Flight, comms loop, fuel burn, status bar, notifications, and the first Stream Deck helper without the Elgato app.
