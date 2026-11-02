# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
Its only other runtime dependency is `mqtt` (the vendor's live channel). It started from the official
JavaScript template and controls UBPet / UPET self-cleaning litter boxes
through the vendor cloud.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/protocol.test.js         # one file
node --test --test-name-pattern "cat"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK + controller + handlers, nothing else
src/handlers.js                   SDK handlers (registered before connect), shared with the tests
src/controller.js                 orchestration: cloud session, MQTT session, refresh loop, publishing
src/litterBox.js                  pure device model: features, state mapping, command planning, safety
src/cloudApi.js                   UPET REST client (signing, login, endpoints)
src/mqttSession.js                persistent IM/MQTT session, reconnect back-off
src/protocol.js                   hand-written protobuf/RISP encoding and decoding of the MQTT payloads
src/vendorDefaults.js             app identity (APP_ID / APP_KEY / PRODUCT), obfuscated bundle
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test; the protocol is tested against frames captured from the app
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Protocol credits.** The cloud and MQTT protocol come from the community
  Home Assistant integrations (CrazzyBerg/upet-hass and forks,
  edied2002/vividmoo-ha). Keep `test/protocol.test.js` byte-exact against the
  captured app frames when touching `src/protocol.js`.
- **One session per account.** Every REST login revokes the other sessions of
  the account, ours included: log in only when the token expires, and never
  retry a refused password automatically.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
