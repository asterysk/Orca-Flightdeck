<div align="center">

# ✈︎ Orca Flightdeck

**Run a fleet of coding agents like a mission control room.**

See every agent at a glance. Answer the ones waiting on you in one click.<br>
Fly it all from a deck of keys: on screen, or on any Stream Deck.

[![Status: public beta](https://img.shields.io/badge/status-public%20beta-FFC34D?style=flat-square)](CHANGELOG.md)
[![Orca 1.4.260+](https://img.shields.io/badge/Orca-1.4.260%2B-5EE6CF?style=flat-square)](https://orca.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-7FD4FF?style=flat-square)](LICENSE)
[![Stream Deck: optional](https://img.shields.io/badge/Stream%20Deck-optional-F472B6?style=flat-square)](#-hardware-optional)

<img src="images/social-card.png" alt="Orca Flightdeck" width="820">

[**Quick start**](#-quick-start-60-seconds) · [**Features**](#-what-it-does) · [**The deck**](#-the-deck) · [**Customise**](#-make-the-deck-yours) · [**FAQ**](#-faq)

</div>

---

## Why

[Orca](https://orca.dev) lets you run many AI coding agents at once, each on its own branch. That's powerful, and it gets noisy fast. Five agents in, you're clicking through tabs asking:

- *Which one is stuck?*
- *Which one is waiting for me to say yes?*
- *Which one just failed?*

**Flightdeck puts the answer on one screen.** Every agent gets a callsign and a status: **GO**, **HOLD** or **NO-GO**. Anything waiting on you jumps to the top, with a reply box right there.

> An independent plugin for Orca, not made by the Orca team.

## 🚀 Quick start (60 seconds)

```sh
git clone https://github.com/asterysk/Orca-Flightdeck ~/orca-flightdeck
cd ~/orca-flightdeck
orca plugin dev load .
```

Orca shows what the plugin may do and gives you a fingerprint. Run the same command with `--approve <fingerprint>`, then click the **🚀 rocket** in Orca's right sidebar. That's it: no Stream Deck, no extra installs.

<sub>No `orca` command? In Orca's Settings, search **Command line** and turn on "orca in other terminals".</sub>

## ✨ What it does

<table>
<tr>
<td width="50%" valign="top">

### 🛰 Every agent, one screen
A console card per agent, across all your workspaces: status, branch, agent type, tokens, time in state and a live activity trace. Click a card to jump straight to its terminal.

</td>
<td width="50%" valign="top">

### ✋ Awaiting Flight
Agents that are blocked, waiting or failed float to the top. **Type a reply and hit SEND** without leaving the room, or OPEN the terminal.

</td>
</tr>
<tr>
<td valign="top">

### 🏁 RACE
One key starts **five agents on the same task**, each in its own new workspace. Compare the results, keep the best. **ABORT** stops them all and cleans up.

</td>
<td valign="top">

### 🖥 Mission room
Open the whole view as a **full-width tab**. It's made for a second screen, a team room or a live demo.

</td>
</tr>
<tr>
<td valign="top">

### 🎛 A deck of keys
A Stream Deck-style grid **on screen**: agents on page one, actions on the next. Hardware is optional.

</td>
<td valign="top">

### 🔔 Never miss a HOLD
HOLD and NO-GO keys **flash**, the status bar shows `GO 3 · HOLD 2`, and a desktop alert tells you when an agent needs you.

</td>
</tr>
</table>

<img src="images/screenshot-wide.png" alt="The mission room: deck, Awaiting Flight queue, consoles, comms loop and fuel burn">

## 🎛 The deck

Three pages, six keys each on a Stream Deck Mini. The last key turns the page:

- **Tap** it: next page (1 → 2 → 3 → 1).
- **Hold** it: straight back to your agents.

<img src="images/deck-pages.png" alt="The three deck pages" width="760">

| Page | What's on it |
|---|---|
| **1 · Agents** | One key per agent, each in its own colour. Press to jump to it. |
| **2 · Mission** | **RACE** five agents · **PREVIEW** in Orca's browser · **EXPAND** to the mission room · **URGENT** jump to the agent most in need · **THEME** recolour all of Orca |
| **3 · Tools** | **GRID** a 2×2 terminal layout · **DRIVE** computer use *(experimental)* · **ANSWER** the agent on HOLD (press twice: see the question, then send) · **NEW** add one agent · **ABORT** stop and clean up |

Every slow key lights up and says **working** until it's done, so you always know a press landed.

## 🔌 Hardware optional

No Stream Deck? The on-screen deck is the full experience. Make it any shape you like:

```
@deck mini grid = xl     # mini · neo · plus · mk2 · original · xl · or "6x4"
```

<img src="images/screenshot-wide-xl.png" alt="The on-screen deck as a Stream Deck XL">

Got one? Plug it in and the same keys appear on it. **No Elgato software needed:** Flightdeck drives it directly.

```sh
cd ~/orca-flightdeck/deck-helper
npm install && ./install-launchagent.sh     # starts at login
```

Works with the Mini, Neo, MK.2, XL, + and Pedal. Quit the Elgato app first, because only one program can own the deck.

## 🛠 Make the deck yours

Your keys live in one plain text file, `~/.flightdeck/deck.vrx`. Save it and the deck updates within a second.

```
@page tools title = "Tools"
@key ff page = tools
@key ff slot = 1
@key ff label = "FIREFOX"
@key ff color = "#38BDF8"
@key ff action = app
@key ff app = "Firefox"
```

Want the full demo deck, with RACE, THEME and the rest?

```sh
./scripts/install-demo-deck.sh
```

<details>
<summary><b>Every key action</b></summary>

| `action` | Fields | Does |
|---|---|---|
| `page` | `target` | Opens a page (`home` = agents) |
| `orca` | `target` | Runs an Orca built-in, e.g. `"sidebar.right.toggle"` |
| `urgent` · `expand` · `refresh` | | Worst agent · mission room · poll now |
| `focus` | `workspace` | Jumps to a workspace's agent |
| `launch` | `agent`, `workspace`, `prompt` | Starts an agent in a workspace |
| `race` · `new` | `agents`, `count`, `prompt`, `setup`, `project` | New workspaces, one agent each |
| `answer` | `text`, `enter` | Replies to the agent on HOLD |
| `abort` | | Stops what RACE/NEW started |
| `theme` | | Next colour scheme (hold: back to dark) |
| `app` · `url` | `app` · `url` | Opens a Mac app · a link |
| `grid` · `preview` · `drive` | `commands` · `url` · `app`, `find`, `text` | Uses Orca's command line |
| `shortcut` · `shell` | `name` · `run` | A macOS Shortcut · a shell command |

Deck settings: `allow-shell`, `grid`, `pages` (order), `orca-cli` (path to `orca`).

</details>

## 🔒 Safe by default

- **Nothing types into an agent unless you press a key.**
- **Keys that run programs are off** until you set `allow-shell = true`, and the file must be private (`chmod 600`).
- **The hardware link is local-only,** guarded by a token in a file only you can read.
- **RACE makes real branches.** Try it in a scratch repo first.

## ❓ FAQ

<details><summary><b>Do I need a Stream Deck?</b></summary>
No. The on-screen deck does everything, and you can shape it like any model.
</details>

<details><summary><b>Which agents does it work with?</b></summary>
Any agent Orca runs: Claude Code, Codex, OpenCode, Gemini, Hermes and the rest.
</details>

<details><summary><b>Does it send my code anywhere?</b></summary>
Flightdeck itself sends nothing anywhere: it runs inside Orca on your machine and only talks to Orca. Your agents talk to their own model providers as usual.
</details>

<details><summary><b>THEME changed my colours. How do I get mine back?</b></summary>
Hold THEME for a close copy of Orca's dark look, or pick your own theme again in Orca's settings. Orca doesn't let plugins switch built-in themes back.
</details>

<details><summary><b>Windows or Linux?</b></summary>
The plugin follows Orca's platforms. The optional hardware helper is macOS-only for now.
</details>

## 🗺 Roadmap

- [x] Mission room, Awaiting Flight, consoles
- [x] On-screen deck in any grid, Stream Deck optional
- [x] RACE / ABORT, THEME, page key with hold
- [ ] Remember RACE runs across restarts
- [ ] Dials and touch strip on Stream Deck +
- [ ] Remote agents: see teammates' agents in your room
- [ ] Rules that can stop an agent before it acts

## 🤝 Contributing

Issues and pull requests are welcome. To hack on it:

```sh
orca plugin dev watch .     # live-reload in Orca
npm test                    # tests against a fake Orca
```

<details><summary>Project layout</summary>

`src/worker.mjs` talks to Orca · `src/fleet.mjs` agent model · `src/deck.mjs` draws keys · `src/deckconfig.mjs` reads `deck.vrx` · `src/bridge.mjs` local link to the hardware helper · `deck-helper/` drives the Stream Deck · `panel/index.html` the UI

</details>

## 🙏 Credits

Deck pairing idea from [crilofer/orca-streamdeck](https://github.com/crilofer/orca-streamdeck). Hardware access via [`@elgato-stream-deck/node`](https://github.com/Julusian/node-elgato-stream-deck). Elgato and Stream Deck are trademarks of Corsair. Not affiliated with Corsair or Orca.

<div align="center">

**MIT © 2026 Steve Charles** · If Flightdeck saves you a few tab-hunts, a ⭐ helps others find it.

</div>
