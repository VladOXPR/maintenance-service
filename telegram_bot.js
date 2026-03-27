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
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
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
    const response = await fetch('https://api.cuub.tech/stations');
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data.success || !data.data) {
      throw new Error('Invalid API response format');
    }
    
    return data.data;
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
 * 6-slot (default): green ≥4, yellow 3, red ≤2.
 * 24-slot: green 6–18; yellow at 5 and 19–21; red 0–4 or >21.
 * (Spec "yellow between 6 & 4" treated as 5; 19–21 fills the gap before red >21.)
 * @returns {'red'|'yellow'|'green'|null}
 */
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

/**
 * Sort: red first, then yellow, then green (same thresholds as getFilledSlotHealthLevel).
 */
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

function formatStationStatus(stations) {
  if (!stations || stations.length === 0) {
    return 'No stations found.';
  }
  
  const redYellowStations = stations.filter(station => {
    const filledSlots = station.filled_slots;
    if (filledSlots === null || filledSlots === undefined || filledSlots === 'N/A') {
      return false;
    }
    
    const filledSlotsNum = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : filledSlots;
    if (isNaN(filledSlotsNum)) {
      return false;
    }
    const totalSlots = getTotalSlotsForStation(station);
    const level = getFilledSlotHealthLevel(totalSlots, filledSlotsNum);
    return level === 'red' || level === 'yellow';
  });
  
  // Sort stations: Red first, then Yellow (when we have any)
  const sortedStations = redYellowStations.length === 0
    ? []
    : [...redYellowStations].sort((a, b) => getStationPriority(a) - getStationPriority(b));
  
  let message = '';
  
  if (sortedStations.length === 0) {
    message = 'Network is healthy!';
  }
  
  sortedStations.forEach((station) => {
    const title = station.title || 'Unknown';
    const filledSlots = station.filled_slots !== null && station.filled_slots !== undefined 
      ? station.filled_slots 
      : 0;
    const openSlots = station.open_slots !== null && station.open_slots !== undefined 
      ? station.open_slots 
      : 0;
    
    const totalSlots = getTotalSlotsForStation(station);
    const filledSlotsNum = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : filledSlots;
    const health = getFilledSlotHealthLevel(totalSlots, filledSlotsNum);

    let colorSquare = '';
    if (health === 'green') {
      colorSquare = '🟢';
    } else if (health === 'yellow') {
      colorSquare = '🟨';
    } else if (health === 'red') {
      colorSquare = '🟥';
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
    try {
      // Get updates from Telegram
      // Use timeout=0 to get only new updates, not pending ones
      const url = lastUpdateId > 0 
        ? `${TELEGRAM_API_BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`
        : `${TELEGRAM_API_BASE}/getUpdates?timeout=1`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error(`❌ Telegram API HTTP error: ${response.status} ${response.statusText}`);
        setTimeout(pollForMessages, 5000);
        return;
      }
      
      const data = await response.json();
      
      if (!data.ok) {
        console.error('❌ Telegram API error:', data.description);
        setTimeout(pollForMessages, 5000);
        return;
      }
      
      if (data.result && data.result.length > 0) {
        console.log(`📥 Received ${data.result.length} update(s) from Telegram`);
        
        for (const update of data.result) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          
          // Handle messages
          if (update.message && update.message.text) {
            const messageText = update.message.text.trim();
            const chatId = update.message.chat.id;
            const chatTitle = update.message.chat.title || update.message.chat.first_name || 'Unknown';
            const username = update.message.from?.username || update.message.from?.first_name || 'Unknown';
            
            console.log(`💬 Message received: "${messageText}" from ${username} in ${chatTitle} (chatId: ${chatId})`);
            
            // Handle /status command (can be /status or /status@botname)
            if (messageText === '/status' || messageText.startsWith('/status@') || messageText.startsWith('/status ')) {
              console.log(`📨 /status command detected from chat: ${chatTitle} (${chatId})`);
              try {
                await sendStationStatus(chatId.toString());
                console.log(`✅ Status report sent to chat ${chatId}`);
              } catch (error) {
                console.error(`❌ Error sending status report to chat ${chatId}:`, error.message);
                console.error('Error stack:', error.stack);
                try {
                  await sendMessage(chatId.toString(), '❌ Error fetching station status. Please try again later.');
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
    }
    
    // Poll again after a short delay
    setTimeout(pollForMessages, 3000); // Poll every 3 seconds (reduced from 5)
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
  startTelegramCommandPolling
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

