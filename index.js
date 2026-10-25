
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('JJ Files Bot is online!');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Web server running on port ' + PORT);
});

if (!token) {
  console.error('BOT_TOKEN is missing!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const movieId = match && match[1] ? match[1] : null;

  const message = movieId
    ? 'Welcome to JJ Movies!\nMovie ID: ' + movieId +
      '\nMovie delivery is not connected yet.'
    : 'Welcome to JJ Movies! 🎬\nJJ Files Bot is running.';

  bot.sendMessage(chatId, message).catch(console.error);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, 'JJ Movies Bot\n/start - Start\n/help - Help')
    .catch(console.error);
});

bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error.message);
});

console.log('JJ Files Bot started!');
