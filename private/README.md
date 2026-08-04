# Private VPS data

This directory holds machine-local data for Docker Compose on a VPS. Nothing here is committed except this README and `.gitignore`.

## Before first `docker compose up`

Copy the example holdings file so the bind mount exists:

```bash
cp web/data/holdings.example.json private/holdings.local.json
```

Edit `private/holdings.local.json` with your real cash and positions. Compose mounts the whole `private/` directory to `/app/private` and sets `HOLDINGS_FILE` so atomic writes work.

## Container user and mount permissions

Web and pyserver containers run as **`app` (uid/gid 1001)**, not root.

| Mount | Host / volume | Container path | Notes |
|---|---|---|---|
| Bind | `./web/data` | `/app/data` | Universe refresh writes `universe.json`; host dir must be writable by **uid 1001** |
| Bind | `./private` | `/app/private` | Holdings atomic writes |
| Named volume | `web-cache` | `/app/.cache` | LLM/backtest SQLite cache |
| Named volume | `pyserver-cache` | `/app/cache-data` | Market-data SQLite cache (pyserver only) |

Before first `docker compose up`, align bind mount ownership on the host (from repo root):

```bash
sudo chown -R 1001:1001 web/data private
```

Named volumes (`web-cache`, `pyserver-cache`) pick up uid 1001 from the image mount points on **first** use. If you upgraded from an older root-owned volume:

```bash
docker compose run --rm --user root pyserver chown -R app:app /app/cache-data
docker compose run --rm --user root web chown -R app:app /app/.cache
```

Verify: `docker compose run --rm web id` and `docker compose run --rm pyserver id` should show `uid=1001(app)`. Full runbook: [docs/DEPLOY.md](../docs/DEPLOY.md) §3.

## What is persisted here

| Path | Purpose |
|------|---------|
| `holdings.local.json` | Real-mode portfolio (`./private` → `/app/private`) |
| `../web/data/` | Universe JSON (`./web/data` → `/app/data`; writable by uid 1001) |
| (Docker volume `web-cache`) | Web SQLite cache at `/app/.cache` inside the container |
| (Docker volume `pyserver-cache`) | pyserver SQLite cache at `/app/cache-data` |

Do not commit API keys or holdings to git.
