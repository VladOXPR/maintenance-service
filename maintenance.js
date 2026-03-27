/**
 * Maintenance tickets UI — data from the same source and slot-health rules as telegram_bot.js.
 * Keep getTotalSlotsForStation / getFilledSlotHealthLevel / filters in sync with telegram_bot.js.
 */

/** Proxied by server.js (same payload as https://api.cuub.tech/stations). */
const STATIONS_URL = '/api/stations';

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
 *   source: 'station-status' | 'manual',
 *   sortOrder: number,
 *   issueType?: string
 * }} Ticket
 */

const ISSUE_TYPES = [
  'Add stack',
  'Broken Battery',
  'High failure rates',
  'hardware malfunction',
  'unusually offline',
];

/** All stations for Create Ticket dropdown (set in init). */
let allStationsForPicker = [];

let manualTicketSeq = 0;

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
  sel.innerHTML = '<option value="">Select station</option>';
  for (const s of allStationsForPicker) {
    const opt = document.createElement('option');
    opt.value = String(s.id ?? '');
    opt.textContent = s.title || opt.value;
    sel.appendChild(opt);
  }
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
    if (ticket.source === 'manual') {
      actionsChildren.push(
        el('button', {
          type: 'button',
          className: 'btn-ticket-delete',
          text: 'Delete',
          onclick: (ev) => {
            ev.stopPropagation();
            tickets = tickets.filter((t) => t.id !== ticket.id);
            void recalculateRoute();
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
      const colorRadio = form.querySelector('input[name="create-color"]:checked');

      if (!stationId) {
        err.textContent = 'Select a station.';
        return;
      }
      if (!issue) {
        err.textContent = 'Select an issue type.';
        return;
      }
      if (!ISSUE_TYPES.includes(issue)) {
        err.textContent = 'Invalid issue type.';
        return;
      }
      if (!colorRadio || (colorRadio.value !== 'yellow' && colorRadio.value !== 'red')) {
        err.textContent = 'Select yellow or red.';
        return;
      }

      const station = allStationsForPicker.find((s) => String(s.id ?? '') === stationId);
      if (!station) {
        err.textContent = 'Invalid station.';
        return;
      }
      const lat = parseCoord(station.latitude);
      const lon = parseCoord(station.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        err.textContent = 'Station has no valid coordinates.';
        return;
      }

      manualTicketSeq += 1;
      const color = colorRadio.value;
      const ticket = {
        id: `ticket-manual-${manualTicketSeq}-${Date.now()}`,
        stationId: String(station.id ?? ''),
        stationName: station.title || 'Unknown',
        latitude: lat,
        longitude: lon,
        serviceType: issue,
        issueType: issue,
        color,
        source: 'manual',
        sortOrder: tickets.length,
      };
      tickets.push(ticket);
      closeCreateTicketModal();
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
    tickets = buildTicketsFromStations(stations);
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
