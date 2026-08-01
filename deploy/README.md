# Caddy — private VPS app (Combo A)

Caddy terminates TLS and reverse-proxies to the Next.js app bound on localhost. **Only port 3000 is proxied**; pyserver stays on `127.0.0.1:8001` inside the host and must not be published to the internet.

## Install Caddy (Debian/Ubuntu)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Other platforms: [https://caddyserver.com/docs/install](https://caddyserver.com/docs/install)

## Configure

1. Ensure Docker Compose binds web to `127.0.0.1:3000` (`docker compose up -d`).
2. Copy the example and edit the site block:

   ```bash
   sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
   sudo nano /etc/caddy/Caddyfile   # replace app.example.com; point DNS A/AAAA to this VPS
   ```

3. Optional Basic Auth: uncomment the `basicauth` block in `Caddyfile.example`, run `caddy hash-password`, paste the hash, reload.

4. Validate and reload:

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

## Firewall

Open **only** HTTP/HTTPS on the public interface:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Do **not** allow `8001` (pyserver) or `3000` from the internet — Caddy reaches them on localhost.

## Verify

- Private URL loads the dashboard (with Basic Auth if enabled).
- `curl -sS http://127.0.0.1:8001/health` works on the VPS; the same port is unreachable from outside.
