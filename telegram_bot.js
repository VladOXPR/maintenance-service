// Telegram Bot API Integration
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

// Add fetch for HTTP requests
let fetch;
if (typeof globalThis.fetch === 'undefined') {
  fetch = require('node-fetch');
} else {
  fetch = globalThis.fetch;
}

const cron = require('node-cron');
const { omitTestStationRows } = require('./stationFilters');

/** Abort slow upstream calls so /status cannot stall the Telegram poll loop forever. */
const STATIONS_FETCH_TIMEOUT_MS = Math.max(
  5000,
  parseInt(process.env.STATIONS_FETCH_TIMEOUT_MS || '45000', 10) || 45000,
);

/** getUpdates must return or abort so we always schedule the next poll (Telegram long-poll + margin). */
const TELEGRAM_GET_UPDATES_TIMEOUT_MS = Math.max(
  5000,
  parseInt(process.env.TELEGRAM_GET_UPDATES_TIMEOUT_MS || '45000', 10) || 45000,
);

const TELEGRAM_SEND_MESSAGE_TIMEOUT_MS = Math.max(
  5000,
  parseInt(process.env.TELEGRAM_SEND_MESSAGE_TIMEOUT_MS || '60000', 10) || 60000,
);

/** Cap total time for fetch stations + format + sendMessage so polling never stalls indefinitely. */
const TELEGRAM_STATUS_COMMAND_TIMEOUT_MS = Math.max(
  15000,
  parseInt(process.env.TELEGRAM_STATUS_COMMAND_TIMEOUT_MS || '120000', 10) || 120000,
);

// Telegram Bot Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8279022767:AAHPZ4IJE6Blcm3wuNW9L1-HEoY1QjNoQ8I';
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Send a message to a Telegram chat
 * @param {string|number} chatId - The chat ID to send the message to
 * @param {string} text - The message text to send
 * @returns {Promise<Object>} - The API response
 */
async function sendMessage(chatId, text) {
  try {
    const url = `${TELEGRAM_API_BASE}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
      }),
      signal: AbortSignal.timeout(TELEGRAM_SEND_MESSAGE_TIMEOUT_MS),
    });

    const data = await response.json();
    
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }
    
    return data;
  } catch (error) {
    console.error('Error sending Telegram message:', error);
    throw error;
  }
}

/**
 * Get bot updates (useful for finding your chat_id)
 * @returns {Promise<Object>} - The API response with updates
 */
async function getUpdates() {
  try {
    const url = `${TELEGRAM_API_BASE}/getUpdates`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }
    
    return data;
  } catch (error) {
    console.error('Error getting Telegram updates:', error);
    throw error;
  }
}

/**
 * Fetch station status from API
 * @returns {Promise<Array>} - Array of station objects
 */
async function fetchStations() {
  try {
    const response = await fetch('https://api.cuub.tech/stations', {
      signal: AbortSignal.timeout(STATIONS_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data.success || !data.data) {
      throw new Error('Invalid API response format');
    }

    return omitTestStationRows(data.data);
  } catch (error) {
    console.error('Error fetching stations:', error);
    throw error;
  }
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
 * Green if above 33% and below full.
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

/**
 * Parsed fill counts for capacity rules (same idea as maintenance.js stationNeedsTicket input).
 * @returns {{ filled: number, total: number } | null}
 */
function getStationFillMetrics(station) {
  const filledSlots = station.filled_slots;
  if (filledSlots === null || filledSlots === undefined || filledSlots === 'N/A') {
    return null;
  }
  const filledNum = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : Number(filledSlots);
  if (isNaN(filledNum)) {
    return null;
  }
  const total = getTotalSlotsForStation(station);
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  return { filled: filledNum, total };
}

/** Red or yellow under getFilledSlotHealthLevel (empty/full = red; ≤33% filled = yellow). */
function stationNeedsCapacityAlert(station) {
  const m = getStationFillMetrics(station);
  if (!m) {
    return false;
  }
  const level = getFilledSlotHealthLevel(m.total, m.filled);
  return level === 'red' || level === 'yellow';
}

/**
 * Sort: red first, then yellow, then green (same thresholds as getFilledSlotHealthLevel).
 */
function getStationPriority(station) {
  const m = getStationFillMetrics(station);
  if (!m) {
    return 4;
  }
  const level = getFilledSlotHealthLevel(m.total, m.filled);
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
 * Lists stations that need attention: same percent-capacity rules as the maintenance UI
 * (red = 0% or 100% full, yellow = up to 33% full, green omitted).
 */
function formatStationStatus(stations) {
  if (!stations || stations.length === 0) {
    return 'No stations found.';
  }

  const redYellowStations = stations.filter(stationNeedsCapacityAlert);

  // Sort stations: Red first, then Yellow (when we have any)
  const sortedStations = redYellowStations.length === 0
    ? []
    : [...redYellowStations].sort((a, b) => getStationPriority(a) - getStationPriority(b));

  let message = '';

  if (sortedStations.length === 0) {
    message = 'Network is healthy!';
  }

  sortedStations.forEach((station) => {
    const m = getStationFillMetrics(station);
    if (!m) {
      return;
    }
    const { filled: filledSlotsNum, total: totalSlots } = m;
    const health = getFilledSlotHealthLevel(totalSlots, filledSlotsNum);
    const title = station.title || 'Unknown';

    let colorSquare = '';
    if (health === 'yellow') {
      colorSquare = '🟨';
    } else if (health === 'red') {
      colorSquare = '🟥';
    } else {
      colorSquare = '🟢';
    }

    message += `${title}\n`;
    if (health === 'red') {
      message += `${colorSquare} ${filledSlotsNum}/${totalSlots}\n\n`;
    } else if (health === 'yellow') {
      message += `${colorSquare} Filled: ${filledSlotsNum} / ${totalSlots}\n\n`;
    } else {
      message += `${colorSquare} Filled: ${filledSlotsNum} / ${totalSlots}\n\n`;
    }
  });
  
  // Offline stations (online === false)
  const offlineStations = (stations || []).filter((station) => station.online === false);
  if (offlineStations.length > 0) {
    message += '--\n';
    offlineStations.forEach((station) => {
      const title = station.title || 'Unknown';
      message += `${title}\n🔴 Offline\n\n`;
    });
  }
  
  return message;
}

/**
 * Send station status report to Telegram
 * @param {string|number} chatId - The chat ID to send the message to
 */
async function sendStationStatus(chatId) {
  try {
    console.log(`Fetching station status for chat ID: ${chatId}`);
    
    // Fetch stations from API
    const stations = await fetchStations();
    console.log(`✅ Fetched ${stations.length} stations`);
    
    // Format the status message
    const message = formatStationStatus(stations);
    
    // Send the message
    console.log(`Sending station status report...`);
    const result = await sendMessage(chatId, message);
    console.log('✅ Station status report sent successfully!', result);
    return result;
  } catch (error) {
    console.error('❌ Failed to send station status:', error.message);
    // Send error message to chat instead of crashing
    try {
      await sendMessage(chatId, `❌ Error fetching station status: ${error.message}`);
    } catch (sendError) {
      console.error('Failed to send error message:', sendError);
    }
    throw error;
  }
}

/**
 * Main function to send "hello world" message (kept for backward compatibility)
 * Note: You need to get your chat_id first by:
 * 1. Sending a message to the bot: https://t.me/cuub_chicago_bot
 * 2. Running: node -e "require('./telegram_bot.js').getChatId()"
 * 3. Or check the getUpdates response to find your chat_id
 */
async function sendHelloWorld(chatId) {
  try {
    console.log(`Sending "hello world" to chat ID: ${chatId}`);
    const result = await sendMessage(chatId, 'hello world');
    console.log('✅ Message sent successfully!', result);
    return result;
  } catch (error) {
    console.error('❌ Failed to send message:', error.message);
    throw error;
  }
}

/**
 * Helper function to get your chat_id from updates
 * Run this first to find your chat_id after messaging the bot
 */
async function getChatId() {
  try {
    console.log('Getting updates to find your chat_id...');
    console.log('(Make sure you\'ve sent a message to the bot first: https://t.me/cuub_chicago_bot)');
    
    const updates = await getUpdates();
    
    if (updates.result && updates.result.length > 0) {
      const lastUpdate = updates.result[updates.result.length - 1];
      const chatId = lastUpdate.message?.chat?.id;
      
      if (chatId) {
        console.log(`\n✅ Found your chat_id: ${chatId}`);
        console.log(`You can now use: sendHelloWorld(${chatId})`);
        return chatId;
      }
    }
    
    console.log('❌ No messages found. Please send a message to the bot first: https://t.me/cuub_chicago_bot');
    return null;
  } catch (error) {
    console.error('Error getting chat_id:', error);
    return null;
  }
}

// ========================================
// TELEGRAM STATUS REPORT SCHEDULER (CHICAGO TIME)
// ========================================

const CHICAGO_TZ = 'America/Chicago';

/**
 * Twice daily at 6:00 AM and 4:00 PM America/Chicago (handles DST).
 */
function scheduleDailyTelegramReport() {
  const DEFAULT_CHAT_ID = '-5202000799'; // CUUB_Alert group
  const chatId = process.env.TELEGRAM_CHAT_ID || DEFAULT_CHAT_ID;

  const sendScheduledReport = async (label) => {
    try {
      console.log(`📨 Sending Telegram status report (${label} ${CHICAGO_TZ})...`);
      await sendStationStatus(chatId);
      console.log(`✅ Telegram status report sent successfully (${label})`);
    } catch (error) {
      console.error('❌ Error sending scheduled Telegram report:', error.message);
    }
  };

  const cronOpts = { timezone: CHICAGO_TZ };

  cron.schedule('0 6 * * *', () => sendScheduledReport('6:00 AM'), cronOpts);
  cron.schedule('0 16 * * *', () => sendScheduledReport('4:00 PM'), cronOpts);

  console.log(`📅 Telegram status reports scheduled: 6:00 AM and 4:00 PM (${CHICAGO_TZ})`);
}

// ========================================
// TOKEN HEALTH → TELEGRAM (api.cuub.tech)
// ========================================

const DEFAULT_ALERT_CHAT_ID = '-5202000799'; // CUUB_Alert group (same default as scheduled reports)

/** @type {boolean} */
let tokenHealthLastOverallBad = false;
/** @type {number} */
let tokenHealthLastFailureAlertAt = 0;

/**
 * How long to wait before repeating the same failure alert (ms).
 * Override with TOKEN_HEALTH_ALERT_REPEAT_HOURS (default 6).
 */
function tokenHealthRepeatAlertMs() {
  const h = parseFloat(process.env.TOKEN_HEALTH_ALERT_REPEAT_HOURS || '6');
  const hours = Number.isFinite(h) && h > 0 ? h : 6;
  return hours * 60 * 60 * 1000;
}

/**
 * Fetch CUUB token health; classify outcome for alerting.
 * @returns {{ severity: 'ok'|'warn'|'crit', headline: string, detail: string, tokenRefreshUrl: string, recovery: boolean }}
 */
async function evaluateTokenHealthForAlert() {
  const healthUrl = process.env.TOKEN_HEALTH_URL || 'https://api.cuub.tech/token/health';
  const fallbackRefreshUrl = process.env.TOKEN_REFRESH_URL || 'https://api.cuub.tech/token';

  let data = null;
  let httpStatus = 0;
  let fetchError = null;

  try {
    const res = await fetch(healthUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    httpStatus = res.status;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      fetchError = new Error(`Non-JSON response (HTTP ${httpStatus}): ${text.slice(0, 200)}`);
    }
  } catch (e) {
    fetchError = e;
  }

  const tokenRefreshUrl =
    (data && typeof data.tokenRefreshUrl === 'string' && data.tokenRefreshUrl.trim()) ||
    fallbackRefreshUrl;

  if (fetchError && !data) {
    return {
      severity: 'crit',
      headline: 'CUUB token health check unreachable',
      detail: `${healthUrl}\n${fetchError.message || String(fetchError)}`,
      tokenRefreshUrl,
      recovery: false,
    };
  }

  if (!data) {
    return {
      severity: 'crit',
      headline: 'CUUB token health returned invalid JSON',
      detail: `HTTP ${httpStatus}. ${fetchError ? fetchError.message : ''}`.trim(),
      tokenRefreshUrl,
      recovery: false,
    };
  }

  if (data.success === false) {
    return {
      severity: 'crit',
      headline: 'CUUB token health service error',
      detail: String(data.error || data.message || JSON.stringify(data)).slice(0, 500),
      tokenRefreshUrl,
      recovery: false,
    };
  }

  if (data.tokenNeedsAttention === true) {
    return {
      severity: 'crit',
      headline: 'CUUB / Energo token needs attention',
      detail: String(
        data.message ||
          `tokenPresent=${data.tokenPresent} tokenValid=${data.tokenValid} httpStatus=${data.httpStatus}`,
      ).slice(0, 500),
      tokenRefreshUrl,
      recovery: false,
    };
  }

  if (data.energoApiReachable === false) {
    return {
      severity: 'warn',
      headline: 'Energo API unreachable (from CUUB probe)',
      detail: String(data.message || 'Slot/cabinet probe could not reach backend.energo.vip.').slice(
        0,
        500,
      ),
      tokenRefreshUrl,
      recovery: false,
    };
  }

  return {
    severity: 'ok',
    headline: 'CUUB token health OK',
    detail: data.checkedAt ? `Last check: ${data.checkedAt}` : '',
    tokenRefreshUrl,
    recovery: true,
  };
}

/**
 * Run one token health check and notify Telegram when appropriate (throttled).
 */
async function checkTokenHealthAndAlert() {
  const alertsOff = ['0', 'false', 'no', 'off'].includes(
    String(process.env.TOKEN_HEALTH_ALERTS || '1').toLowerCase(),
  );
  if (alertsOff) {
    return;
  }

  const chatId = process.env.TELEGRAM_CHAT_ID || DEFAULT_ALERT_CHAT_ID;
  const outcome = await evaluateTokenHealthForAlert();
  const isBad = outcome.severity !== 'ok';
  const now = Date.now();

  if (isBad) {
    if (!tokenHealthLastOverallBad) {
      tokenHealthLastOverallBad = true;
      tokenHealthLastFailureAlertAt = now;
      const body = `⚠️ ${outcome.headline}\n\n${outcome.detail}\n\nRefresh token:\n${outcome.tokenRefreshUrl}`;
      await sendMessage(chatId, body);
      console.log(`📣 Token health alert sent (${outcome.severity}): ${outcome.headline}`);
      return;
    }
    if (now - tokenHealthLastFailureAlertAt >= tokenHealthRepeatAlertMs()) {
      tokenHealthLastFailureAlertAt = now;
      const body = `⚠️ ${outcome.headline} (still)\n\n${outcome.detail}\n\nRefresh token:\n${outcome.tokenRefreshUrl}`;
      await sendMessage(chatId, body);
      console.log(`📣 Token health repeat alert (${outcome.severity}): ${outcome.headline}`);
    }
    return;
  }

  if (tokenHealthLastOverallBad) {
    tokenHealthLastOverallBad = false;
    tokenHealthLastFailureAlertAt = 0;
    const body = `✅ ${outcome.headline}\n${outcome.detail ? `${outcome.detail}\n` : ''}\nToken refresh (if ever needed):\n${outcome.tokenRefreshUrl}`;
    await sendMessage(chatId, body);
    console.log('📣 Token health recovery message sent');
  }
}

/**
 * Schedule periodic GET /token/health checks and Telegram alerts to the same group as reports.
 */
function scheduleTokenHealthAlerts() {
  const alertsOff = ['0', 'false', 'no', 'off'].includes(
    String(process.env.TOKEN_HEALTH_ALERTS || '1').toLowerCase(),
  );
  if (alertsOff) {
    console.log('⏭️  Token health Telegram alerts disabled (TOKEN_HEALTH_ALERTS=0)');
    return;
  }

  const healthUrl = process.env.TOKEN_HEALTH_URL || 'https://api.cuub.tech/token/health';
  const cronExpr = process.env.TOKEN_HEALTH_CRON || '*/15 * * * *';
  const cronOpts = { timezone: CHICAGO_TZ };

  cron.schedule(
    cronExpr,
    () => {
      checkTokenHealthAndAlert().catch((err) => {
        console.error('❌ Token health check failed:', err.message || err);
      });
    },
    cronOpts,
  );

  console.log(
    `📡 Token health checks scheduled (${cronExpr}, ${CHICAGO_TZ}): ${healthUrl} → Telegram on failure`,
  );
}

// ========================================
// TELEGRAM BOT COMMAND HANDLER
// ========================================

/**
 * Start polling for Telegram messages and handle /status command
 */
function startTelegramCommandPolling() {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8279022767:AAHPZ4IJE6Blcm3wuNW9L1-HEoY1QjNoQ8I';
  const TELEGRAM_API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
  let lastUpdateId = 0;
  
  // Get fetch for HTTP requests
  let fetch;
  if (typeof globalThis.fetch === 'undefined') {
    fetch = require('node-fetch');
  } else {
    fetch = globalThis.fetch;
  }
  
  const pollForMessages = async () => {
    /** If anything hangs, we still reschedule — otherwise the bot stops until process restart. */
    let delayMs = 3000;
    try {
      // Get updates from Telegram (short long-poll)
      const url =
        lastUpdateId > 0
          ? `${TELEGRAM_API_BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`
          : `${TELEGRAM_API_BASE}/getUpdates?timeout=1`;

      const response = await fetch(url, {
        signal: AbortSignal.timeout(TELEGRAM_GET_UPDATES_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.error(`❌ Telegram API HTTP error: ${response.status} ${response.statusText}`);
        delayMs = 5000;
        return;
      }

      const data = await response.json();

      if (!data.ok) {
        console.error('❌ Telegram API error:', data.description);
        delayMs = 5000;
        return;
      }

      if (data.result && data.result.length > 0) {
        console.log(`📥 Received ${data.result.length} update(s) from Telegram`);

        for (const update of data.result) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);

          if (update.message && update.message.text) {
            const messageText = update.message.text.trim();
            const chatId = update.message.chat.id;
            const chatTitle = update.message.chat.title || update.message.chat.first_name || 'Unknown';
            const username = update.message.from?.username || update.message.from?.first_name || 'Unknown';

            console.log(`💬 Message received: "${messageText}" from ${username} in ${chatTitle} (chatId: ${chatId})`);

            if (
              messageText === '/status' ||
              messageText.startsWith('/status@') ||
              messageText.startsWith('/status ')
            ) {
              console.log(`📨 /status command detected from chat: ${chatTitle} (${chatId})`);
              try {
                await Promise.race([
                  sendStationStatus(chatId.toString()),
                  new Promise((_, reject) =>
                    setTimeout(
                      () =>
                        reject(
                          new Error(
                            `sendStationStatus exceeded ${TELEGRAM_STATUS_COMMAND_TIMEOUT_MS}ms (stations API or Telegram send hung)`,
                          ),
                        ),
                      TELEGRAM_STATUS_COMMAND_TIMEOUT_MS,
                    ),
                  ),
                ]);
                console.log(`✅ Status report sent to chat ${chatId}`);
              } catch (error) {
                console.error(`❌ Error sending status report to chat ${chatId}:`, error.message);
                console.error('Error stack:', error.stack);
                try {
                  await sendMessage(
                    chatId.toString(),
                    '❌ Error fetching station status. Please try again later.',
                  );
                } catch (sendError) {
                  console.error('Failed to send error message:', sendError);
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Error polling Telegram messages:', error.message);
      console.error('Error stack:', error.stack);
      delayMs = 5000;
    } finally {
      setTimeout(pollForMessages, delayMs);
    }
  };
  
  console.log('🤖 Starting Telegram bot command polling...');
  console.log(`   Bot token: ${BOT_TOKEN.substring(0, 10)}...${BOT_TOKEN.substring(BOT_TOKEN.length - 5)}`);
  console.log('   Listening for /status command');
  console.log('   Starting in 10 seconds...');
  
  // Start polling after a short delay
  setTimeout(pollForMessages, 10000); // Wait 10 seconds after server starts
}

// Export functions
module.exports = {
  sendMessage,
  sendHelloWorld,
  sendStationStatus,
  fetchStations,
  formatStationStatus,
  getUpdates,
  getChatId,
  scheduleDailyTelegramReport,
  scheduleTokenHealthAlerts,
  checkTokenHealthAndAlert,
  evaluateTokenHealthForAlert,
  startTelegramCommandPolling,
};

// If running directly, try to get chat_id and send station status
if (require.main === module) {
  (async () => {
    // Default chat ID (CUUB_Alert group)
    const DEFAULT_CHAT_ID = '-5202000799';
    
    // First, try to get chat_id from environment variable or command line
    const chatId = process.env.TELEGRAM_CHAT_ID || process.argv[2] || DEFAULT_CHAT_ID;
    
    try {
      if (chatId) {
        // Send station status report
        await sendStationStatus(chatId);
      } else {
        // Otherwise, try to find chat_id from updates
        console.log('No chat_id provided. Attempting to find it from recent messages...');
        const foundChatId = await getChatId();
        
        if (foundChatId) {
          console.log('\nSending station status report...');
          await sendStationStatus(foundChatId);
        } else {
          console.log('\nUsage:');
          console.log('  node telegram_bot.js [chat_id]');
          console.log('  or set TELEGRAM_CHAT_ID environment variable');
          console.log('\nTo find your chat_id:');
          console.log('  1. Send a message to https://t.me/cuub_chicago_bot');
          console.log('  2. Run: node -e "require(\'./telegram_bot.js\').getChatId()"');
        }
      }
    } catch (error) {
      console.error('❌ Fatal error:', error.message);
      process.exit(1);
    }
  })();
}
