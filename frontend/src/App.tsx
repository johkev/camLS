import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { io, type Socket } from 'socket.io-client';

type CameraInfo = {
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
};

const demoCameras: CameraInfo[] = [
  { id: 'CAM-AB12CD', name: 'Garasje', type: 'browser', status: 'live', createdAt: '', lastSeen: '', viewerCount: 2 },
  { id: 'CAM-7721FF', name: 'Soverom', type: 'browser', status: 'live', createdAt: '', lastSeen: '', viewerCount: 1 },
];

const visibleCameras = (cameraList: CameraInfo[]) => cameraList.filter((camera) => camera.status !== 'offline');

const getAppBaseUrl = () => {
  const configuredUrl = import.meta.env.VITE_PUBLIC_APP_URL || import.meta.env.VITE_PUBLIC_BASE_URL;
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, '');
  }

  const { protocol, hostname, port } = window.location;
  const portSuffix = port && port !== '80' && port !== '443' ? `:${port}` : '';
  return `${protocol}//${hostname}${portSuffix}`;
};

const backendServer = (() => {
  const configuredUrl = import.meta.env.VITE_BACKEND_URL;
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, '');
  }

  return window.location.origin;
})();

const mediaServer = (() => {
  const configuredUrl = import.meta.env.VITE_MEDIA_SERVER_URL;
  if (configuredUrl) return configuredUrl.replace(/\/+$/, '');
  return `${window.location.origin}/live`;
})();

const getDeviceKey = () => {
  const storageKey = 'camls-device-key';
  const existingKey = window.localStorage.getItem(storageKey);
  if (existingKey) {
    return existingKey;
  }

  const newKey = crypto.randomUUID();
  window.localStorage.setItem(storageKey, newKey);
  return newKey;
};
const stunServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

const createSocket = () =>
  io(backendServer, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    timeout: 10000,
  });

type ConnectionStatus = 'offline' | 'connecting' | 'connected';

const streamQualityProfiles = {
  low: { label: 'Lav - minst lagg', width: 640, height: 360, fps: 15, bitrate: 700_000 },
  balanced: { label: 'Balansert - anbefalt', width: 1280, height: 720, fps: 24, bitrate: 1_800_000 },
  high: { label: 'Høy - best kvalitet', width: 1920, height: 1080, fps: 30, bitrate: 3_500_000 },
} as const;

type StreamQuality = keyof typeof streamQualityProfiles;

function SiteFooter() {
  return (
    <footer className="footer">
      <p>© 2026 LÆNSMANN STUDIO</p>
      <p>LAGET AV MEG KEVIN JOHNSEN :) </p>
      <p>© 2026 LÆNSMANN STUDIO · TEKNISK INFO</p>
    </footer>
  );
}

function ServerCameraPreview({ large = false }: { large?: boolean }) {
  const [status, setStatus] = useState<'live' | 'offline' | 'disabled'>('offline');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let active = true;
    const checkStatus = async () => {
      try {
        const response = await fetch(`${backendServer}/api/health`, { cache: 'no-store' });
        const data = (await response.json()) as { serverCamera?: 'live' | 'offline' | 'disabled' };
        if (active) setStatus(data.serverCamera ?? 'offline');
      } catch {
        if (active) setStatus('offline');
      }
    };
    checkStatus();
    const timer = window.setInterval(checkStatus, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!videoRef.current || !remoteStream) return;
    videoRef.current.srcObject = remoteStream;
    videoRef.current.play().catch(() => undefined);
  }, [remoteStream, isMuted]);

  useEffect(() => {
    let cancelled = false;
    let peerConnection: RTCPeerConnection | null = null;
    let sessionUrl = '';
    let retryTimer: number | undefined;

    const closeConnection = () => {
      peerConnection?.close();
      peerConnection = null;
      if (sessionUrl) fetch(sessionUrl, { method: 'DELETE' }).catch(() => undefined);
      sessionUrl = '';
    };

    const waitForCandidates = (connection: RTCPeerConnection) => new Promise<void>((resolve) => {
      if (connection.iceGatheringState === 'complete') return resolve();

      const onGatheringStateChange = () => {
        if (connection.iceGatheringState === 'complete') finish();
      };

      const finish = () => {
        window.clearTimeout(timeout);
        connection.removeEventListener('icegatheringstatechange', onGatheringStateChange);
        resolve();
      };

      const timeout = window.setTimeout(finish, 1500);
      connection.addEventListener('icegatheringstatechange', onGatheringStateChange);
    });

    const connect = async () => {
      closeConnection();
      setConnectionStatus('connecting');
      try {
        const connection = new RTCPeerConnection();
        peerConnection = connection;
        connection.addTransceiver('video', { direction: 'recvonly' });
        connection.addTransceiver('audio', { direction: 'recvonly' });
        connection.ontrack = (event) => {
          if (!cancelled && event.streams[0]) setRemoteStream(event.streams[0]);
        };
        connection.onconnectionstatechange = () => {
          if (cancelled) return;
          if (connection.connectionState === 'connected') setConnectionStatus('connected');
          if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
            setConnectionStatus('offline');
            retryTimer = window.setTimeout(connect, 2000);
          }
        };

        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        await waitForCandidates(connection);
        const response = await fetch(`${mediaServer}/server/whep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: connection.localDescription?.sdp,
        });
        if (!response.ok) throw new Error(`WebRTC-signalisering feilet (${response.status})`);
        const location = response.headers.get('location');
        if (location) {
          sessionUrl = /^https?:\/\//i.test(location)
            ? location
            : `${mediaServer}${location.startsWith('/') ? location : `/${location}`}`;
        }
        await connection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
      } catch (error) {
        console.warn('Kunne ikke koble til serverkamera:', error);
        if (!cancelled) {
          setConnectionStatus('offline');
          retryTimer = window.setTimeout(connect, 2000);
        }
      }
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      closeConnection();
    };
  }, []);

  return (
    <section className={`server-camera-panel ${large ? 'large' : ''}`}>
      <div className="server-camera-heading">
        <div><p className="eyebrow">SERVER USB-KAMERA</p><h2>Live fra serveren</h2></div>
        <span className="status-row"><span className={`status-dot ${status === 'live' ? 'live' : 'offline'}`} />{status === 'live' ? 'LIVE' : status === 'disabled' ? 'DEAKTIVERT' : 'OFFLINE'}</span>
      </div>
      <div className="server-camera-frame">
        {status === 'disabled' ? 'Serverkamera er deaktivert' : <video ref={videoRef} autoPlay playsInline muted={isMuted} controls={large} className="live-video" />}
      </div>
      <div className="server-camera-controls">
        <span className="muted-text">WebRTC: {connectionStatus === 'connected' ? 'tilkoblet' : connectionStatus === 'connecting' ? 'kobler til' : 'prøver på nytt'}</span>
        {large && <button className="btn btn-ghost" onClick={() => setIsMuted((value) => !value)}>{isMuted ? 'SLÅ PÅ LYD' : 'SLÅ AV LYD'}</button>}
      </div>
      {status !== 'live' && status !== 'disabled' && <p className="muted-text">Venter på kamera, lydinngang eller FFmpeg på serveren…</p>}
    </section>
  );
}

function HomePage() {
  const [cameras, setCameras] = useState<CameraInfo[]>(demoCameras);
  const socketRef = useRef<Socket | null>(null);

  function sendCameraCommand(cameraId: string, command: 'start' | 'stop' | 'remove') {
    if (command === 'remove' && !window.confirm('Fjerne dette kameraet?')) {
      return;
    }
    socketRef.current?.emit('camera:command', { cameraId, command });
    if (command === 'remove') {
      setCameras((current) => current.filter((camera) => camera.id !== cameraId));
    }
  }

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    const updateCameraList = async () => {
      try {
        const response = await fetch(`${backendServer}/api/cameras`);
        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as CameraInfo[];
        setCameras(visibleCameras(data));
      } catch {
        setCameras(demoCameras);
      }
    };

    socket.on('camera:list', (cameraList: CameraInfo[]) => {
      setCameras(visibleCameras(cameraList));
    });

    updateCameraList();

    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <>
      <header className="site-header">
        <div className="nav-row">
          <Link className="logo" to="/">
            <img src="/favicon/favicon.svg" alt="Lænsmann Camera logo" className="logo-badge" />
            <span className="logo-text">Lænsmann Camera</span>
          </Link>

          <nav className="site-nav" aria-label="Primær navigasjon">
            <Link to="/">Hjem</Link>
            <Link to="/camera">Kamera</Link>
            <Link className="btn btn-secondary" to="/watch/server">Serverkamera</Link>
          </nav>
        </div>
      </header>

      <main className="page-shell">
        <header className="header-bar">
          <div>
            <p className="eyebrow">LÆNSMANN CAMERA</p>
            <h1>LIVE-KAMERA</h1>
          </div>
          <Link className="btn btn-primary" to="/camera">
            BRUK DENNE ENHETEN SOM KAMERA
          </Link>
        </header>

        <ServerCameraPreview />

        <section className="camera-grid">
          {cameras.map((camera) => (
            <article key={camera.id} className="camera-card">
              <div className="card-top">
                <div>
                  <h2>{camera.name}</h2>
                  <p className="status-row">
                    <span className={`status-dot ${camera.status === 'live' ? 'live' : 'offline'}`} />
                    {camera.status === 'live' ? 'LIVE' : 'OFFLINE'}
                  </p>
                </div>
                <span className="viewer-count">{camera.viewerCount} seer{camera.viewerCount === 1 ? '' : 'e'}</span>
              </div>

              <div className="camera-details">
                {camera.batteryLevel !== undefined && <span>Batteri {camera.batteryLevel}%</span>}
                {camera.networkType && <span>{camera.networkType}</span>}
                {camera.quality && <span>{camera.quality}</span>}
              </div>

              <div className="card-actions">
                <Link className="btn btn-secondary" to={`/watch/${camera.id}`}>
                  SE
                </Link>
                <button className="btn btn-ghost" onClick={() => sendCameraCommand(camera.id, camera.status === 'live' ? 'stop' : 'start')}>
                  {camera.status === 'live' ? 'STOPP' : 'START'}
                </button>
                <button className="btn btn-ghost danger-button" onClick={() => sendCameraCommand(camera.id, 'remove')}>
                  FJERN
                </button>
              </div>
            </article>
          ))}
        </section>
      </main>
    </>
  );
}

function CameraPage() {
  const [cameraName, setCameraName] = useState('Garasje');
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('environment');
  const [streamQuality, setStreamQuality] = useState<StreamQuality>('balanced');
  const [micEnabled, setMicEnabled] = useState(true);
  const [selectedVideoDevice, setSelectedVideoDevice] = useState('');
  const [selectedAudioDevice, setSelectedAudioDevice] = useState('');
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraStatus, setCameraStatus] = useState<'offline' | 'online' | 'live'>('offline');
  const [connectionState, setConnectionState] = useState<ConnectionStatus>('offline');
  const [cameraId, setCameraId] = useState('');
  const [shareUrl, setShareUrl] = useState(`${getAppBaseUrl()}/watch/CAM-XXXXXX`);
  const [errorMessage, setErrorMessage] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [socketReady, setSocketReady] = useState(false);
  const [isRegistered, setIsRegistered] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const streamQualityRef = useRef<StreamQuality>(streamQuality);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

  useEffect(() => {
    streamQualityRef.current = streamQuality;
  }, [streamQuality]);

  async function requestScreenWakeLock() {
    if (!('wakeLock' in navigator) || wakeLockRef.current || !previewReady) {
      return;
    }

    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen');
      wakeLockRef.current.addEventListener('release', () => {
        wakeLockRef.current = null;
      });
    } catch (error) {
      console.warn('Kunne ikke holde kamerasiden våken:', error);
    }
  }

  function releaseScreenWakeLock() {
    wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  }

  useEffect(() => {
    if (previewReady) {
      requestScreenWakeLock();
    } else {
      releaseScreenWakeLock();
    }
  }, [previewReady]);

  useEffect(() => {
    const reacquireWakeLock = () => {
      if (document.visibilityState === 'visible' && previewReady) {
        requestScreenWakeLock();
      }
    };

    document.addEventListener('visibilitychange', reacquireWakeLock);
    return () => document.removeEventListener('visibilitychange', reacquireWakeLock);
  }, [previewReady]);

  const closePeerConnection = () => {
    if (!peerConnectionRef.current) {
      return;
    }

    peerConnectionRef.current.onicecandidate = null;
    peerConnectionRef.current.onconnectionstatechange = null;
    peerConnectionRef.current.close();
    peerConnectionRef.current = null;
  };

  useEffect(() => {
    const socket = createSocket();

    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketReady(true);
      setErrorMessage('');
    });

    socket.on('connect_error', () => {
      setSocketReady(false);
      setErrorMessage('Tjeneren er midlertidig utilgjengelig. Prøver på nytt…');
    });

    socket.on('disconnect', () => {
      setSocketReady(false);
      setConnectionState('offline');
      setCameraStatus('offline');
    });

    socket.on('camera:registered', ({ camera, shareUrl: nextShare }) => {
      setCameraId(camera.id);

      const appBaseUrl = getAppBaseUrl();
      const resolvedShareUrl = nextShare
        ? nextShare.replace(/^https?:\/\/cam\.lensmann\.studio/i, appBaseUrl)
        : `${appBaseUrl}/watch/${camera.id}`;

      setShareUrl(resolvedShareUrl);
      setIsRegistered(true);
      setCameraStatus('online');
      socket.emit('camera:start');
      reportCameraTelemetry();
    });

    socket.on('camera:status', ({ status }) => {
      if (status === 'live' || status === 'online' || status === 'offline') {
        setCameraStatus(status);
      }
    });

    socket.on('camera:error', ({ message }) => {
      setErrorMessage(message);
      setCameraStatus('offline');
    });

    socket.on('camera:command', async ({ command }) => {
      if (command === 'start') {
        const started = await startLocalPreview();
        if (started) {
          socket.emit('camera:start');
        }
      } else if (command === 'stop') {
        stopLocalPreview();
      } else if (command === 'remove') {
        stopLocalPreview();
        socket.disconnect();
      }
    });

    socket.on('viewer:joined', async ({ viewerId }) => {
      if (!streamRef.current) {
        return;
      }

      closePeerConnection();
      const peerConnection = new RTCPeerConnection({ iceServers: stunServers });
      peerConnectionRef.current = peerConnection;

      streamRef.current.getTracks().forEach((track) => {
        peerConnection.addTrack(track, streamRef.current as MediaStream);
      });

      peerConnection.getSenders().forEach((sender) => {
        if (sender.track?.kind !== 'video') {
          return;
        }

        const parameters = sender.getParameters();
        parameters.encodings = parameters.encodings.length > 0 ? parameters.encodings : [{}];
        parameters.encodings.forEach((encoding) => {
          encoding.maxBitrate = streamQualityProfiles[streamQualityRef.current].bitrate;
          encoding.maxFramerate = streamQualityProfiles[streamQualityRef.current].fps;
        });
        sender.setParameters(parameters).catch(() => undefined);
      });

      peerConnection.onicecandidate = ({ candidate }) => {
        if (candidate) {
          socket.emit('signal:ice-candidate', {
            to: viewerId,
            candidate,
          });
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
          setConnectionState('connected');
        } else if (peerConnection.connectionState === 'connecting') {
          setConnectionState('connecting');
        } else if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
          setConnectionState('offline');
        }
      };

      try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal:offer', {
          to: viewerId,
          offer,
        });
        setConnectionState('connecting');
      } catch (error) {
        console.error('Kunne ikke opprette WebRTC-offer:', error);
        setErrorMessage('Kunne ikke starte WebRTC-koblingen.');
      }
    });

    socket.on('signal:answer', async ({ answer }) => {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection || !answer) {
        return;
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      setConnectionState('connected');
    });

    socket.on('signal:ice-candidate', async ({ candidate }) => {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection || !candidate) {
        return;
      }

      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('Kunne ikke legge til ICE-kandidat:', error);
      }
    });

    return () => {
      closePeerConnection();
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    async function enumerateDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) {
        return;
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setVideoDevices(devices.filter((device) => device.kind === 'videoinput'));
        setAudioDevices(devices.filter((device) => device.kind === 'audioinput'));
      } catch (error) {
        console.error('Kunne ikke lese enheter:', error);
      }
    }

    enumerateDevices();
  }, []);

  useEffect(() => {
    if (!cameraId || !shareUrl) {
      return;
    }

    QRCode.toDataURL(shareUrl)
      .then((url: string) => setQrCode(url))
      .catch((error: unknown) => {
        console.error('Kunne ikke generere QR-kode:', error);
      });
  }, [cameraId, shareUrl]);

  useEffect(() => {
    return () => {
      releaseScreenWakeLock();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  async function startLocalPreview(): Promise<boolean> {
    if (!navigator.mediaDevices?.getUserMedia) {
      if (!window.isSecureContext) {
        setErrorMessage('Kamera og mikrofon krever HTTPS på iPhone. Åpne appen via en HTTPS-adresse, ikke vanlig http:// på lokalnettet.');
      } else {
        setErrorMessage('Denne nettleseren eller enheten støtter ikke kamera og mikrofon.');
      }
      return false;
    }

    try {
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: streamQualityProfiles[streamQuality].width },
        height: { ideal: streamQualityProfiles[streamQuality].height },
        frameRate: { ideal: streamQualityProfiles[streamQuality].fps, max: streamQualityProfiles[streamQuality].fps },
        facingMode: cameraFacing === 'environment' ? 'environment' : 'user',
      };

      if (selectedVideoDevice) {
        videoConstraints.deviceId = { exact: selectedVideoDevice };
      }

      const audioConstraints: MediaTrackConstraints | boolean = micEnabled
        ? {
            deviceId: selectedAudioDevice ? { exact: selectedAudioDevice } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
          }
        : false;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: audioConstraints,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => undefined);
      }

      streamRef.current = stream;
      setPreviewReady(true);
      setCameraStatus('online');
      setErrorMessage('');
      return true;
    } catch (error) {
      console.error('Kunne ikke starte kamera:', error);
      const errorName = error instanceof DOMException ? error.name : '';
      if (errorName === 'NotAllowedError' || errorName === 'SecurityError') {
        setErrorMessage('Safari blokkerte kamera eller mikrofon. Bruk HTTPS og tillat tilgang i Innstillinger > Safari > Kamera og Mikrofon.');
      } else {
        setErrorMessage('Kunne ikke få tilgang til kamera eller mikrofon. Sjekk tillatelser og prøv igjen.');
      }
      return false;
    }
  }

  async function reportCameraTelemetry() {
    const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
    const batteryApi = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
    const battery = batteryApi.getBattery ? await batteryApi.getBattery().catch(() => undefined) : undefined;
    socketRef.current?.emit('camera:update-status', {
      batteryLevel: battery ? Math.round(battery.level * 100) : undefined,
      networkType: connection?.effectiveType ?? 'Ukjent nettverk',
      quality: streamQualityProfiles[streamQuality].label,
    });
  }

  function stopLocalPreview() {
    closePeerConnection();
    releaseScreenWakeLock();

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    if (socketRef.current && isRegistered) {
      socketRef.current.emit('camera:stop');
    }

    setPreviewReady(false);
    setConnectionState('offline');
    setCameraStatus('offline');
  }

  async function handleStartStreaming() {
    if (!socketReady) {
      setErrorMessage('Tjeneren er ikke tilgjengelig. Prøv igjen senere.');
      return;
    }

    const previewStarted = await startLocalPreview();
    if (!previewStarted) {
      return;
    }

    if (!isRegistered) {
      socketRef.current?.emit('camera:register', {
        name: cameraName.trim() || 'Kamera',
        type: 'browser',
        deviceKey: getDeviceKey(),
      });
      return;
    }

    socketRef.current?.emit('camera:start');
    setCameraStatus('live');
  }

  return (
    <>
      <header className="site-header">
        <div className="nav-row">
          <Link className="logo" to="/">
            <img src="/favicon/favicon.svg" alt="Lænsmann Camera logo" className="logo-badge" />
            <span className="logo-text">Lænsmann Camera</span>
          </Link>

          <nav className="site-nav" aria-label="Primær navigasjon">
            <Link to="/">Hjem</Link>
            <Link to="/camera">Kamera</Link>
            <Link className="btn btn-secondary" to="/watch/server">Serverkamera</Link>
          </nav>
        </div>
      </header>

      <main className="page-shell narrow">
        <header className="header-bar compact">
          <div>
            <p className="eyebrow">Kamera</p>
            <h1>Start live-feed</h1>
          </div>
          <Link className="btn btn-ghost" to="/">
            TILBAKE
          </Link>
        </header>

        <section className="panel-grid">
          <div className="panel">
            <label>
              <span>Kamera</span>
              <select value={cameraFacing} onChange={(event) => setCameraFacing(event.target.value as 'user' | 'environment')}>
                <option value="environment">Bakre kamera</option>
                <option value="user">Foran kamera</option>
              </select>
            </label>

            <label>
              <span>Streaming-kvalitet</span>
              <select value={streamQuality} onChange={(event) => setStreamQuality(event.target.value as StreamQuality)}>
                {Object.entries(streamQualityProfiles).map(([value, profile]) => (
                  <option key={value} value={value}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Navn</span>
              <input value={cameraName} onChange={(event) => setCameraName(event.target.value)} placeholder="Garasje" />
            </label>

            <label>
              <span>Videokamera</span>
              <select value={selectedVideoDevice} onChange={(event) => setSelectedVideoDevice(event.target.value)}>
                <option value="">Automatisk</option>
                {videoDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Kamera'}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Mikrofon</span>
              <select value={selectedAudioDevice} onChange={(event) => setSelectedAudioDevice(event.target.value)}>
                <option value="">Automatisk</option>
                {audioDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Mikrofon'}
                  </option>
                ))}
              </select>
            </label>

            <label className="toggle-row">
              <span>Ta opp mikrofon</span>
              <input type="checkbox" checked={micEnabled} onChange={(event) => setMicEnabled(event.target.checked)} />
            </label>

            <div className="inline-row double">
              <button className="btn btn-primary wide" onClick={handleStartStreaming}>
                {cameraStatus === 'live' ? 'START PÅ NYTT' : 'START LIVE'}
              </button>
              <button className="btn btn-ghost wide" onClick={stopLocalPreview}>
                STOPP
              </button>
            </div>

            <div className="meta-box">
              <p>Status</p>
              <strong>
                {connectionState === 'connected' ? 'LIVE' : connectionState === 'connecting' ? 'TILKOBLER' : cameraStatus === 'live' ? 'LIVE' : cameraStatus === 'online' ? 'TILKOBLET' : 'OFFLINE'}
              </strong>
            </div>

            {errorMessage && <div className="error-box">{errorMessage}</div>}
          </div>

          <div className="panel preview-panel">
            <div className="preview-box">
              {previewReady ? (
                <video ref={videoRef} autoPlay muted playsInline className="live-video" />
              ) : (
                <div className="preview-overlay">Lokal forhåndsvisning</div>
              )}
            </div>

            <div className="meta-box">
              <p>Kamera-ID</p>
              <strong>{cameraId || 'CAM-XXXXXX'}</strong>
            </div>

            <div className="meta-box">
              <p>Delingslenke</p>
              <strong>{shareUrl}</strong>
            </div>

            <div className="qr-box">
              {qrCode ? <img src={qrCode} alt="QR-kode for delingslenken" className="qr-image" /> : 'QR'}
            </div>
          </div>
        </section>
      </main>
    </>
  );
}

function ViewerPage() {
  const { cameraId } = useParams();
  const resolvedId = cameraId ?? 'CAM-AB12CD';
  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraName, setCameraName] = useState('Garasje');
  const [cameraStatus, setCameraStatus] = useState<'live' | 'offline'>('live');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const closePeerConnection = () => {
    if (!peerConnectionRef.current) {
      return;
    }

    peerConnectionRef.current.onicecandidate = null;
    peerConnectionRef.current.ontrack = null;
    peerConnectionRef.current.onconnectionstatechange = null;
    peerConnectionRef.current.close();
    peerConnectionRef.current = null;
  };

  useEffect(() => {
    const socket = createSocket();

    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('viewer:join', { cameraId: resolvedId });
    });

    socket.on('connect_error', () => {
      setErrorMessage('Kobling til kameratjeneren feilet. Prøver igjen…');
    });

    socket.on('viewer:joined', ({ camera }) => {
      setCameraName(camera?.name ?? 'Garasje');
      setConnectionStatus('connecting');
    });

    socket.on('camera:status', ({ status }) => {
      setCameraStatus(status === 'live' ? 'live' : 'offline');
    });

    socket.on('viewer:error', ({ message }) => {
      setErrorMessage(message);
      setConnectionStatus('offline');
    });

    socket.on('signal:offer', async ({ from, offer }) => {
      const peerConnection = new RTCPeerConnection({ iceServers: stunServers });
      peerConnectionRef.current = peerConnection;

      peerConnection.ontrack = (event) => {
        if (event.streams.length > 0) {
          const stream = event.streams[0];
          setRemoteStream(stream);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => undefined);
          }
        }
      };

      peerConnection.onicecandidate = ({ candidate }) => {
        if (candidate) {
          socket.emit('signal:ice-candidate', {
            to: from,
            candidate,
          });
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
          setConnectionStatus('connected');
        } else if (peerConnection.connectionState === 'connecting') {
          setConnectionStatus('connecting');
        } else if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
          setConnectionStatus('offline');
        }
      };

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal:answer', {
        to: from,
        answer,
      });
    });

    socket.on('signal:ice-candidate', async ({ candidate }) => {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection || !candidate) {
        return;
      }

      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('Kunne ikke legge til ICE-kandidat i viewer:', error);
      }
    });

    return () => {
      closePeerConnection();
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      socket.disconnect();
    };
  }, [resolvedId]);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }

    videoRef.current.muted = isMuted;
    if (remoteStream) {
      videoRef.current.srcObject = remoteStream;
    }
  }, [isMuted, remoteStream]);

  const isOffline = cameraStatus === 'offline';

  function toggleTorch() {
    const nextValue = !torchEnabled;
    setTorchEnabled(nextValue);
    socketRef.current?.emit('camera:command', {
      cameraId: resolvedId,
      command: 'torch',
      enabled: nextValue,
    });
  }

  return (
    <>
      <header className="site-header">
        <div className="nav-row">
          <Link className="logo" to="/">
            <img src="/favicon/favicon.svg" alt="Lænsmann Camera logo" className="logo-badge" />
            <span className="logo-text">Lænsmann Camera</span>
          </Link>

          <nav className="site-nav" aria-label="Primær navigasjon">
            <Link to="/">Hjem</Link>
            <Link to="/camera">Kamera</Link>
            <Link className="btn btn-secondary" to="/watch/server">Serverkamera</Link>
          </nav>
        </div>
      </header>

      <main className="page-shell narrow viewer-shell">
        <header className="header-bar compact">
          <div>
            <p className="eyebrow">Seer</p>
            <h1>{isOffline ? 'OFFLINE' : cameraName.toUpperCase()}</h1>
          </div>
          <div className="viewer-actions">
            <button className="btn btn-ghost" onClick={() => setIsMuted((value) => !value)}>
              {isMuted ? '🔊 Lyd på' : '🔊 Stum'}
            </button>
            <button className="btn btn-ghost" onClick={toggleTorch} disabled={isOffline}>
              {torchEnabled ? 'Lommelykt av' : 'Lommelykt på'}
            </button>
            <button className="btn btn-ghost" onClick={() => {
              const video = videoRef.current;
              if (!video) {
                return;
              }
              if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => undefined);
              } else {
                video.requestFullscreen().catch(() => undefined);
              }
            }}>
              ⛶ Fullscreen
            </button>
          </div>
        </header>

        <section className="viewer-card">
          <div className={`video-stage ${isOffline ? 'offline' : ''}`}>
            {remoteStream ? (
              <video ref={videoRef} autoPlay playsInline muted={isMuted} className="live-video" />
            ) : isOffline ? (
              'Kameraet er offline'
            ) : (
              'Venter på live video…'
            )}
          </div>

          <div className="viewer-status-row">
            <span className={`status-dot ${isOffline ? 'offline' : 'live'}`} />
            <span>{isOffline ? 'OFFLINE' : '🟢 LIVE'}</span>
            <span className="muted-text">Tilkoblingsstatus: {connectionStatus}</span>
          </div>

          <div className="viewer-meta">
            <div>
              <p>Kamera</p>
              <strong>{cameraName}</strong>
            </div>
            <div>
              <p>Lyd</p>
              <strong>{isMuted ? 'Muted' : 'På'}</strong>
            </div>
          </div>

          {errorMessage && <div className="error-box">{errorMessage}</div>}

          {!cameraId && (
            <div className="join-box">
              <input defaultValue={resolvedId} />
              <Link className="btn btn-primary" to={`/watch/${resolvedId}`}>
                SE KAMERA
              </Link>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

function ServerCameraPage() {
  return (
    <>
      <header className="site-header"><div className="nav-row"><Link className="logo" to="/"><img src="/favicon/favicon.svg" alt="Læns­mann Camera logo" className="logo-badge" /><span className="logo-text">Læns­mann Camera</span></Link><nav className="site-nav" aria-label="Primær navigasjon"><Link to="/">Hjem</Link><Link to="/camera">Kamera</Link></nav></div></header>
      <main className="page-shell narrow viewer-shell">
        <header className="header-bar compact"><div><p className="eyebrow">SERVERKAMERA</p><h1>LIVE FRA USB-KAMERA</h1></div><Link className="btn btn-ghost" to="/">TILBAKE</Link></header>
        <ServerCameraPreview large />
      </main>
    </>
  );
}

function LoginGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(() => localStorage.getItem('camls-authenticated') === 'true');
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);

  const pressKey = (key: string) => {
    if (pin.length < 4) {
      setPin((current) => current + key);
      setError(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pin === '1706') {
      localStorage.setItem('camls-authenticated', 'true');
      setAuthenticated(true);
      return;
    }
    setPin('');
    setError(true);
  };

  if (authenticated) return <>{children}</>;

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <p className="eyebrow">LÆNSMANN CAMERA</p>
        <h1>Logg inn</h1>
        <p className="muted-text">Skriv inn PIN-koden for å se kameraet.</p>
        <input
          className="login-pin"
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
          autoFocus
          aria-label="PIN-kode"
        />
        <div className="keypad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => (
            <button type="button" key={key} onClick={() => pressKey(key)}>{key}</button>
          ))}
          <button type="button" onClick={() => setPin('')}>C</button>
          <button type="button" onClick={() => pressKey('0')}>0</button>
          <button type="submit">OK</button>
        </div>
        {error && <p className="login-error">Feil PIN-kode</p>}
      </form>
    </main>
  );
}

export default function App() {
  return (
    <LoginGate>
      <BrowserRouter>
        <div className="app-frame">
          <div className="app-content">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/camera" element={<CameraPage />} />
              <Route path="/watch" element={<ViewerPage />} />
              <Route path="/watch/server" element={<ServerCameraPage />} />
              <Route path="/watch/:cameraId" element={<ViewerPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
          <SiteFooter />
        </div>
      </BrowserRouter>
    </LoginGate>
  );
}
