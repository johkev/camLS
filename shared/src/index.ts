export type CameraType = 'browser' | 'android';

export type CameraStatus = 'offline' | 'online' | 'live';

export interface CameraMetadata {
  id: string;
  name: string;
  type: CameraType;
  status: CameraStatus;
  createdAt: string;
  lastSeen: string;
  viewerCount: number;
}

export interface SignalingMessage {
  type: 'hello' | 'offer' | 'answer' | 'ice-candidate' | 'join' | 'leave';
  cameraId?: string;
  viewerId?: string;
  payload?: unknown;
}
