require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const driveRoute = require('./routes/drive');
const payRoute   = require('./routes/payment');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5500',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Health check ─────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────
app.use('/api/drive',   driveRoute);
app.use('/api/payment', payRoute);

// ── 404 handler ──────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Error handler ─────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🖨  PrintPoint backend running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});
