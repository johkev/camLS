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
sudo usermod -aG video camls
sudo mkdir -p /opt/lensmann-camera
sudo chown -R camls:camls /opt/lensmann-camera
sudo -u camls git clone https://github.com/johkev/camLS.git /opt/lensmann-camera
cd /opt/lensmann-camera
sudo -u camls npm ci
sudo -u camls npm run build
sudo mkdir -p /var/www/lensmann-camera
sudo rsync -a --delete frontend/dist/ /var/www/lensmann-camera/frontend/
```

## 3. Backend service

Copy `deploy/systemd/lensmann-camera.service` to `/etc/systemd/system/`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lensmann-camera
sudo systemctl status lensmann-camera
```

The backend captures the server USB camera directly with FFmpeg. It defaults to
`/dev/video0`, 1920x1080 at 30 FPS, and publishes an MJPEG stream at
`/api/server-camera.mjpeg`. If the camera uses another device, set
`SERVER_CAMERA_DEVICE` in the systemd service. Use `v4l2-ctl --list-devices` to
find the correct device name. Restart the service after changing these values.

## 4. Apache

Copy `deploy/apache/lensmann-camera.conf` to `/etc/apache2/sites-available/`, then enable
the required modules and site:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers ssl
sudo a2ensite lensmann-camera.conf
sudo a2dissite 000-default.conf
sudo apache2ctl configtest
sudo systemctl reload apache2
```

## 5. Cloudflare and HTTPS

Create an `A` record for `CAMERA_DOMAIN` pointing to the server IP and enable the
Cloudflare proxy. Use Cloudflare's **Full (strict)** SSL mode with a Cloudflare
Origin Certificate installed in Apache, or use Certbot on the server. Camera access
from iPhone requires HTTPS.

After HTTPS is active, update the Apache virtual host to `*:443` with the certificate
paths and redirect port 80 to HTTPS.

## 6. Logs and updates

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
