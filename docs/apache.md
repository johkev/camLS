# Apache reverse proxy

The ready-to-use Apache virtual host is in `deploy/apache/lensmann-camera.conf`.
Replace `CAMERA_DOMAIN` with the Cloudflare hostname before installing it.

Planned modules:

- `mod_ssl`
- `mod_rewrite`
- `mod_proxy`
- `mod_proxy_http`
- `mod_proxy_wstunnel`
- `mod_headers`

The final deployment configuration will route:

- `https://cam.lensmann.studio/` -> frontend
- `https://cam.lensmann.studio/api/*` -> Node.js backend
- `https://cam.lensmann.studio/socket.io/*` -> Node.js backend
- `https://cam.lensmann.studio/ws/*` -> Node.js backend or WebSocket endpoint

For the complete Debian installation, see `docs/deployment-debian.md`.
