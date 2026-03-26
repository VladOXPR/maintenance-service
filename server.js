const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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
