/**
 * Shared station list filters (Telegram + `/api/stations` proxy).
 * Keep browser copy in maintenance.js in sync.
 */

function omitTestStationRows(stations) {
  if (!Array.isArray(stations)) {
    return stations;
  }
  return stations.filter((s) => String(s.title || '').trim().toUpperCase() !== 'TEST STATION');
}

module.exports = { omitTestStationRows };
