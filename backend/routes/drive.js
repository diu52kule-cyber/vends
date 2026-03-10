/**
 * routes/drive.js
 *
 * Proxies Google Drive API calls so the access_token
 * never needs to be exposed beyond the frontend ↔ backend channel.
 *
 * All endpoints require the caller to pass:
 *   Authorization: Bearer <google_access_token>
 *
 * Endpoints:
 *   GET  /api/drive/files          – list printable files
 *   GET  /api/drive/files/search   – search by name
 *   GET  /api/drive/download/:id   – stream file bytes to frontend
 */

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

// ── Helper: extract Bearer token ─────────────────
function getToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

// ── Helper: forward Drive error ──────────────────
function driveErr(res, err) {
  const status = err?.response?.status || 502;
  const msg    = err?.response?.data?.error?.message || err.message || 'Drive API error';
  console.error('[Drive]', status, msg);
  res.status(status).json({ error: msg });
}

// ── Printable MIME types ──────────────────────────
const PRINTABLE_MIMES = [
  "mimeType='application/pdf'",
  "mimeType='image/jpeg'",
  "mimeType='image/png'",
  "mimeType='image/webp'",
].join(' or ');

// ─────────────────────────────────────────────────
// GET /api/drive/files
// Query params: q (optional text filter)
// ─────────────────────────────────────────────────
router.get('/files', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Missing Google access token' });

  const textQ = req.query.q ? `name contains '${req.query.q}' and ` : '';
  const query = `${textQ}(${PRINTABLE_MIMES}) and trashed=false`;

  try {
    const { data } = await axios.get(`${DRIVE_BASE}/files`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        q: query,
        fields: 'files(id,name,mimeType,size,modifiedTime,thumbnailLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 50,
      },
    });
    res.json(data);
  } catch (err) {
    driveErr(res, err);
  }
});

// ─────────────────────────────────────────────────
// GET /api/drive/download/:fileId
// Streams the raw file bytes back to the frontend
// For Google Docs → exports as PDF automatically
// ─────────────────────────────────────────────────
router.get('/download/:fileId', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Missing Google access token' });

  const { fileId } = req.params;

  try {
    // First get file metadata to check mimeType
    const { data: meta } = await axios.get(`${DRIVE_BASE}/files/${fileId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params:  { fields: 'name,mimeType,size' },
    });

    let downloadUrl;
    let contentType = meta.mimeType;

    // Google Docs / Sheets / Slides → export as PDF
    if (meta.mimeType.startsWith('application/vnd.google-apps')) {
      downloadUrl = `${DRIVE_BASE}/files/${fileId}/export?mimeType=application/pdf`;
      contentType = 'application/pdf';
    } else {
      downloadUrl = `${DRIVE_BASE}/files/${fileId}?alt=media`;
    }

    const fileRes = await axios.get(downloadUrl, {
      headers:      { Authorization: `Bearer ${token}` },
      responseType: 'stream',
    });

    // Forward content-type + name as header so frontend knows what it got
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-File-Name', encodeURIComponent(meta.name));
    if (meta.size) res.setHeader('Content-Length', meta.size);

    fileRes.data.pipe(res);
  } catch (err) {
    driveErr(res, err);
  }
});

module.exports = router;
