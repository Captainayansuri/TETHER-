const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const logger = require('./logger');
const { resolveExistingCapturePath } = require('./capture-files');
const { inspectImageFile } = require('./image-storage');
const { IMAGE_TYPES } = require('./image-upload');

function createHttpApp({
  mobileStaticPath,
  localIP,
  getPort,
  capturesDirectory,
  captureAccessToken,
  thumbnailCache
}) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), microphone=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    next();
  });

  app.use('/mobile', express.static(path.resolve(mobileStaticPath), {
    dotfiles: 'deny',
    fallthrough: true,
    index: ['index.html'],
    redirect: true
  }));

  app.get('/status', (req, res) => {
    res.json({ status: 'online', ip: localIP, port: getPort() });
  });

  app.get('/_desktop/captures/:filename', async (req, res, next) => {
    try {
      const tokenValue = typeof req.query.key === 'string' ? req.query.key : '';
      const providedToken = Buffer.from(tokenValue, 'utf8');
      const expectedToken = Buffer.from(captureAccessToken || '', 'utf8');
      const address = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const isLoopback = address === '127.0.0.1' || address === '::1';
      if (!captureAccessToken ||
          providedToken.length !== expectedToken.length ||
          !crypto.timingSafeEqual(providedToken, expectedToken) ||
          !isLoopback) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (typeof req.params.filename !== 'string' ||
          !/^capture_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i.test(req.params.filename)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const imagePath = await resolveExistingCapturePath(capturesDirectory, req.params.filename);
      if (!imagePath) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const captureId = req.params.filename.slice('capture_'.length).replace(/\.(?:jpg|png|webp)$/i, '');
      const metadataPath = path.join(capturesDirectory, `.capture_${captureId}.json`);
      let metadata;
      try {
        metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'));
      } catch {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const inspected = await inspectImageFile(fs.promises, imagePath);
      const isMetadataObject = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata);
      const imageType = isMetadataObject ? IMAGE_TYPES[metadata.imageType] : null;
      if (!isMetadataObject ||
          metadata.version !== 1 ||
          typeof metadata.captureId !== 'string' ||
          metadata.captureId.toLowerCase() !== captureId.toLowerCase() ||
          !imageType ||
          req.params.filename.toLowerCase() !== `capture_${captureId}.${imageType.extension}`.toLowerCase() ||
          metadata.size !== inspected.size ||
          metadata.sha256 !== inspected.sha256 ||
          metadata.imageType !== inspected.imageType) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const variant = req.query.variant || 'thumbnail';
      let sourcePath = imagePath;
      let contentType = imageType.mimeType;
      let cacheControl = 'private, no-store';
      if (variant === 'thumbnail') {
        if (!thumbnailCache) throw new Error('Thumbnail cache is unavailable');
        sourcePath = await thumbnailCache.get({
          captureId,
          sha256: inspected.sha256,
          imagePath
        });
        const thumbnailStats = await fs.promises.lstat(sourcePath);
        const [realDirectory, realThumbnail] = await Promise.all([
          fs.promises.realpath(capturesDirectory),
          fs.promises.realpath(sourcePath)
        ]);
        const relativeThumbnail = path.relative(realDirectory, realThumbnail);
        if (!thumbnailStats.isFile() ||
            thumbnailStats.isSymbolicLink() ||
            relativeThumbnail === '..' ||
            relativeThumbnail.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativeThumbnail)) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        sourcePath = realThumbnail;
        contentType = 'image/webp';
        cacheControl = 'private, max-age=86400, immutable';
      } else if (variant !== 'full') {
        res.status(400).json({ error: 'Invalid image variant' });
        return;
      }

      res.set({
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Cache-Control': cacheControl,
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff'
      });
      const stream = fs.createReadStream(sourcePath);
      stream.on('error', (error) => {
        if (!res.headersSent) next(error);
        else res.destroy(error);
      });
      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((error, req, res, next) => {
    logger.error('http.request_failed', {
      errorCode: error.code || error.name || 'UNKNOWN'
    });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(500).json({ error: 'Request failed' });
  });

  return app;
}

module.exports = { createHttpApp };
