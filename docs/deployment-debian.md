# Debian deployment

The deployment hostname is `cam.lensmann.studio`.

## 1. Server packages

```bash
sudo apt update
sudo apt install -y apache2 ca-certificates curl git ffmpeg v4l-utils
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## 2. Application user and source

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin camls
sudo usermod -aG video,audio camls
sudo mkdir -p /opt/lensmann-camera
sudo chown -R camls:camls /opt/lensmann-camera
sudo -u camls git clone https://github.com/johkev/camLS.git /opt/lensmann-camera
cd /opt/lensmann-camera
sudo -u camls npm ci
sudo -u camls npm run build
sudo mkdir -p /var/www/lensmann-camera
sudo rsync -a --delete frontend/dist/ /var/www/lensmann-camera/frontend/
```

## 3. WebRTC gateway

MediaMTX turns the local H.264 and Opus feed into WebRTC. Install the current
AMD64 release once, then copy this repository's configuration and service:

```bash
cd /tmp
curl -LO https://github.com/bluenviron/mediamtx/releases/download/v1.21.3/mediamtx_v1.21.3_linux_amd64.tar.gz
tar -xzf mediamtx_v1.21.3_linux_amd64.tar.gz
sudo install -d -o camls -g camls /opt/mediamtx /etc/mediamtx
sudo install -o camls -g camls mediamtx /opt/mediamtx/mediamtx
sudo cp /opt/lensmann-camera/deploy/mediamtx/mediamtx.yml /etc/mediamtx/mediamtx.yml
sudo cp /opt/lensmann-camera/deploy/systemd/mediamtx.service /etc/systemd/system/mediamtx.service
sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx
```

## 4. Backend service

Copy `deploy/systemd/lensmann-camera.service` to `/etc/systemd/system/`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lensmann-camera
sudo systemctl status lensmann-camera
```

The backend captures the server USB camera directly with FFmpeg at 1280x720,
60 FPS and sends H.264 video plus Opus audio into MediaMTX. MediaMTX then
delivers the feed with WebRTC at `/live/server/whep`. The microphone defaults to
the ALSA `default` device. If the webcam microphone is not the default device,
run `arecord -l`, then set `SERVER_CAMERA_AUDIO_DEVICE` in the systemd service
to the webcam's ALSA device (for example `hw:1,0`). Use `v4l2-ctl --list-devices`
to find another video device.

## 5. Apache

Copy `deploy/apache/lensmann-camera.conf` to `/etc/apache2/sites-available/`, then enable
the required modules and site:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers ssl
sudo a2ensite lensmann-camera.conf
sudo a2dissite 000-default.conf
sudo apache2ctl configtest
sudo systemctl reload apache2
```

## 6. Cloudflare, UDP and HTTPS

Keep the existing `cam.lensmann.studio` record and HTTPS setup. Create a second
`A` record, `webrtc.cam.lensmann.studio`, pointing to the homelab IP and set only
that record to **DNS only** (grey cloud). Forward UDP port `8189` in the router
to the homelab and allow UDP `8189` in the firewall. Cloudflare's ordinary HTTP
proxy does not forward WebRTC UDP media. Camera access from iPhone requires HTTPS.

After HTTPS is active, update the Apache virtual host to `*:443` with the certificate
paths and redirect port 80 to HTTPS.

## 7. Logs and updates

```bash
sudo journalctl -u lensmann-camera -f
sudo tail -f /var/log/apache2/lensmann-camera-error.log
cd /opt/lensmann-camera
sudo -u camls git pull
sudo -u camls npm ci
sudo -u camls npm run build
sudo rsync -a --delete frontend/dist/ /var/www/lensmann-camera/frontend/
sudo systemctl restart lensmann-camera
```

For a normal code update after initial setup, the short version is:

```bash
cd /opt/lensmann-camera
sudo -u camls git pull --ff-only origin main
sudo -u camls npm run build
sudo rsync -a --delete frontend/dist/ /var/www/lensmann-camera/frontend/
sudo systemctl restart mediamtx lensmann-camera
```
