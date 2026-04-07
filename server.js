const express = require('express');
const path = require('path');
const { omitTestStationRows } = require('./stationFilters');

require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/** Same JSON as Telegram’s `fetchStations` — avoids browser CORS to api.cuub.tech. */
app.get('/api/stations', async (req, res) => {
  try {
    const r = await fetch('https://api.cuub.tech/stations');
    if (!r.ok) {
      return res.status(r.status).json({ success: false, error: r.statusText });
    }
    const data = await r.json();
    if (data.success && Array.isArray(data.data)) {
      data.data = omitTestStationRows(data.data);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * Full tickets resource URL on api.cuub.tech (no trailing slash).
 * Override if your deployment uses another path (e.g. when GET /tickets returns 404).
 */
const CUUB_TICKETS_API_URL = (process.env.CUUB_TICKETS_API_URL || 'https://api.cuub.tech/tickets').replace(
  /\/$/,
  '',
);

/** Proxied tickets CRUD — avoids browser CORS to api.cuub.tech. */
app.get('/api/tickets', async (req, res) => {
  try {
    const r = await fetch(CUUB_TICKETS_API_URL);
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.post('/api/tickets', async (req, res) => {
  try {
    const r = await fetch(CUUB_TICKETS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.delete('/api/tickets/:id', async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    const r = await fetch(`${CUUB_TICKETS_API_URL}/${id}`, { method: 'DELETE' });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * Returns Mapbox nearest-neighbor route order for maintenance tickets (requires MAPBOX_ACCESS_TOKEN).
 */
app.post('/api/maintenance-route-order', async (req, res) => {
  try {
    const { optimizeDrivingRoute } = require('./routeOptimization');
    const { locations } = req.body || {};
    if (!locations || !Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty locations array' });
    }
    const result = await optimizeDrivingRoute(locations);
    res.json({
      orderedStationIds: result.orderedStops.map((s) => s.id),
      totalCompletionMinutes: result.totalCompletionMinutes,
      summary: result.summary,
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// ========================================
// TELEGRAM BOT SCHEDULERS
// ========================================

let telegramBot;
try {
  telegramBot = require('./telegram_bot');
  console.log('✅ Telegram bot module loaded successfully');
} catch (error) {
  console.error('❌ Error loading telegram bot module:', error);
  console.error('Telegram features will not be available');
}

if (telegramBot) {
  setTimeout(() => {
    telegramBot.scheduleDailyTelegramReport();
  }, 30000);

  setTimeout(() => {
    telegramBot.startTelegramCommandPolling();
  }, 35000);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
