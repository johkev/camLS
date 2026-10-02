import http from 'node:http';
import crypto from 'node:crypto';
import { Server, Socket } from 'socket.io';

const port = Number(process.env.PORT ?? 3001);

interface CameraRecord {
  id: string;
  name: string;
  type: 'browser' | 'android';
  status: 'offline' | 'online' | 'live';
  createdAt: string;
  lastSeen: string;
  viewerCount: number;
  batteryLevel?: number;
  networkType?: string;
  quality?: string;
}

const cameras = new Map<string, CameraRecord>();
const cameraSocketIds = new Map<string, string>();
const cameraSocketByCameraId = new Map<string, string>();
const cameraIdsByDeviceKey = new Map<string, string>();
const viewerSocketIds = new Map<string, Set<string>>();

function getPublicBaseUrl() {
  const configuredUrl = process.env.CAMERA_PUBLIC_BASE_URL?.trim();
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, '');
  }

  return 'https://cam.lensmann.studio';
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        name: 'Lænsmann Camera backend',
        status: 'ok',
        phase: 'backend-signaling',
        timestamp: new Date().toISOString(),
        cameraCount: cameras.size,
      }),
    );
    return;
  }

  if (req.url === '/api/cameras') {
    const cameraList = Array.from(cameras.values())
      .filter((camera) => camera.status !== 'offline')
      .map((camera) => ({ ...camera }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cameraList));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const io = new Server(server, {
  cors: {
    origin: '*',
  },
  transports: ['websocket', 'polling'],
});

function makeCameraId(): string {
  let id = '';
  do {
    id = `CAM-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  } while (cameras.has(id));

  return id;
}

function serializeCamera(camera: CameraRecord) {
  return {
    id: camera.id,
    name: camera.name,
    type: camera.type,
    status: camera.status,
    createdAt: camera.createdAt,
    lastSeen: camera.lastSeen,
    viewerCount: camera.viewerCount,
    batteryLevel: camera.batteryLevel,
    networkType: camera.networkType,
    quality: camera.quality,
  };
}

function emitCameraList() {
  io.emit(
    'camera:list',
    getVisibleCameras(),
  );
}

function getVisibleCameras() {
  return Array.from(cameras.values())
    .filter((camera) => camera.status !== 'offline')
    .map((camera) => serializeCamera(camera));
}

function updateCameraViewerCount(cameraId: string) {
  const camera = cameras.get(cameraId);
  const viewers = viewerSocketIds.get(cameraId);

  if (!camera || !viewers) {
    return;
  }

  camera.viewerCount = viewers.size;
  camera.lastSeen = new Date().toISOString();
  io.to(cameraId).emit('camera:viewer-count', {
    cameraId,
    viewerCount: camera.viewerCount,
  });
  emitCameraList();
}

function handleCameraDisconnect(socket: Socket) {
  const cameraId = cameraSocketIds.get(socket.id);
  if (!cameraId) {
    return;
  }

  const camera = cameras.get(cameraId);
  if (!camera) {
    cameraSocketIds.delete(socket.id);
    cameraSocketByCameraId.delete(cameraId);
    return;
  }

  camera.status = 'offline';
  camera.lastSeen = new Date().toISOString();
  cameraSocketIds.delete(socket.id);
  cameraSocketByCameraId.delete(cameraId);

  io.to(cameraId).emit('camera:status', {
    cameraId,
    status: 'offline',
  });

  emitCameraList();
}

function handleViewerDisconnectForCamera(socket: Socket) {
  const cameraId = socket.data.viewerCameraId as string | undefined;
  if (!cameraId) {
    return;
  }

  const viewers = viewerSocketIds.get(cameraId);
  if (!viewers) {
    return;
  }

  viewers.delete(socket.id);
  if (viewers.size === 0) {
    viewerSocketIds.delete(cameraId);
  }

  const camera = cameras.get(cameraId);
  if (camera) {
    camera.viewerCount = viewers.size;
    camera.lastSeen = new Date().toISOString();
    io.to(cameraId).emit('camera:viewer-count', {
      cameraId,
      viewerCount: camera.viewerCount,
    });
  }

  io.to(cameraId).emit('viewer:leave', { cameraId, viewerId: socket.id });
  emitCameraList();
}

io.on('connection', (socket) => {
  socket.emit('server:hello', {
    message: 'Lænsmann Camera backend connected',
    timestamp: new Date().toISOString(),
  });
  socket.emit('camera:list', getVisibleCameras());

  socket.on('camera:register', ({ name, type, deviceKey }) => {
    const safeName = typeof name === 'string' ? name.trim().slice(0, 60) : 'Unnamed camera';
    const safeType = type === 'android' ? 'android' : 'browser';
    const now = new Date().toISOString();
    const safeDeviceKey = typeof deviceKey === 'string' ? deviceKey.trim().slice(0, 120) : '';
    const existingCameraId = safeDeviceKey ? cameraIdsByDeviceKey.get(safeDeviceKey) : undefined;
    const cameraId = existingCameraId ?? makeCameraId();
    const existingCamera = cameras.get(cameraId);

    const camera: CameraRecord = {
      id: cameraId,
      name: safeName,
      type: safeType,
      status: existingCamera?.status ?? 'online',
      createdAt: existingCamera?.createdAt ?? now,
      lastSeen: now,
      viewerCount: existingCamera?.viewerCount ?? 0,
      batteryLevel: existingCamera?.batteryLevel,
      networkType: existingCamera?.networkType,
      quality: existingCamera?.quality,
    };

    const previousSocketId = cameraSocketByCameraId.get(cameraId);
    if (previousSocketId && previousSocketId !== socket.id) {
      cameraSocketIds.delete(previousSocketId);
    }
    cameras.set(cameraId, camera);
    cameraSocketIds.set(socket.id, cameraId);
    cameraSocketByCameraId.set(cameraId, socket.id);
    if (safeDeviceKey) cameraIdsByDeviceKey.set(safeDeviceKey, cameraId);
    socket.data.cameraId = cameraId;
    socket.join(cameraId);

    socket.emit('camera:registered', {
      camera: serializeCamera(camera),
      shareUrl: `${getPublicBaseUrl()}/watch/${cameraId}`,
    });

    viewerSocketIds.get(cameraId)?.forEach((viewerId) => {
      socket.emit('viewer:joined', { viewerId, cameraId });
    });

    emitCameraList();
  });

  socket.on('camera:start', () => {
    const cameraId = socket.data.cameraId as string | undefined;
    if (!cameraId) {
      socket.emit('camera:error', { message: 'Camera not registered' });
      return;
    }

    const camera = cameras.get(cameraId);
    if (!camera) {
      socket.emit('camera:error', { message: 'Camera not found' });
      return;
    }

    camera.status = 'live';
    camera.lastSeen = new Date().toISOString();
    socket.emit('camera:status', { cameraId, status: 'live' });
    io.to(cameraId).emit('camera:status', { cameraId, status: 'live' });
    emitCameraList();
  });

  socket.on('camera:stop', () => {
    const cameraId = socket.data.cameraId as string | undefined;
    if (!cameraId) {
      return;
    }

    const camera = cameras.get(cameraId);
    if (!camera) {
      return;
    }

    camera.status = 'online';
    camera.lastSeen = new Date().toISOString();
    socket.emit('camera:status', { cameraId, status: 'online' });
    io.to(cameraId).emit('camera:status', { cameraId, status: 'online' });
    emitCameraList();
  });

  socket.on('viewer:join', ({ cameraId }) => {
    if (typeof cameraId !== 'string') {
      socket.emit('viewer:error', { message: 'Invalid camera id' });
      return;
    }

    const camera = cameras.get(cameraId);
    if (!camera) {
      socket.emit('viewer:error', { message: 'Camera not found' });
      return;
    }

    socket.data.viewerCameraId = cameraId;
    socket.join(cameraId);

    if (!viewerSocketIds.has(cameraId)) {
      viewerSocketIds.set(cameraId, new Set());
    }

    viewerSocketIds.get(cameraId)?.add(socket.id);
    updateCameraViewerCount(cameraId);

    const cameraSocketId = cameraSocketByCameraId.get(cameraId);
    const cameraPayload = serializeCamera(camera);

    socket.emit('viewer:joined', {
      cameraId,
      camera: cameraPayload,
      cameraSocketId,
    });

    if (cameraSocketId) {
      io.to(cameraSocketId).emit('viewer:joined', {
        viewerId: socket.id,
        cameraId,
      });
    }
  });

  socket.on('viewer:leave', ({ cameraId }) => {
    if (typeof cameraId !== 'string') {
      return;
    }

    const viewers = viewerSocketIds.get(cameraId);
    if (!viewers) {
      return;
    }

    viewers.delete(socket.id);
    if (viewers.size === 0) {
      viewerSocketIds.delete(cameraId);
    }

    const camera = cameras.get(cameraId);
    if (camera) {
      camera.viewerCount = viewers.size;
      camera.lastSeen = new Date().toISOString();
      emitCameraList();
    }
  });

  socket.on('camera:command', ({ cameraId, command, enabled }) => {
    if (typeof cameraId !== 'string') {
      return;
    }

    const cameraSocketId = cameraSocketByCameraId.get(cameraId);
    if (cameraSocketId) {
      io.to(cameraSocketId).emit('camera:command', { command, enabled });
    }

    if (command === 'remove') {
      cameras.delete(cameraId);
      cameraSocketByCameraId.delete(cameraId);
      if (cameraSocketId) {
        cameraSocketIds.delete(cameraSocketId);
      }
      emitCameraList();
    }
  });

  socket.on('camera:update-status', ({ batteryLevel, networkType, quality }) => {
    const cameraId = socket.data.cameraId as string | undefined;
    const camera = cameraId ? cameras.get(cameraId) : undefined;
    if (!camera) {
      return;
    }

    if (typeof batteryLevel === 'number') camera.batteryLevel = Math.max(0, Math.min(100, batteryLevel));
    if (typeof networkType === 'string') camera.networkType = networkType.slice(0, 30);
    if (typeof quality === 'string') camera.quality = quality.slice(0, 40);
    camera.lastSeen = new Date().toISOString();
    emitCameraList();
  });

  socket.on('signal:offer', ({ to, offer }) => {
    if (typeof to !== 'string' || !offer) {
      return;
    }

    socket.to(to).emit('signal:offer', {
      from: socket.id,
      offer,
    });
  });

  socket.on('signal:answer', ({ to, answer }) => {
    if (typeof to !== 'string' || !answer) {
      return;
    }

    socket.to(to).emit('signal:answer', {
      from: socket.id,
      answer,
    });
  });

  socket.on('signal:ice-candidate', ({ to, candidate }) => {
    if (typeof to !== 'string' || !candidate) {
      return;
    }

    socket.to(to).emit('signal:ice-candidate', {
      from: socket.id,
      candidate,
    });
  });

  socket.on('disconnect', () => {
    handleCameraDisconnect(socket);
    handleViewerDisconnectForCamera(socket);
  });
});

server.listen(port, () => {
  console.log(`[${new Date().toISOString()}] Backend listening on http://localhost:${port}`);
});
