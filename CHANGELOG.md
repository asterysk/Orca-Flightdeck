# Changelog

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
