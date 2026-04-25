const express = require('express');
const path = require('path');
const XLSX = require('xlsx');
const { omitTestStationRows } = require('./stationFilters');

/**
 * @param {object[]} stations
 * @returns {{ id: string, title: string, latitude: number, longitude: number }[]}
 */
/**
 * @param {object[]} stations
 * @param {string[]} [omitStationIds] Raw station `id` values to exclude from routing.
 */
function stationsToRouteLocations(stations, omitStationIds) {
  const omit = new Set(
    Array.isArray(omitStationIds)
      ? omitStationIds.map((x) => String(x).trim()).filter(Boolean)
      : [],
  );
  const out = [];
  for (const s of stations) {
    if (s == null || typeof s !== 'object') {
      continue;
    }
    const id = String(s.id ?? '').trim();
    if (!id || omit.has(id)) {
      continue;
    }
    const lat = Number(s.latitude);
    const lon = Number(s.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    out.push({
      id: `st-${id}`,
      title: String(s.title || '').trim() || id,
      latitude: lat,
      longitude: lon,
    });
  }
  return out;
}

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

/**
 * Coerce `task` for upstream: some APIs expect one enum string; we send an array from the UI.
 * Single-element array → string unless CUUB_TICKETS_TASK_ALWAYS_ARRAY=1.
 * @param {Record<string, unknown>|null|undefined} body
 */
function normalizeTicketTaskForUpstream(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const out = { ...body };
  if (out.task == null) {
    return out;
  }
  const alwaysArray =
    process.env.CUUB_TICKETS_TASK_ALWAYS_ARRAY === '1' ||
    process.env.CUUB_TICKETS_TASK_ALWAYS_ARRAY === 'true';
  if (Array.isArray(out.task)) {
    const arr = out.task.map((t) => String(t).trim()).filter(Boolean);
    if (arr.length === 0) {
      delete out.task;
      return out;
    }
    if (!alwaysArray && arr.length === 1) {
      out.task = arr[0];
    } else {
      out.task = arr;
    }
    return out;
  }
  out.task = String(out.task).trim();
  return out;
}

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
    const payload = normalizeTicketTaskForUpstream(req.body || {});
    const r = await fetch(CUUB_TICKETS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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

app.patch('/api/tickets/:id', async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    const payload = normalizeTicketTaskForUpstream(req.body || {});
    const r = await fetch(`${CUUB_TICKETS_API_URL}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
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

/**
 * Full-network driving route from a chosen start; optional `omitStationIds` excludes stations.
 * Mapbox Matrix allows a limited number of coordinates per request (see MAPBOX_MATRIX_MAX_COORDINATES in routeOptimization.js).
 */
app.post('/api/network-route-export', async (req, res) => {
  try {
    const { optimizeDrivingRoute, MAPBOX_MATRIX_MAX_COORDINATES } = require('./routeOptimization');
    const body = req.body || {};
    const sl = body.startingLocation || body.start || {};
    const name = String(sl.name || sl.title || '').trim();
    const lat = Number(sl.latitude);
    const lon = Number(sl.longitude);
    if (!name) {
      return res.status(400).json({ error: 'Starting location name is required.' });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'Valid starting latitude and longitude are required.' });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ error: 'Starting coordinates are out of range.' });
    }

    const stationsRes = await fetch('https://api.cuub.tech/stations');
    const stationsData = await stationsRes.json().catch(() => ({}));
    if (!stationsData.success || !Array.isArray(stationsData.data)) {
      return res.status(502).json({ error: 'Could not load stations from the API.' });
    }
    const stations = omitTestStationRows(stationsData.data);
    const omitStationIds = Array.isArray(body.omitStationIds)
      ? body.omitStationIds.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const stationLocs = stationsToRouteLocations(stations, omitStationIds);
    const startLoc = {
      id: 'network-route-start',
      title: name,
      latitude: lat,
      longitude: lon,
    };
    const locations = [startLoc, ...stationLocs];
    if (locations.length > MAPBOX_MATRIX_MAX_COORDINATES) {
      return res.status(400).json({
        error: `Too many stops (${locations.length}). Mapbox allows at most ${MAPBOX_MATRIX_MAX_COORDINATES} coordinates (1 start + up to ${MAPBOX_MATRIX_MAX_COORDINATES - 1} stations). Omit more stations and try again.`,
      });
    }
    if (locations.length < 2) {
      return res.status(400).json({
        error:
          'No stations left to route after omissions (need at least one station with coordinates besides the start).',
      });
    }

    const result = await optimizeDrivingRoute(locations);
    const aoa = [['Location name'], ...result.orderedStops.map((stop) => [stop.title])];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'Route');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `network-route-${dateStr}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
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
    telegramBot.scheduleTokenHealthAlerts();
  }, 32000);

  setTimeout(() => {
    telegramBot.startTelegramCommandPolling();
  }, 35000);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
