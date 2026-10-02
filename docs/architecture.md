# Lænsmann Camera architecture

## Goal

Build a local-only live camera system for a Debian homelab. The system must support multiple cameras and viewers while keeping the backend simple, secure, and easy to operate.

## Core architecture

Internet / LAN
  -> cam.lensmann.studio
    -> Apache HTTPS frontend + reverse proxy
      -> frontend
      -> /api -> Node.js backend
      -> /socket.io or /ws -> Node.js backend

The camera clients and viewer clients all use the same backend signaling layer and the same WebRTC model.

## Why this design

- WebRTC handles live video with low latency.
- The backend does not relay media by default unless needed.
- A single signaling and registry layer keeps browser and Android clients aligned.
- An in-memory registry is enough for the initial version and can later be replaced by a database.
- Apache handles TLS and reverse proxy, while Node.js focuses on signaling and coordination.

## Proposed module layout

### frontend

- Browser camera page
- Browser viewer page
- Landing page with active camera overview
- Share links and QR code generation
- Device permission and local preview handling

### backend

- WebSocket signaling
- REST endpoints for status and metadata
- Camera registry and viewer tracking
- Session cleanup and reconnect logic
- Basic validation and rate-limiting hooks

### shared

- Common types for camera state, viewer session, and signaling messages
- Shared validation helpers and constants

### android

- Kotlin app for camera operations
- CameraX / Camera2 integration
- Foreground service and notification support
- WebRTC client and reconnect flow

## Phase plan

1. Project skeleton and architecture approval
2. Frontend shell and route structure
3. Node backend service and health endpoints
4. WebSocket signaling layer
5. Browser camera client
6. Browser viewer client
7. WebRTC connection flow
8. Multiple camera handling
9. Android app foundation
10. Android foreground service
11. Reconnect and backoff logic
12. Apache reverse proxy configuration
13. HTTPS setup
14. Production deployment
15. Security and polish

## Key technical risks

- WebRTC signaling must remain consistent across browser and Android clients.
- Browser camera lifecycle is sensitive to page close, lock, and visibility changes.
- Android background restrictions require a foreground service and careful user experience.
- Reconnect loops must be rate-limited and avoid infinite connections.
- Camera IDs must be unpredictable enough to avoid enumeration.
