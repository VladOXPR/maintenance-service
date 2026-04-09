/**
 * Maintenance tickets UI — data from the same source and slot-health rules as telegram_bot.js.
 * Keep getTotalSlotsForStation / getFilledSlotHealthLevel / filters in sync with telegram_bot.js.
 */

/** Proxied by server.js (same payload as https://api.cuub.tech/stations). */
const STATIONS_URL = '/api/stations';

/** Proxied by server.js → https://api.cuub.tech/tickets */
const TICKETS_URL = '/api/tickets';

/**
 * Prefer upstream error text; only then use a 404 hint (wrong proxy route vs wrong base URL).
 * @param {Response} res
 * @param {object} data
 * @param {'update' | 'create'} action
 */
function ticketsApiFailureMessage(res, data, action) {
  const raw = data && (data.error ?? data.message);
  if (raw != null && String(raw).trim() !== '') {
    return String(raw);
  }
  if (res.status === 404) {
    const patchHint =
      action === 'update'
        ? 'Restart the maintenance Node server after updating this repo so the proxy registers PATCH /api/tickets/:id. '
        : '';
    return (
      'Tickets API returned 404. ' +
      patchHint +
      'If the queue still loads, check CUUB_TICKETS_API_URL in server .env (full tickets base URL, no trailing slash, e.g. https://api.cuub.tech/tickets) and restart.'
    );
  }
  return `${action === 'update' ? 'Update' : 'Create'} failed (${res.status})`;
}

/** Same rule as `stationFilters.js` — exclude lab / bogus rows. */
function omitTestStationRows(stations) {
  if (!Array.isArray(stations)) {
    return stations;
  }
  return stations.filter((s) => String(s.title || '').trim().toUpperCase() !== 'TEST STATION');
}

/**
 * Default depot / route start (always index 0 in `routeOptimization.js`).
 * Civic Opera House area — 20 North Wacker Drive, Chicago, IL (~41.8818, -87.6374).
 * Override in the UI; persisted under {@link ROUTE_HOME_STORAGE_KEY}.
 */
const DEFAULT_ROUTE_HOME = Object.freeze({
  id: 'home-civic-opera',
  title: 'Civic Opera House — Home',
  latitude: 41.8818,
  longitude: -87.6374,
});

/** @type {string} */
const ROUTE_HOME_STORAGE_KEY = 'maintenance.routeHome.v1';

/** Fixed id for user-set start so it never collides with ticket ids. */
const CUSTOM_ROUTE_HOME_ID = 'route-start';

/**
 * @returns {{ id: string, title: string, latitude: number, longitude: number }}
 */
function getDefaultRouteHome() {
  return {
    id: DEFAULT_ROUTE_HOME.id,
    title: DEFAULT_ROUTE_HOME.title,
    latitude: DEFAULT_ROUTE_HOME.latitude,
    longitude: DEFAULT_ROUTE_HOME.longitude,
  };
}

/**
 * Effective route start for Mapbox optimization (default or user-saved).
 * @returns {{ id: string, title: string, latitude: number, longitude: number }}
 */
function getRouteHome() {
  try {
    const raw = localStorage.getItem(ROUTE_HOME_STORAGE_KEY);
    if (!raw) {
      return getDefaultRouteHome();
    }
    const o = JSON.parse(raw);
    const lat = parseCoord(o.latitude);
    const lon = parseCoord(o.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return getDefaultRouteHome();
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return getDefaultRouteHome();
    }
    const title = String(o.title || '').trim() || 'Starting Point';
    const id =
      typeof o.id === 'string' && o.id.trim() ? o.id.trim() : CUSTOM_ROUTE_HOME_ID;
    return { id, title, latitude: lat, longitude: lon };
  } catch {
    return getDefaultRouteHome();
  }
}

/**
 * @typedef {{
 *   id: string,
 *   stationId: string,
 *   stationName: string,
 *   latitude: number,
 *   longitude: number,
 *   serviceType: string,
 *   tasks?: string[],
 *   description?: string,
 *   color: 'red' | 'yellow',
 *   source: 'station-status' | 'database',
 *   sortOrder: number,
 *   dbId?: number,
 *   filledSlots?: number,
 *   totalSlots?: number
 * }} Ticket
 */

/** Must match Postgres `ticket_task` / `ticket_task[]` on api.cuub.tech. */
const TASK_TYPES = [
  'High Batteries',
  'Low Batteries',
  'No Batteries',
  'Add Stack',
  'Broken Battery',
  'High Failure Rates',
  'Hardware Malfunction',
  'Unusually Offline',
  'Other',
];

const RED_TASKS = new Set([
  'Low Batteries',
  'No Batteries',
  'Broken Battery',
  'Unusually Offline',
]);

/**
 * Remove one layer of surrounding single/double quotes (repeat while nested).
 * @param {string} s
 */
function stripOuterQuotes(s) {
  let t = s.trim();
  let prev = '';
  while (t !== prev) {
    prev = t;
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      t = t.slice(1, -1).trim();
      continue;
    }
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
      t = t.slice(1, -1).trim();
    }
  }
  return t;
}

/**
 * Strip Postgres/JSON cruft from one task label: `{}`, stray `"`, duplicated braces.
 * @param {string} raw
 */
function cleanTaskLabel(raw) {
  let t = stripOuterQuotes(String(raw ?? '').trim());
  t = t.replace(/^\{+/, '').replace(/\}+$/g, '');
  t = stripOuterQuotes(t);
  t = t.replace(/^"+|"+$/g, '');
  t = t.replace(/\{|\}/g, '');
  return t.trim();
}

/**
 * @param {string[]} parts
 * @returns {string[]}
 */
function normalizeTaskStringList(parts) {
  return parts.map((p) => cleanTaskLabel(p)).filter(Boolean);
}

/**
 * Split Postgres array literal body (inside `{`…`}`) into elements; supports quoted tokens.
 * @param {string} inner
 * @returns {string[]}
 */
function splitPostgresArrayElements(inner) {
  const parts = [];
  let i = 0;
  const str = inner.trim();
  while (i < str.length) {
    while (i < str.length && /\s/.test(str[i])) {
      i += 1;
    }
    if (i >= str.length) {
      break;
    }
    if (str[i] === '"') {
      i += 1;
      let buf = '';
      while (i < str.length) {
        if (str[i] === '\\' && i + 1 < str.length) {
          buf += str[i + 1];
          i += 2;
          continue;
        }
        if (str[i] === '"') {
          i += 1;
          break;
        }
        buf += str[i];
        i += 1;
      }
      parts.push(buf.trim());
      if (str[i] === ',') {
        i += 1;
      }
      continue;
    }
    const start = i;
    while (i < str.length && str[i] !== ',') {
      i += 1;
    }
    const chunk = str.slice(start, i).trim();
    if (chunk) {
      parts.push(chunk);
    }
    if (str[i] === ',') {
      i += 1;
    }
  }
  return parts.filter(Boolean);
}

/**
 * Normalize API `task` (JSON array, legacy string, or Postgres `{…}` text) to string[].
 * @param {unknown} taskField
 * @returns {string[]}
 */
function parseTaskFieldToStrings(taskField) {
  if (taskField == null) {
    return [];
  }
  if (Array.isArray(taskField)) {
    return normalizeTaskStringList(taskField.map((t) => String(t)));
  }
  let s = stripOuterQuotes(String(taskField).trim());
  if (!s) {
    return [];
  }
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return normalizeTaskStringList(parsed.map((t) => String(t)));
      }
    } catch (_) {
      /* fall through */
    }
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    return normalizeTaskStringList(splitPostgresArrayElements(s.slice(1, -1)));
  }
  if (s.startsWith('{')) {
    return normalizeTaskStringList([s.slice(1)]);
  }
  return normalizeTaskStringList([s]);
}

/**
 * Split comma-joined labels (common in raw Postgres/API text) into separate tasks.
 * @param {string[]} parts
 * @returns {string[]}
 */
function canonicalTaskLabels(parts) {
  if (!parts || !parts.length) {
    return [];
  }
  const out = [];
  for (const raw of parts) {
    const c = cleanTaskLabel(String(raw));
    if (!c) {
      continue;
    }
    if (c.includes(',')) {
      for (const piece of c.split(',')) {
        const x = cleanTaskLabel(piece);
        if (x) {
          out.push(x);
        }
      }
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * @param {string[]} tasks
 * @returns {string}
 */
function formatTasksDisplay(tasks) {
  return canonicalTaskLabels(tasks).join(' · ');
}

/**
 * @param {string[]} tasks
 * @returns {'red'|'yellow'}
 */
function tasksToColor(tasks) {
  const flat = canonicalTaskLabels(tasks);
  if (!flat.length) {
    return 'yellow';
  }
  for (const t of flat) {
    if (RED_TASKS.has(String(t))) {
      return 'red';
    }
  }
  return 'yellow';
}

/** All stations for Create Ticket dropdown (set in init). */
let allStationsForPicker = [];

/** Station id (string) → API row — used so `station_id` always matches the chosen name. */
let stationsById = new Map();

function rebuildStationsById() {
  stationsById = new Map();
  for (const s of allStationsForPicker) {
    if (s == null || s.id == null) {
      continue;
    }
    const id = String(s.id).trim();
    if (!id) {
      continue;
    }
    stationsById.set(id, s);
  }
}

function updateCreateStationHint() {
  const sel = document.getElementById('create-station');
  const hint = document.getElementById('create-station-id-hint');
  if (!hint) {
    return;
  }
  if (!sel || !sel.value.trim()) {
    hint.textContent = 'Choose a station — its ID is sent with the ticket.';
    return;
  }
  const sid = sel.value.trim();
  const st = stationsById.get(sid);
  const label = st && String(st.title || '').trim() ? st.title : sid;
  hint.textContent = `Using station ID ${sid} — ${label}`;
}

function getTotalSlotsForStation(station) {
  const filledSlots = station.filled_slots;
  const openSlots = station.open_slots;
  if (filledSlots !== null && filledSlots !== undefined && openSlots !== null && openSlots !== undefined) {
    const f = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : Number(filledSlots);
    const o = typeof openSlots === 'string' ? parseInt(openSlots, 10) : Number(openSlots);
    if (!isNaN(f) && !isNaN(o)) {
      return f + o;
    }
  }
  return 6;
}

/**
 * Capacity = filled / total. Red if empty (0%) or full (100%). Yellow if in (0%, 33%] (low fill).
 * Green if above 33% and below full. (Keep in sync with telegram_bot.js.)
 * @returns {'red'|'yellow'|'green'|null}
 */
function getFilledSlotHealthLevel(totalSlots, filledSlotsNum) {
  if (isNaN(filledSlotsNum) || isNaN(totalSlots) || totalSlots <= 0) {
    return null;
  }
  if (filledSlotsNum <= 0 || filledSlotsNum >= totalSlots) {
    return 'red';
  }
  const pctFull = filledSlotsNum / totalSlots;
  if (pctFull <= 1 / 3) {
    return 'yellow';
  }
  return 'green';
}

function getStationPriority(station) {
  const filledSlots = station.filled_slots;
  if (filledSlots === null || filledSlots === undefined || filledSlots === 'N/A') {
    return 4;
  }
  const filledSlotsNum = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : filledSlots;
  if (isNaN(filledSlotsNum)) {
    return 4;
  }
  const totalSlots = getTotalSlotsForStation(station);
  const level = getFilledSlotHealthLevel(totalSlots, filledSlotsNum);
  if (level === 'red') {
    return 1;
  }
  if (level === 'yellow') {
    return 2;
  }
  if (level === 'green') {
    return 3;
  }
  return 4;
}

/**
 * Same filter as Telegram “needs attention” list: red or yellow capacity only.
 * @param {object} station
 * @returns {{ ok: boolean, color?: 'red'|'yellow' }}
 */
function stationNeedsTicket(station) {
  const filledSlots = station.filled_slots;
  if (filledSlots === null || filledSlots === undefined || filledSlots === 'N/A') {
    return { ok: false };
  }
  const filledSlotsNum = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : filledSlots;
  if (isNaN(filledSlotsNum)) {
    return { ok: false };
  }
  const totalSlots = getTotalSlotsForStation(station);
  const level = getFilledSlotHealthLevel(totalSlots, filledSlotsNum);
  if (level === 'red' || level === 'yellow') {
    return { ok: true, color: level };
  }
  return { ok: false };
}

function parseCoord(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : NaN;
}

/** @param {object} station */
function parseFilledSlots(station) {
  const f = station.filled_slots;
  if (f === null || f === undefined || f === 'N/A') {
    return null;
  }
  const n = typeof f === 'string' ? parseInt(f, 10) : Number(f);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Ticket} ticket
 * @param {Map<string, object>} stationMap
 */
function enrichTicketSlotCounts(ticket, stationMap) {
  if (Number.isFinite(ticket.filledSlots) && Number.isFinite(ticket.totalSlots)) {
    return;
  }
  const st = stationMap.get(String(ticket.stationId).trim());
  if (!st) {
    return;
  }
  const filled = parseFilledSlots(st);
  if (filled === null) {
    return;
  }
  ticket.filledSlots = filled;
  ticket.totalSlots = getTotalSlotsForStation(st);
}

/**
 * @param {Ticket} ticket
 * @returns {string|null}
 */
function formatTicketSlotsLine(ticket) {
  if (Number.isFinite(ticket.filledSlots) && Number.isFinite(ticket.totalSlots)) {
    return `${ticket.filledSlots} / ${ticket.totalSlots}`;
  }
  const st = stationsById.get(String(ticket.stationId).trim());
  if (!st) {
    return null;
  }
  const filled = parseFilledSlots(st);
  if (filled === null) {
    return null;
  }
  return `${filled} / ${getTotalSlotsForStation(st)}`;
}

/**
 * @param {object} station raw API row
 * @param {number} sortOrder
 * @returns {Ticket}
 */
function stationToTicket(station, sortOrder, color) {
  const lat = parseCoord(station.latitude);
  const lon = parseCoord(station.longitude);
  const sid = String(station.id ?? '');
  const name = station.title || 'Unknown';
  const serviceType = 'Battery Redistribution';
  const filled = parseFilledSlots(station);
  const totalSlots = filled != null ? getTotalSlotsForStation(station) : undefined;
  /** @type {Ticket} */
  const t = {
    id: `ticket-${sid}`,
    stationId: sid,
    stationName: name,
    latitude: lat,
    longitude: lon,
    serviceType,
    color,
    source: 'station-status',
    sortOrder,
  };
  if (filled != null && totalSlots != null) {
    t.filledSlots = filled;
    t.totalSlots = totalSlots;
  }
  return t;
}

async function fetchStations() {
  const res = await fetch(STATIONS_URL);
  if (!res.ok) {
    throw new Error(`Stations request failed: ${res.status}`);
  }
  const data = await res.json();
  if (!data.success || !Array.isArray(data.data)) {
    throw new Error('Invalid stations response');
  }
  return omitTestStationRows(data.data);
}

async function fetchTicketsList() {
  const res = await fetch(TICKETS_URL);
  if (!res.ok) {
    throw new Error(`Tickets request failed: ${res.status}`);
  }
  const data = await res.json();
  if (!data.success || !Array.isArray(data.data)) {
    throw new Error('Invalid tickets response');
  }
  return data.data;
}

/**
 * @param {object} row API ticket row
 * @param {number} sortOrder
 * @returns {Ticket}
 */
function apiTicketToTicket(row, sortOrder) {
  const lat = parseCoord(row.latitude);
  const lon = parseCoord(row.longitude);
  const dbId = Number(row.id);
  const tasks = canonicalTaskLabels(parseTaskFieldToStrings(row.task));
  const label = formatTasksDisplay(tasks) || 'Other';
  return {
    id: `ticket-db-${row.id}`,
    dbId: Number.isFinite(dbId) ? dbId : undefined,
    stationId: String(row.station_id ?? ''),
    stationName: row.location_name || 'Unknown',
    latitude: lat,
    longitude: lon,
    tasks,
    description: row.description != null ? String(row.description) : '',
    serviceType: label,
    color: tasksToColor(tasks),
    source: 'database',
    sortOrder,
  };
}

/**
 * DB tickets first; slot-health tickets only for stations not already in the DB list.
 * @param {object[]} dbRows
 * @param {object[]} stations
 * @returns {Ticket[]}
 */
function mergeDbAndStationTickets(dbRows, stations) {
  const dbTickets = dbRows.map((row, i) => apiTicketToTicket(row, i));
  const stationTickets = buildTicketsFromStations(stations);
  const dbStationIds = new Set(dbTickets.map((t) => t.stationId));
  const merged = [...dbTickets, ...stationTickets.filter((t) => !dbStationIds.has(t.stationId))];
  const stationMap = new Map(stations.map((s) => [String(s.id ?? '').trim(), s]));
  merged.forEach((t) => enrichTicketSlotCounts(t, stationMap));
  merged.forEach((t, i) => {
    t.sortOrder = i;
  });
  return merged;
}

async function refreshTicketList() {
  const stations = await fetchStations();
  allStationsForPicker = stations;
  populateStationSelect();
  let rows = [];
  try {
    rows = await fetchTicketsList();
  } catch (e) {
    console.warn(e);
  }
  tickets = mergeDbAndStationTickets(rows, stations);
  await recalculateRoute();
}

/**
 * @param {object[]} stations
 * @returns {Ticket[]}
 */
function buildTicketsFromStations(stations) {
  const candidates = [];
  for (const station of stations) {
    const need = stationNeedsTicket(station);
    if (!need.ok || !need.color) {
      continue;
    }
    candidates.push({ station, color: need.color });
  }
  candidates.sort((a, b) => getStationPriority(a.station) - getStationPriority(b.station));
  return candidates.map((c, i) => stationToTicket(c.station, i, c.color));
}

/**
 * Yellow/red tickets → locations for `routeOptimization.js`, with route start first (index 0).
 * @param {Ticket[]} tickets
 * @returns {{ id: string, title: string, latitude: number, longitude: number }[]}
 */
function buildLocationsForRouteOptimization(tickets) {
  const home = getRouteHome();
  const stationLocs = tickets
    .filter((t) => Number.isFinite(t.latitude) && Number.isFinite(t.longitude))
    .map((t) => ({
      id: t.id,
      title: t.stationName,
      latitude: t.latitude,
      longitude: t.longitude,
    }));
  return [
    {
      id: home.id,
      title: home.title,
      latitude: home.latitude,
      longitude: home.longitude,
    },
    ...stationLocs,
  ];
}

/**
 * Mapbox matrix + nearest-neighbor via server (`routeOptimization.optimizeDrivingRoute`).
 * Route always starts at the configured home (see getRouteHome); response order includes home — strip it when applying to tickets.
 * @param {Ticket[]} tickets
 * @returns {Promise<{ orderedStationIds: string[] | null, summary: string | null }>}
 */
async function fetchRouteOrderFromServer(tickets) {
  if (tickets.length === 0) {
    return { orderedStationIds: [], summary: null };
  }
  const locations = buildLocationsForRouteOptimization(tickets);
  if (locations.length < 2) {
    return { orderedStationIds: null, summary: null };
  }
  try {
    const res = await fetch('/api/maintenance-route-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('Route order unavailable:', err.error || res.status);
      return { orderedStationIds: null, summary: null };
    }
    const data = await res.json();
    if (!data.orderedStationIds || !Array.isArray(data.orderedStationIds)) {
      return { orderedStationIds: null, summary: null };
    }
    return {
      orderedStationIds: data.orderedStationIds,
      summary: data.summary || null,
    };
  } catch (e) {
    console.warn('Route order request failed:', e.message);
    return { orderedStationIds: null, summary: null };
  }
}

/**
 * Reorder tickets to match optimized stop order (excluding home id).
 * @param {Ticket[]} tickets
 * @param {string[]} orderedStationIds from route (includes home first in visit order)
 * @param {string} homeId
 */
function applyStationOrder(tickets, orderedIds, homeId) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const next = [];
  for (const oid of orderedIds) {
    if (oid === homeId) {
      continue;
    }
    const t = byId.get(oid);
    if (t) {
      next.push(t);
      byId.delete(t.id);
    }
  }
  for (const t of tickets) {
    if (byId.has(t.id)) {
      next.push(t);
      byId.delete(t.id);
    }
  }
  next.forEach((t, i) => {
    t.sortOrder = i;
  });
  return next;
}

function populateStationSelect() {
  const sel = document.getElementById('create-station');
  if (!sel) {
    return;
  }
  rebuildStationsById();
  sel.innerHTML = '<option value="">Select station</option>';
  for (const s of allStationsForPicker) {
    if (s == null || s.id == null) {
      continue;
    }
    const id = String(s.id).trim();
    if (!id) {
      continue;
    }
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = s.title || id;
    sel.appendChild(opt);
  }
  updateCreateStationHint();
}

function populateTaskMultiSelect() {
  const sel = document.getElementById('create-task');
  if (!sel) {
    return;
  }
  sel.innerHTML = '';
  for (const t of TASK_TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  }
}

/**
 * @param {Ticket} ticket
 * @returns {string}
 */
function ticketSubtitleText(ticket) {
  if (ticket.source === 'database') {
    const list =
      ticket.tasks && ticket.tasks.length > 0 ? ticket.tasks : parseTaskFieldToStrings(ticket.serviceType);
    if (list.length > 0) {
      return formatTasksDisplay(list);
    }
    return ticket.serviceType || 'Other';
  }
  return ticket.serviceType || '';
}

/**
 * Re-fetch optimized order for the current ticket list and redraw.
 */
async function recalculateRoute() {
  if (tickets.length === 0) {
    setStatus('No stations require servicing right now.');
    renderTickets();
    return;
  }
  const { orderedStationIds } = await fetchRouteOrderFromServer(tickets);
  if (orderedStationIds && orderedStationIds.length > 0) {
    const home = getRouteHome();
    tickets = applyStationOrder(tickets, orderedStationIds, home.id);
    setStatus(
      `Queue order: shortest driving loop from ${home.title}, returning to start. Drag rows to reorder.`,
    );
  } else {
    setStatus(
      'Showing priority order (route optimization unavailable — set MAPBOX_ACCESS_TOKEN on the server). Drag rows to reorder.',
    );
  }
  renderTickets();
}

// --- UI state ---

/** @type {Ticket[]} */
let tickets = [];
let draggedTicketId = null;

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'className') {
        node.className = v;
      } else if (k === 'text') {
        node.textContent = v;
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, v);
      }
    });
  }
  (children || []).forEach((c) => {
    if (c != null) {
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  });
  return node;
}

function renderTickets() {
  const list = document.getElementById('ticket-list');
  const countEl = document.getElementById('ticket-count');
  const emptyEl = document.getElementById('ticket-empty');
  const listWrap = document.querySelector('.ticket-list-wrap');
  if (!list || !countEl) {
    return;
  }
  list.innerHTML = '';
  countEl.textContent = String(tickets.length);

  if (tickets.length === 0) {
    if (emptyEl) {
      emptyEl.hidden = false;
    }
    if (listWrap) {
      listWrap.classList.add('is-empty');
    }
    return;
  }

  if (emptyEl) {
    emptyEl.hidden = true;
  }
  if (listWrap) {
    listWrap.classList.remove('is-empty');
  }

  tickets.forEach((ticket) => {
    const statusClass = ticket.color === 'red' ? 'ticket--red' : 'ticket--yellow';
    const row = el('li', {
      className: `ticket-block ticket-row ${statusClass}`,
      draggable: 'true',
      'data-ticket-id': ticket.id,
    });

    row.addEventListener('dragstart', (e) => {
      if (
        e.target.closest &&
        (e.target.closest('.btn-ticket-delete') || e.target.closest('.btn-ticket-edit'))
      ) {
        e.preventDefault();
        return;
      }
      draggedTicketId = ticket.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', ticket.id);
      row.classList.add('dragging');
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      draggedTicketId = null;
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromId = draggedTicketId || e.dataTransfer.getData('text/plain');
      const toId = ticket.id;
      if (!fromId || fromId === toId) {
        return;
      }
      const fromIdx = tickets.findIndex((t) => t.id === fromId);
      const toIdx = tickets.findIndex((t) => t.id === toId);
      if (fromIdx < 0 || toIdx < 0) {
        return;
      }
      const [moved] = tickets.splice(fromIdx, 1);
      const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
      tickets.splice(insertAt, 0, moved);
      tickets.forEach((t, i) => {
        t.sortOrder = i;
      });
      renderTickets();
    });

    const actionsChildren = [];
    if (ticket.source === 'database' && ticket.dbId != null && Number.isFinite(ticket.dbId)) {
      actionsChildren.push(
        el('button', {
          type: 'button',
          className: 'btn-ticket-edit',
          text: 'Edit',
          onclick: (ev) => {
            ev.stopPropagation();
            openEditTicketModal(ticket);
          },
        }),
      );
      actionsChildren.push(
        el('button', {
          type: 'button',
          className: 'btn-ticket-delete',
          text: 'Done',
          onclick: async (ev) => {
            ev.stopPropagation();
            try {
              const res = await fetch(`${TICKETS_URL}/${ticket.dbId}`, { method: 'DELETE' });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || data.success === false) {
                setStatus(data.error || data.message || `Delete failed (${res.status})`, true);
                return;
              }
              await refreshTicketList();
            } catch (e) {
              setStatus(e.message || 'Delete failed', true);
            }
          },
        }),
      );
    }
    actionsChildren.push(el('span', { className: 'ticket-grip', text: '⋮⋮' }));

    const slotsLine = formatTicketSlotsLine(ticket);
    const titleRowChildren = [
      el('div', { className: 'ticket-station-name', text: ticket.stationName }),
    ];
    if (slotsLine) {
      titleRowChildren.push(el('div', { className: 'ticket-slots', text: slotsLine }));
    }
    const textCol = el(
      'div',
      { className: 'ticket-block-text' },
      [
        el('div', { className: 'ticket-title-row' }, titleRowChildren),
        el('div', { className: 'ticket-service', text: ticketSubtitleText(ticket) }),
      ],
    );

    const inner = el('div', { className: 'ticket-block-inner' }, [
      el('div', { className: 'ticket-block-main' }, [textCol]),
      el('div', { className: 'ticket-actions' }, actionsChildren),
    ]);
    row.appendChild(inner);
    list.appendChild(row);
  });
}

function setStatus(message, isError) {
  const s = document.getElementById('status-line');
  if (!s) {
    return;
  }
  s.textContent = message;
  s.className = isError ? 'status error' : 'status';
}

function openCreateTicketModal() {
  const modal = document.getElementById('modal-create');
  const err = document.getElementById('modal-create-error');
  const form = document.getElementById('form-create-ticket');
  if (!modal) {
    return;
  }
  if (err) {
    err.textContent = '';
  }
  if (form) {
    form.reset();
  }
  updateCreateStationHint();
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeCreateTicketModal() {
  const modal = document.getElementById('modal-create');
  const err = document.getElementById('modal-create-error');
  if (!modal) {
    return;
  }
  if (err) {
    err.textContent = '';
  }
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

/**
 * @param {Ticket} ticket
 */
function fillEditTaskSelectForTicket(ticket) {
  const sel = document.getElementById('edit-task');
  if (!sel) {
    return;
  }
  sel.innerHTML = '';
  const extras = new Set();
  for (const t of ticket.tasks || []) {
    if (!TASK_TYPES.includes(t)) {
      extras.add(t);
    }
  }
  for (const t of TASK_TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  }
  for (const t of extras) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  }
  const selected = new Set(ticket.tasks || []);
  Array.from(sel.options).forEach((opt) => {
    opt.selected = selected.has(opt.value);
  });
}

/**
 * @param {Ticket} ticket
 */
function openEditTicketModal(ticket) {
  if (ticket.source !== 'database' || ticket.dbId == null || !Number.isFinite(ticket.dbId)) {
    return;
  }
  const modal = document.getElementById('modal-edit');
  const err = document.getElementById('modal-edit-error');
  const idEl = document.getElementById('edit-db-id');
  const nameEl = document.getElementById('edit-location-name');
  const descEl = document.getElementById('edit-description');
  const latEl = document.getElementById('edit-latitude');
  const lonEl = document.getElementById('edit-longitude');
  if (!modal || !idEl || !nameEl || !descEl || !latEl || !lonEl) {
    return;
  }
  if (err) {
    err.textContent = '';
  }
  idEl.value = String(ticket.dbId);
  nameEl.value = ticket.stationName || '';
  descEl.value = ticket.description != null ? String(ticket.description) : '';
  fillEditTaskSelectForTicket(ticket);
  if (Number.isFinite(ticket.latitude) && Number.isFinite(ticket.longitude)) {
    latEl.value = String(ticket.latitude);
    lonEl.value = String(ticket.longitude);
  } else {
    latEl.value = '';
    lonEl.value = '';
  }
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeEditTicketModal() {
  const modal = document.getElementById('modal-edit');
  const err = document.getElementById('modal-edit-error');
  if (!modal) {
    return;
  }
  if (err) {
    err.textContent = '';
  }
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

function setupEditTicketUI() {
  const modal = document.getElementById('modal-edit');
  const form = document.getElementById('form-edit-ticket');
  const cancel = document.getElementById('modal-edit-cancel');
  const err = document.getElementById('modal-edit-error');

  if (cancel) {
    cancel.addEventListener('click', () => closeEditTicketModal());
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeEditTicketModal();
      }
    });
  }
  if (form && err) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      err.textContent = '';

      const idEl = document.getElementById('edit-db-id');
      const dbId = idEl ? Number(String(idEl.value || '').trim()) : NaN;
      if (!Number.isFinite(dbId)) {
        err.textContent = 'Invalid ticket.';
        return;
      }

      const nameEl = document.getElementById('edit-location-name');
      const location_name = nameEl ? String(nameEl.value || '').trim() : '';
      if (!location_name) {
        err.textContent = 'Enter a location name.';
        return;
      }

      const taskSel = document.getElementById('edit-task');
      const selectedTasks = taskSel
        ? Array.from(taskSel.selectedOptions)
            .map((o) => o.value.trim())
            .filter(Boolean)
        : [];
      if (!selectedTasks.length) {
        err.textContent = 'Select at least one task (hold Ctrl/Cmd to select multiple).';
        return;
      }

      const descEl = document.getElementById('edit-description');
      const description = descEl ? String(descEl.value || '').trim() : '';

      const latEl = document.getElementById('edit-latitude');
      const lonEl = document.getElementById('edit-longitude');
      const latStr = latEl ? String(latEl.value || '').trim() : '';
      const lonStr = lonEl ? String(lonEl.value || '').trim() : '';

      /** @type {Record<string, unknown>} */
      const body = {
        location_name,
        task: selectedTasks,
        description,
      };

      if (!latStr && !lonStr) {
        /* keep existing coordinates on server */
      } else {
        const lat = parseCoord(latStr);
        const lon = parseCoord(lonStr);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          err.textContent =
            'Enter both latitude and longitude, or clear both to keep existing coordinates.';
          return;
        }
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          err.textContent = 'Coordinates out of range.';
          return;
        }
        body.latitude = lat;
        body.longitude = lon;
      }

      (async () => {
        try {
          const res = await fetch(`${TICKETS_URL}/${dbId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.success === false) {
            err.textContent = ticketsApiFailureMessage(res, data, 'update');
            return;
          }
          closeEditTicketModal();
          await refreshTicketList();
        } catch (e) {
          err.textContent = e.message || 'Network error';
        }
      })();
    });
  }
}

function setupCreateTicketUI() {
  const btn = document.getElementById('btn-create-ticket');
  const modal = document.getElementById('modal-create');
  const form = document.getElementById('form-create-ticket');
  const cancel = document.getElementById('modal-create-cancel');
  const err = document.getElementById('modal-create-error');

  if (btn) {
    btn.addEventListener('click', () => openCreateTicketModal());
  }
  const stationSel = document.getElementById('create-station');
  if (stationSel) {
    stationSel.addEventListener('change', updateCreateStationHint);
  }
  if (cancel) {
    cancel.addEventListener('click', () => closeCreateTicketModal());
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeCreateTicketModal();
      }
    });
  }
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!err) {
        return;
      }
      err.textContent = '';

      const stationId = form.station.value.trim();
      const taskSel = document.getElementById('create-task');
      const selectedTasks = taskSel
        ? Array.from(taskSel.selectedOptions)
            .map((o) => o.value.trim())
            .filter(Boolean)
        : [];

      if (!stationId) {
        err.textContent = 'Select a station.';
        return;
      }
      if (!selectedTasks.length) {
        err.textContent = 'Select at least one task (hold Ctrl/Cmd to select multiple).';
        return;
      }
      for (const t of selectedTasks) {
        if (!TASK_TYPES.includes(t)) {
          err.textContent = 'Invalid task selection.';
          return;
        }
      }

      const station = stationsById.get(stationId);
      if (!station) {
        err.textContent = 'Pick a station from the list (station ID must match the API).';
        return;
      }
      const apiStationId = String(station.id).trim();
      const locationName = String(station.title || '').trim() || apiStationId;
      const lat = parseCoord(station.latitude);
      const lon = parseCoord(station.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        err.textContent = 'Station has no valid coordinates.';
        return;
      }
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        err.textContent = 'Coordinates out of range.';
        return;
      }

      const descEl = document.getElementById('create-description');
      const description = descEl && String(descEl.value || '').trim();

      const body = {
        location_name: locationName,
        station_id: apiStationId,
        latitude: lat,
        longitude: lon,
        task: selectedTasks,
      };
      if (description) {
        body.description = description;
      }

      (async () => {
        try {
          const res = await fetch(TICKETS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.success === false) {
            err.textContent = ticketsApiFailureMessage(res, data, 'create');
            return;
          }
          closeCreateTicketModal();
          await refreshTicketList();
        } catch (e) {
          err.textContent = e.message || 'Network error';
        }
      })();
    });
  }
}

function openRouteHomeModal() {
  const modal = document.getElementById('modal-route-home');
  const err = document.getElementById('modal-route-home-error');
  const titleEl = document.getElementById('route-home-title');
  const latEl = document.getElementById('route-home-lat');
  const lonEl = document.getElementById('route-home-lon');
  if (!modal) {
    return;
  }
  if (err) {
    err.textContent = '';
  }
  const h = getRouteHome();
  if (titleEl) {
    titleEl.value = h.title;
  }
  if (latEl) {
    latEl.value = String(h.latitude);
  }
  if (lonEl) {
    lonEl.value = String(h.longitude);
  }
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeRouteHomeModal() {
  const modal = document.getElementById('modal-route-home');
  const err = document.getElementById('modal-route-home-error');
  if (!modal) {
    return;
  }
  if (err) {
    err.textContent = '';
  }
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

function setupRouteHomeUI() {
  const btn = document.getElementById('btn-route-home');
  const modal = document.getElementById('modal-route-home');
  const form = document.getElementById('form-route-home');
  const cancel = document.getElementById('modal-route-home-cancel');
  const reset = document.getElementById('modal-route-home-reset');
  const err = document.getElementById('modal-route-home-error');

  if (btn) {
    btn.addEventListener('click', () => openRouteHomeModal());
  }
  if (cancel) {
    cancel.addEventListener('click', () => closeRouteHomeModal());
  }
  if (reset) {
    reset.addEventListener('click', () => {
      localStorage.removeItem(ROUTE_HOME_STORAGE_KEY);
      closeRouteHomeModal();
      void recalculateRoute();
    });
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeRouteHomeModal();
      }
    });
  }
  if (form && err) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      err.textContent = '';

      const titleEl = document.getElementById('route-home-title');
      const latEl = document.getElementById('route-home-lat');
      const lonEl = document.getElementById('route-home-lon');
      const title = titleEl ? String(titleEl.value || '').trim() : '';
      const lat = latEl ? parseCoord(latEl.value) : NaN;
      const lon = lonEl ? parseCoord(lonEl.value) : NaN;

      if (!title) {
        err.textContent = 'Enter a label for this start point.';
        return;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        err.textContent = 'Enter valid latitude and longitude numbers.';
        return;
      }
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        err.textContent = 'Latitude must be −90…90, longitude −180…180.';
        return;
      }

      const def = getDefaultRouteHome();
      const sameAsDefault =
        Math.abs(lat - def.latitude) < 1e-7 &&
        Math.abs(lon - def.longitude) < 1e-7 &&
        title === def.title;
      if (sameAsDefault) {
        localStorage.removeItem(ROUTE_HOME_STORAGE_KEY);
      } else {
        try {
          localStorage.setItem(
            ROUTE_HOME_STORAGE_KEY,
            JSON.stringify({
              id: CUSTOM_ROUTE_HOME_ID,
              title,
              latitude: lat,
              longitude: lon,
            }),
          );
        } catch (e) {
          err.textContent = e.message || 'Could not save (storage full or blocked).';
          return;
        }
      }

      closeRouteHomeModal();
      void recalculateRoute();
    });
  }
}

async function init() {
  setStatus('');
  try {
    const stations = await fetchStations();
    allStationsForPicker = stations;
    populateStationSelect();

    let rows = [];
    try {
      rows = await fetchTicketsList();
    } catch (ticketErr) {
      console.warn('Tickets list failed (stations still loaded):', ticketErr);
    }

    tickets = mergeDbAndStationTickets(rows, stations);
    await recalculateRoute();
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Failed to load', true);
    tickets = [];
    renderTickets();
  }
}

setupCreateTicketUI();
setupEditTicketUI();
setupRouteHomeUI();

function boot() {
  populateTaskMultiSelect();
  init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
