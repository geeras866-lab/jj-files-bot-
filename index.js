
const http = require('http');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_KEY is missing!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

function supabaseGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/rest/v1/' + path);

    const request = https.request(url, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Accept': 'application/json'
      }
    }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);

      response.on('end', () => {
        let data;

        try {
          data = body ? JSON.parse(body) : [];
        } catch (error) {
          reject(new Error('Invalid response from database.'));
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(
            'Database request failed with HTTP ' + response.statusCode
          ));
          return;
        }

        resolve(data);
      });
    });

    request.setTimeout(15000, () => {
      request.destroy(new Error('Database request timed out.'));
    });

    request.on('error', reject);
    request.end();
  });
}

/*
  Accepted examples:
  Private channel: https://t.me/c/3905680085/137
  Public channel:  https://t.me/channelname/137

  Private channel ID 3905680085 becomes -1003905680085.
*/
function getTelegramMessage(link) {
  if (typeof link !== 'string') {
    throw new Error('This quality does not have a Telegram link.');
  }

  let match = link.match(
    /^https:\/\/t\.me\/c\/([0-9]+)\/([0-9]+)\/?$/i
  );

  if (match) {
    return {
      chatId: '-100' + match[1],
      messageId: Number(match[2])
    };
  }

  match = link.match(
    /^https:\/\/t\.me\/([a-zA-Z0-9_]{5,})\/([0-9]+)\/?$/i
  );

  if (match) {
    return {
      chatId: '@' + match[1],
      messageId: Number(match[2])
    };
  }

  throw new Error(
    'Invalid Telegram message link. Please ask the admin to check it.'
  );
}

async function deliverMovie(chatId, versionId) {
  // Only a numeric movie_versions ID is accepted.
  if (!/^[0-9]+$/.test(versionId)) {
    await bot.sendMessage(
      chatId,
      'Invalid movie link. Please open a quality button on the JJ Movies website.'
    );
    return;
  }

  let versions;

  try {
    versions = await supabaseGet(
      'movie_versions?select=id,movie_id,quality,audio_language,viewing_url' +
      '&id=eq.' + encodeURIComponent(versionId) +
      '&limit=1'
    );
  } catch (error) {
    console.error('Could not read movie version:', error.message);
    await bot.sendMessage(
      chatId,
      'Sorry, movie details are temporarily unavailable. Please try again later.'
    );
    return;
  }

  if (!versions || versions.length === 0) {
    await bot.sendMessage(
      chatId,
      'This movie quality link was not found. Please choose another quality on JJ Movies.'
    );
    return;
  }

  const version = versions[0];
  let movies;

  try {
    movies = await supabaseGet(
      'movies?select=id,title,is_published' +
      '&id=eq.' + encodeURIComponent(version.movie_id) +
      '&limit=1'
    );
  } catch (error) {
    console.error('Could not read movie:', error.message);
    await bot.sendMessage(
      chatId,
      'Could not check this movie right now. Please try again later.'
    );
    return;
  }

  if (!movies || movies.length === 0 || movies[0].is_published !== true) {
    await bot.sendMessage(
      chatId,
      'This movie is currently unavailable.'
    );
    return;
  }

  let source;

  try {
    source = getTelegramMessage(version.viewing_url);
  } catch (error) {
    await bot.sendMessage(
      chatId,
      'This quality has an invalid Telegram message link. Please contact the admin.'
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    '🎬 ' + movies[0].title +
    '\nQuality: ' + version.quality +
    '\nAudio: ' + version.audio_language +
    '\n\nYour file is being prepared...'
  );

  try {
    // Copies the exact Telegram message to the user.
    await bot.copyMessage(
      chatId,
      source.chatId,
      source.messageId
    );

    console.log(
      'Delivered version ' + version.id +
      ' to Telegram user ' + chatId
    );

  } catch (error) {
    console.error('Telegram copyMessage failed:', error.message);

    await bot.sendMessage(
      chatId,
      'Sorry, I could not access this file.\n\n' +
      'The admin should check that the bot is a member of the source channel ' +
      'and that the saved message link points to an accessible file.'
    ).catch(console.error);
  }
}

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const payload = match && match[1] ? match[1].trim() : '';

  // Deliveries are intended for private chats.
  if (msg.chat.type !== 'private') {
    bot.sendMessage(
      chatId,
      'Please open JJ Files Bot in a private chat and press Start.'
    ).catch(console.error);
    return;
  }

  if (payload) {
    await deliverMovie(chatId, payload);
    return;
  }

  bot.sendMessage(
    chatId,
    'Welcome to JJ Movies! 🎬\n\n' +
    'You are connected to JJ Files Bot.\n' +
    'To receive a movie, open JJ Movies and select a movie quality.'
  ).catch(console.error);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'JJ Movies Bot 🎬\n\n' +
    '/start - Start the bot\n' +
    '/help - Show help\n\n' +
    'To receive a movie, open JJ Movies and choose a quality.'
  ).catch(console.error);
});

bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error.message);
});

console.log('JJ Files Bot started!');
