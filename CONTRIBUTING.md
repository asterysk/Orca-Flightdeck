# Contributing

Thanks for helping with Flightdeck for Orca. Issues and pull requests are welcome.

## Before you start

- **Bug?** Open an issue with the bug template. Say what you did, what you expected and what happened.
- **Idea?** Open an issue with the feature template first, so we can agree on it before you write code.
- **Security problem?** Don't open an issue. See [SECURITY.md](SECURITY.md).

## Set up

You need [Orca](https://orca.dev) 1.4.260 or newer and Node 20 or newer.

```sh
git clone https://github.com/asterysk/Orca-Flightdeck
cd Orca-Flightdeck
orca plugin dev load .      # load in Orca (reloads on save; first time prints an --approve line)
orca plugin validate .      # Orca's own manifest check
npm test                    # tests against a fake Orca
```

The Stream Deck helper lives in `deck-helper/` and needs its own `npm install`.

Read Orca's [plugin authoring guide](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md) before changing `orca-plugin.json`: it covers execution levels, capabilities, approvals and how updates reach users.

## Pull requests

- Keep each PR to one change, and say why you made it.
- Add or update a test in `tests/` when you change behaviour.
- Run `npm test` before you push. CI runs it on macOS and Ubuntu, Node 20 and 22.
- Note user-facing changes in `CHANGELOG.md`.

By contributing you agree your work is released under the [MIT License](LICENSE), and you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
