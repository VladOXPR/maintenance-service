/**
 * CUUB driving route helper (v1) — Mapbox Matrix + nearest-neighbor, closed tour.
 *
 * Assumptions:
 * - One vehicle; driving profile only; each stop visited once; fixed 5 min service per stop.
 * - Start is locations[0]; after all stops, return to locations[0] (last leg adds driving time).
 * - "Best" order = greedy nearest-neighbor on Mapbox driving durations (not globally optimal TSP).
 */

const mapboxSdk = require('@mapbox/mapbox-sdk');
const mbxMatrix = require('@mapbox/mapbox-sdk/services/matrix');

const SERVICE_MINUTES_PER_STOP = 5;

/**
 * @typedef {{ id: string, title: string, latitude: number, longitude: number }} Location
 */

/**
 * @param {unknown} locations
 * @returns {asserts locations is Location[]}
 */
function validateLocations(locations) {
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error('locations must be a non-empty array');
  }
  if (locations.length > 100) {
    throw new Error('At most 100 locations (Mapbox Matrix limit)');
  }
  const seen = new Set();
  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i];
    if (!loc || typeof loc !== 'object') {
      throw new Error(`Invalid location at index ${i}`);
    }
    if (typeof loc.id !== 'string' || loc.id.trim() === '') {
      throw new Error(`Location ${i}: id must be a non-empty string`);
    }
    if (seen.has(loc.id)) {
      throw new Error(`Duplicate id: ${loc.id}`);
    }
    seen.add(loc.id);
    if (typeof loc.title !== 'string') {
      throw new Error(`Location ${loc.id}: title must be a string`);
    }
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Location ${loc.id}: latitude/longitude must be numbers`);
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error(`Location ${loc.id}: coordinates out of range`);
    }
  }
}

/**
 * @param {number} minutes
 * @returns {string} Human-readable; uses hours when total minutes >= 60.
 */
function formatMinutesForSummary(minutes) {
  const m = Math.round(minutes);
  if (m < 60) {
    return `${m} min`;
  }
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (rem === 0) {
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${h}h ${rem}m`;
}

/**
 * Fetch N×N driving durations (seconds) from Mapbox Matrix.
 * @param {Location[]} locations
 * @returns {Promise<number[][]>}
 */
async function fetchDurationMatrixSeconds(locations) {
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token || String(token).trim() === '') {
    throw new Error('MAPBOX_ACCESS_TOKEN is not set in the environment');
  }

  const n = locations.length;
  if (n === 1) {
    return [[0]];
  }

  const matrixService = mbxMatrix(mapboxSdk({ accessToken: String(token).trim() }));
  const points = locations.map((loc) => ({
    coordinates: [Number(loc.longitude), Number(loc.latitude)],
  }));

  const response = await matrixService
    .getMatrix({
      points,
      profile: 'driving',
      annotations: ['duration'],
    })
    .send();

  const body = response.body;
  if (body.code !== 'Ok' || !body.durations) {
    throw new Error(`Mapbox Matrix failed: ${body.code || 'unknown response'}`);
  }

  return body.durations;
}

/**
 * Visit order: start at index 0, then repeatedly nearest unvisited; indices only (no return stop).
 * @param {number[][]} durationsSec
 * @param {number} n
 * @returns {number[]}
 */
function nearestNeighborVisitOrder(durationsSec, n) {
  if (n === 1) {
    return [0];
  }

  const order = [0];
  const visited = new Set([0]);
  let current = 0;

  while (visited.size < n) {
    let bestJ = -1;
    let bestSec = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited.has(j)) {
        continue;
      }
      const sec = durationsSec[current][j];
      if (sec == null || sec < 0) {
        throw new Error(`Invalid Matrix duration from ${current} to ${j}`);
      }
      if (sec < bestSec) {
        bestSec = sec;
        bestJ = j;
      }
    }
    if (bestJ < 0) {
      throw new Error('Could not pick next stop (nearest neighbor)');
    }
    order.push(bestJ);
    visited.add(bestJ);
    current = bestJ;
  }

  return order;
}

/**
 * Sum driving seconds for path: order[0]→order[1]→…→order[n-1]→order[0].
 * @param {number[][]} durationsSec
 * @param {number[]} order
 * @param {number} n
 */
function totalDrivingSecondsClosedLoop(durationsSec, order, n) {
  if (n === 1) {
    return 0;
  }
  let sum = 0;
  for (let k = 0; k < n - 1; k++) {
    const a = order[k];
    const b = order[k + 1];
    const sec = durationsSec[a][b];
    if (sec == null || sec < 0) {
      throw new Error(`Invalid duration ${a}→${b}`);
    }
    sum += sec;
  }
  const last = order[n - 1];
  const back = durationsSec[last][0];
  if (back == null || back < 0) {
    throw new Error('Invalid duration returning to start');
  }
  sum += back;
  return sum;
}

/**
 * @param {Location[]} locations
 * @returns {Promise<{ orderedStops: Location[], totalCompletionMinutes: number, summary: string }>}
 */
async function optimizeDrivingRoute(locations) {
  validateLocations(locations);

  const n = locations.length;
  const durationsSec = await fetchDurationMatrixSeconds(locations);
  const order = nearestNeighborVisitOrder(durationsSec, n);
  const drivingSec = totalDrivingSecondsClosedLoop(durationsSec, order, n);

  const totalDrivingMinutes = Math.round(drivingSec / 60);
  const totalServiceMinutes = n * SERVICE_MINUTES_PER_STOP;
  const totalCompletionMinutes = Math.round(totalDrivingMinutes + totalServiceMinutes);

  const orderedStops = order.map((idx) => locations[idx]);
  const startTitle = locations[0].title;

  const summary =
    `Nearest-neighbor driving tour from "${startTitle}" (return to start). ` +
    `~${formatMinutesForSummary(totalDrivingMinutes)} driving + ${totalServiceMinutes} min service = ` +
    `~${formatMinutesForSummary(totalCompletionMinutes)} total (${n} stops).`;

  return {
    orderedStops,
    totalCompletionMinutes,
    summary,
  };
}

module.exports = { optimizeDrivingRoute };

// ─── Example (run: node routeOptimization.js, with MAPBOX_ACCESS_TOKEN set) ─

if (require.main === module) {
  require('dotenv').config();

  const mockStations = [
    {
      id: 'a',
      title: 'Depot — Wicker Park',
      latitude: 41.9108,
      longitude: -87.6774,
    },
    {
      id: 'b',
      title: 'Milwaukee Ave',
      latitude: 41.9039,
      longitude: -87.6706,
    },
    {
      id: 'c',
      title: 'Division Blue Line',
      latitude: 41.8917,
      longitude: -87.6676,
    },
  ];

  (async () => {
    try {
      const result = await optimizeDrivingRoute(mockStations);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(err.message || err);
      process.exit(1);
    }
  })();
}
