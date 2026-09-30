# dsh-plugin-web-search

English | [中文](README.zh.md)

Choose DSH's **search provider** and **fetch provider** under **Settings → Configuration → Plugin Configuration**, and take over the `web` row.

## Features

- Pick DSH's **search provider** and **fetch provider** from dropdowns on the Web Search card under **Settings → Configuration → Plugin Configuration** — no hand-written patch.
- Three wire formats are provided: **SearxNG-compatible** (search), **Jina-compatible** (fetch) and **Firecrawl-compatible** (fetch). Any service that implements a format plugs in; you supply the endpoint.
- dsh's in-box **http (local fetch)** is kept as an endpoint-free option.
- Saving takes over the `web` row (written to the home patch layer) — **no restart, effective on the next call**.
- **Restore to default** on the card deletes the managed block in one click and hands the choice back to the profile patch and dsh defaults.

## Install

### From GitHub (recommended)

```bash
dsh plugin --profile web add github:CJ-SH/dsh-plugin-web-search
```

### From a local directory

```bash
dsh plugin --profile web add ./dsh-plugin-web-search
```

link: a development install needs one extra step to link the peer into dsh's shared closure:

```bash
(cd ./dsh-plugin-web-search && npm run link-imports)
```

Loading the plugin requires a dsh restart; the restart ends the current agent's own process, so leave that step to the user.

## Usage

- Entry point: **Settings → Configuration → Plugin Configuration → Web Search**.
- The card is collapsed by default and shows only its title; expanded, it shows two dropdowns: **search provider** and **fetch provider**.
- Selecting one of this plugin's formats reveals that format's **endpoint** and **custom header** inputs below; a format without an endpoint is marked “This format has no endpoint yet, so it stays unusable after saving.”
- After saving, the card collapses and the selection is written to the plugin configuration, taking over the `web` row; on failure the card expands again and shows the reason.
- The configuration file is the sentinel-wrapped section in `$DSH_HOME/cordis.patch.yml`.

## Uninstall

```bash
dsh plugin --profile web remove dsh-plugin-web-search
```

## Technical notes

- When several providers are registered for the same capability the seam **cannot auto-select** one (it reports `WEB_PROVIDER_AMBIGUOUS`), so `searchProvider` and `fetchProvider` **must always be set explicitly**.
- With **in-box http** for fetching, the local dsh process connects directly, which **depends on local DNS resolving real public IPs**; a proxy's **fake-ip mode** makes every fetch fail as "non-public IP address".
- Only the three formats above are implemented; search preferences (`language` / `categories` / `safesearch` / `time_range`) are not exposed, and `maxResults` has nowhere to go for any of the three formats.
- The request timeout is a fixed 15 seconds and is not configurable.

## Further reading

Contracts, troubleshooting and internals live in [docs/design-notes.md](docs/design-notes.md).

## License

MIT © 2026 HenTaiCJN
