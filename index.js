
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('BOT_TOKEN environment variable is missing!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const movieId = match && match[1] ? match[1] : null;

  if (movieId) {
    bot.sendMessage(
      chatId,
      'Welcome to JJ Movies!\nMovie ID: ' + movieId +
      '\n\nMovie delivery setup is not connected yet.'
    );
    return;
  }

  bot.sendMessage(
    chatId,
    'Welcome to JJ Movies! 🎬\n\n' +
    'Bot is running.\n' +
    'Open JJ Movies website to choose a movie.'
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'JJ Movies Bot\n\n/start - Start the bot\n/help - Help'
  );
});

bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error.message);
});

console.log('JJ Files Bot is starting...');
