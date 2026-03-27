/**
 * Maintenance tickets UI — data from the same source and slot-health rules as telegram_bot.js.
 * Keep getTotalSlotsForStation / getFilledSlotHealthLevel / filters in sync with telegram_bot.js.
 */

/** Proxied by server.js (same payload as https://api.cuub.tech/stations). */
const STATIONS_URL = '/api/stations';

/** @typedef {{ id: string, stationId: string, stationName: string, latitude: number, longitude: number, serviceType: string, color: 'red' | 'yellow', source: string, sortOrder: number }} Ticket */

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
  const serviceType =
    color === 'red' ? 'Slot capacity (critical)' : 'Slot capacity (attention)';
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
  return data.data;
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
 * @param {Ticket[]} tickets
 * @returns {{ id: string, title: string, latitude: number, longitude: number }[]}
 */
function ticketsToRouteLocations(tickets) {
  return tickets.map((t) => ({
    id: t.stationId,
    title: t.stationName,
    latitude: t.latitude,
    longitude: t.longitude,
  }));
}

/**
 * Ask server for Mapbox route order (same as routeOptimization.js). Fails soft if unavailable.
 * @param {Ticket[]} tickets priority-ordered list
 * @returns {Promise<string[]|null>} ordered station ids, or null
 */
async function fetchRouteOrderFromServer(tickets) {
  if (tickets.length === 0) {
    return [];
  }
  const locations = ticketsToRouteLocations(tickets);
  try {
    const res = await fetch('/api/maintenance-route-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('Route order unavailable:', err.error || res.status);
      return null;
    }
    const data = await res.json();
    if (!data.orderedStationIds || !Array.isArray(data.orderedStationIds)) {
      return null;
    }
    return data.orderedStationIds;
  } catch (e) {
    console.warn('Route order request failed:', e.message);
    return null;
  }
}

/**
 * @param {Ticket[]} tickets
 * @param {string[]} orderedStationIds
 */
function applyStationOrder(tickets, orderedStationIds) {
  const byId = new Map(tickets.map((t) => [t.stationId, t]));
  const next = [];
  for (const sid of orderedStationIds) {
    const t = byId.get(sid);
    if (t) {
      next.push(t);
      byId.delete(sid);
    }
  }
  for (const t of tickets) {
    if (byId.has(t.stationId)) {
      next.push(t);
      byId.delete(t.stationId);
    }
  }
  next.forEach((t, i) => {
    t.sortOrder = i;
  });
  return next;
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
  const tableEl = document.querySelector('.data-table');
  if (!list || !countEl) {
    return;
  }
  list.innerHTML = '';
  countEl.textContent = String(tickets.length);

  if (tickets.length === 0) {
    if (emptyEl) {
      emptyEl.hidden = false;
    }
    if (tableEl) {
      tableEl.hidden = true;
    }
    return;
  }

  if (emptyEl) {
    emptyEl.hidden = true;
  }
  if (tableEl) {
    tableEl.hidden = false;
  }

  tickets.forEach((ticket) => {
    const row = el('tr', {
      className: 'ticket-row',
      draggable: 'true',
      'data-ticket-id': ticket.id,
    });

    row.addEventListener('dragstart', (e) => {
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

    const colorClass = ticket.color === 'red' ? 'chip-red' : 'chip-yellow';
    row.appendChild(el('td', { className: 'col-name', text: ticket.stationName }));
    row.appendChild(el('td', { className: 'col-service', text: ticket.serviceType }));
    row.appendChild(
      el('td', {}, [
        el('span', { className: `chip ${colorClass}`, text: ticket.color }),
      ]),
    );
    row.appendChild(el('td', { className: 'col-grip', text: '⋮⋮' }));
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

async function init() {
  setStatus('');
  try {
    const stations = await fetchStations();
    tickets = buildTicketsFromStations(stations);

    if (tickets.length > 0) {
      const orderIds = await fetchRouteOrderFromServer(tickets);
      if (orderIds && orderIds.length > 0) {
        tickets = applyStationOrder(tickets, orderIds);
        setStatus('Route order optimized (Mapbox). Drag rows to reorder.');
      } else {
        setStatus('Priority order (route API unavailable). Drag rows to reorder.');
      }
    } else {
      setStatus('No stations require servicing right now.');
    }

    renderTickets();
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Failed to load', true);
    tickets = [];
    renderTickets();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
