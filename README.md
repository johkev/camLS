# Lænsmann Camera

This repository is the initial project skeleton for a local camera streaming system for a Debian homelab.

## Current phase

Feature-complete development build. Debian deployment is documented in
`docs/deployment-debian.md`.

## Monorepo structure

- `frontend/` – browser camera and viewer UI
- `backend/` – Node.js signaling and coordination service
- `shared/` – shared TypeScript types and helpers
- `android/` – Android camera client source
- `docs/` – deployment and architecture documentation

## Install

```bash
cd /path/to/lensmann-camera
npm install
```

## Useful commands

```bash
npm run dev
npm run build
npm start
```

## Architecture summary

The system uses a single WebRTC-based live streaming design for browser and Android clients.
The backend is responsible for WebSocket signaling, session coordination, camera registry,
and the camera/viewer state model.
