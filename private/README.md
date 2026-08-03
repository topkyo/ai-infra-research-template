# Private VPS data

This directory holds machine-local data for Docker Compose on a VPS. Nothing here is committed except this README and `.gitignore`.

## Before first `docker compose up`

Copy the example holdings file so the bind mount exists:

```bash
cp web/data/holdings.example.json private/holdings.local.json
```

Edit `private/holdings.local.json` with your real cash and positions. Compose mounts the whole `private/` directory to `/app/private` and sets `HOLDINGS_FILE` so atomic writes work.

## What is persisted here

| Path | Purpose |
|------|---------|
| `holdings.local.json` | Real-mode portfolio (`./private` → `/app/private`) |
| (Docker volume `web-cache`) | Web SQLite cache at `/app/.cache` inside the container |

Do not commit API keys or holdings to git.
