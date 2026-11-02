# Gladys Assistant – UBPet Litter Box

A [Gladys Assistant](https://gladysassistant.com) external integration for
**UBPet / UPET self-cleaning litter boxes** (UBPet C20, C10, C10 Pro, and the
Meowant / Airrobo rebrands of the same boxes).

It talks to the same cloud as the official UPET app: a REST API for the account,
devices, waste bin, deodorant and visit history, and the vendor's MQTT channel
for live state and commands. User documentation: [docs/en.md](docs/en.md),
[docs/fr.md](docs/fr.md).

> Community project, not affiliated with UBTECH / UPET. The vendor API is
> private and was reverse-engineered by the Home Assistant community
> ([CrazzyBerg/upet-hass](https://github.com/CrazzyBerg/upet-hass) and its forks,
> notably [KennebecRiver66/upet-hass-multi-region](https://github.com/KennebecRiver66/upet-hass-multi-region)
> and [pfgcoder/meowant-hass](https://github.com/pfgcoder/meowant-hass), and
> [edied2002/vividmoo-ha](https://github.com/edied2002/vividmoo-ha)). It can
> change at any time.

## Features

- Switches **Cleaning** and **Levelling** (start/resume, pause), and a
  **Command** list: clean, level, pause, resume, waste bin emptied, refresh.
- Live **Status** and **Cat inside**, pushed by the box.
- Waste bin level and use counter, deodorant days, visits in the last 24 h,
  last visit ("Milo · 4.3 kg · 52 s") and its duration.
- Auto clean after use: on/off and delay.
- Scene triggers: **cat visit** (cat, weight, duration), **waste bin full**,
  **box blocked**.
- Safety: no movement while the box reports a cat inside or nearby.

## Try it on your Gladys (developer mode)

Requires Gladys 5.1 or later, with Docker on the same machine.

```bash
docker build -t gladys-ubpet:dev .
```

Then in Gladys: **Integrations → catalog → "Developer mode: install from a
Docker image"**, enter `gladys-ubpet:dev`, and fill in the configuration (see
the docs: use a second UPET account the box is shared with).

To iterate without Docker, run it against your Gladys with the credentials the
developer-mode install shows:

```bash
npm install
GLADYS_HOST_API_URL="http://<gladys-host>:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="<selector>" \
DATA_DIR=./data LOG_LEVEL=debug \
npm start
```

## Publish it to the store

1. Push this folder to a **public** GitHub repository.
2. Add the repository topic `gladys-assistant-integration`.
3. Run **Actions → Release** (bump `patch`/`minor`/`major`): it tags, builds the
   `linux/amd64` + `linux/arm64` image and pushes it to `ghcr.io`. Make the
   package public on GitHub.
4. The store indexer picks it up within the hour.

Check the manifest offline with `npx github:GladysAssistant/integration-store .`
(the Docker-image check only passes once the first release is pushed).

## Development

```bash
npm install
npm test              # node --test, no network
npm run lint
npm run format:check
```

The protocol tests check the RISP frames byte-for-byte against frames captured
from the official app. Project rules for contributors are in [CLAUDE.md](CLAUDE.md).

## License

Apache-2.0
