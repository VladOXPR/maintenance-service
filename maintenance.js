/**
 * Maintenance tickets UI — data from the same source and slot-health rules as telegram_bot.js.
 * Keep getTotalSlotsForStation / getFilledSlotHealthLevel / filters in sync with telegram_bot.js.
 */

/** Proxied by server.js (same payload as https://api.cuub.tech/stations). */
const STATIONS_URL = '/api/stations';

/** Proxied by server.js → https://api.cuub.tech/tickets */
const TICKETS_URL = '/api/tickets';

/** Same rule as `stationFilters.js` — exclude lab / bogus rows. */
function omitTestStationRows(stations) {
  if (!Array.isArray(stations)) {
    return stations;
  }
  return stations.filter((s) => String(s.title || '').trim().toUpperCase() !== 'TEST STATION');
}

/**
 * Depot / route start (always index 0 in `routeOptimization.js`).
 * Civic Opera House area — 20 North Wacker Drive, Chicago, IL (~41.8818, -87.6374).
 */
const HOME_BASE = Object.freeze({
  id: 'home-civic-opera',
  title: 'Civic Opera House — Home',
  latitude: 41.8818,
  longitude: -87.6374,
});

/**
 * @typedef {{
 *   id: string,
 *   stationId: string,
 *   stationName: string,
 *   latitude: number,
 *   longitude: number,
 *   serviceType: string,
 *   color: 'red' | 'yellow',
 *   source: 'station-status' | 'database',
 *   sortOrder: number,
 *   dbId?: number
 * }} Ticket
 */

/** Must match Postgres enum on api.cuub.tech (Create ticket body). */
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

function getFilledSlotHealthLevel(totalSlots, filledSlotsNum) {
  if (isNaN(filledSlotsNum)) {
    return null;
  }
  if (totalSlots === 24) {
    if (filledSlotsNum <= 4 || filledSlotsNum > 21) {
      return 'red';
    }
    if (filledSlotsNum >= 6 && filledSlotsNum <= 18) {
      return 'green';
    }
    if (filledSlotsNum === 5 || (filledSlotsNum >= 19 && filledSlotsNum <= 21)) {
      return 'yellow';
    }
    return null;
  }
  if (filledSlotsNum >= 4) {
    return 'green';
  }
  if (filledSlotsNum === 3) {
    return 'yellow';
  }
  if (filledSlotsNum <= 2) {
    return 'red';
  }
  return null;
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
  return {
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

function taskToColor(task) {
  const red = new Set(['Low Batteries', 'No Batteries', 'Broken Battery', 'Unusually Offline']);
  return red.has(String(task || '')) ? 'red' : 'yellow';
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
  return {
    id: `ticket-db-${row.id}`,
    dbId: Number.isFinite(dbId) ? dbId : undefined,
    stationId: String(row.station_id ?? ''),
    stationName: row.location_name || 'Unknown',
    latitude: lat,
    longitude: lon,
    serviceType: row.task || 'Other',
    color: taskToColor(row.task),
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
 * Yellow/red tickets → locations for `routeOptimization.js`, with home first (fixed start).
 * @param {Ticket[]} tickets
 * @returns {{ id: string, title: string, latitude: number, longitude: number }[]}
 */
function buildLocationsForRouteOptimization(tickets) {
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
      id: HOME_BASE.id,
      title: HOME_BASE.title,
      latitude: HOME_BASE.latitude,
      longitude: HOME_BASE.longitude,
    },
    ...stationLocs,
  ];
}

/**
 * Mapbox matrix + nearest-neighbor via server (`routeOptimization.optimizeDrivingRoute`).
 * Route always starts at {@link HOME_BASE}; response order includes home — strip it when applying to tickets.
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
    tickets = applyStationOrder(tickets, orderedStationIds, HOME_BASE.id);
    setStatus(
      'Queue order: shortest driving loop from Civic Opera House (20 N Wacker), returning home. Drag rows to reorder.',
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
      if (e.target.closest && e.target.closest('.btn-ticket-delete')) {
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
          className: 'btn-ticket-delete',
          text: 'Delete',
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

    const inner = el('div', { className: 'ticket-block-inner' }, [
      el('div', { className: 'ticket-block-main' }, [
        el('div', { className: 'ticket-station-name', text: ticket.stationName }),
        el('div', { className: 'ticket-service', text: ticket.serviceType }),
      ]),
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
      const issue = form.issue.value.trim();

      if (!stationId) {
        err.textContent = 'Select a station.';
        return;
      }
      if (!issue) {
        err.textContent = 'Select an issue type.';
        return;
      }
      if (!TASK_TYPES.includes(issue)) {
        err.textContent = 'Invalid issue type.';
        return;
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
        task: issue,
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
            let msg =
              (data && (data.error || data.message)) || `Create failed (${res.status})`;
            if (res.status === 404) {
              msg =
                'Tickets API returned 404 — the route may not be deployed yet. Set CUUB_TICKETS_API_URL in the server .env to the full tickets URL (e.g. https://host/path/tickets), then restart.';
            }
            err.textContent = msg;
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
