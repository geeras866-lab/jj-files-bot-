var http = require("http");
var https = require("https");
var TelegramBot = require("node-telegram-bot-api");

var token = process.env.BOT_TOKEN;
var SUPABASE_URL = process.env.SUPABASE_URL;
var SUPABASE_KEY = process.env.SUPABASE_KEY;
var PORT = process.env.PORT || 10000;

var DELETE_AFTER_MS = 10 * 60 * 1000; // 10 minutes
var WEBSITE_URL = "https://jj-movies.pages.dev/";

if (!token || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing environment variable: BOT_TOKEN, SUPABASE_URL, or SUPABASE_KEY"
  );
  process.exit(1);
}

SUPABASE_URL = SUPABASE_URL.replace(/\/+$/, "");

var server = http.createServer(function (req, res) {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("JJ Files Bot is online!");
});

server.listen(PORT, "0.0.0.0", function () {
  console.log("Web server running on port " + PORT);
});

var bot = new TelegramBot(token, { polling: true });

// Read data from Supabase.
function supabaseGet(path) {
  return new Promise(function (resolve, reject) {
    var requestUrl = new URL(SUPABASE_URL + path);
    var headers = {
      apikey: SUPABASE_KEY,
      Accept: "application/json"
    };

    if (String(SUPABASE_KEY).startsWith("eyJ")) {
      headers.Authorization = "Bearer " + SUPABASE_KEY;
    }

    var options = {
      hostname: requestUrl.hostname,
      port: 443,
      path: requestUrl.pathname + requestUrl.search,
      method: "GET",
      headers: headers
    };

    var req = https.request(options, function (res) {
      var body = "";

      res.setEncoding("utf8");

      res.on("data", function (chunk) {
        body += chunk;
      });

      res.on("end", function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(
              "Supabase request failed: HTTP " +
              res.statusCode + " " + body
            )
          );
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error("Invalid JSON response from Supabase"));
        }
      });
    });

    req.setTimeout(15000, function () {
      req.destroy(new Error("Supabase request timed out"));
    });

    req.on("error", reject);
    req.end();
  });
}

// Convert Telegram message link into source chat and message ID.
function getTelegramMessage(link) {
  var parsed;

  try {
    parsed = new URL(String(link || "").trim());
  } catch (error) {
    throw new Error("Invalid Telegram link: " + link);
  }

  var host = parsed.hostname.toLowerCase();

  if (host !== "t.me" && host !== "telegram.me" && host !== "www.t.me") {
    throw new Error("Not a Telegram message link: " + link);
  }

  var parts = parsed.pathname.split("/").filter(Boolean);

  // Forum/topic private link: https://t.me/c/3905680085/12/137
  if (
    parts.length >= 4 &&
    parts[0] === "c" &&
    /^\d+$/.test(parts[1]) &&
    /^\d+$/.test(parts[2]) &&
    /^\d+$/.test(parts[3])
  ) {
    return {
      chatId: "-100" + parts[1],
      messageId: Number(parts[3])
    };
  }

  // Private channel link: https://t.me/c/3905680085/137
  if (
    parts.length >= 3 &&
    parts[0] === "c" &&
    /^\d+$/.test(parts[1]) &&
    /^\d+$/.test(parts[2])
  ) {
    return {
      chatId: "-100" + parts[1],
      messageId: Number(parts[2])
    };
  }

  // Public channel link: https://t.me/channelname/137
  if (
    parts.length >= 2 &&
    /^[A-Za-z0-9_]+$/.test(parts[0]) &&
    /^\d+$/.test(parts[1])
  ) {
    return {
      chatId: "@" + parts[0],
      messageId: Number(parts[1])
    };
  }

  throw new Error("Unsupported Telegram message link format: " + link);
}

// Schedule deletion of a bot-sent message after 10 minutes.
function scheduleMessageDeletion(chatId, messageId, label) {
  setTimeout(function () {
    bot.deleteMessage(chatId, messageId)
      .then(function () {
        console.log(label + " deleted after 10 minutes.");
      })
      .catch(function (error) {
        console.error(label + " deletion failed:", error.message);
      });
  }, DELETE_AFTER_MS);
}

// Deliver file from Telegram viewing_url.
function deliverMediaMessage(chatId, version, movieTitle) {
  var fileOptions = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🌐 Open JJ Movies Site", url: WEBSITE_URL }
        ]
      ]
    }
  };

  if (
    version.viewing_url &&
    /^https?:\/\/(www\.)?(t|telegram)\.me\//i.test(String(version.viewing_url).trim())
  ) {
    var source = getTelegramMessage(version.viewing_url);
    console.log(
      "Copying message from " + source.chatId + " #" + source.messageId +
      " for version " + version.id + " (" + movieTitle + ")"
    );
    return bot.copyMessage(chatId, source.chatId, source.messageId, fileOptions);
  }

  throw new Error("Missing or invalid viewing_url on version " + version.id);
}

// Send the selected movie version along with clean 10 mins warning message.
function sendMovieVersion(chatId, versionId) {
  var cleanId = String(versionId || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cleanId)) {
    return bot.sendMessage(
      chatId,
      "Invalid movie link. Please open the quality button on JJ Movies again."
    );
  }

  var versionPath =
    "/rest/v1/movie_versions?select=id,movie_id,quality,audio_language,viewing_url" +
    "&id=eq." + encodeURIComponent(cleanId) +
    "&limit=1";

  return supabaseGet(versionPath)
    .then(function (versions) {
      if (!versions || !versions.length) {
        throw new Error("Movie version not found for id=" + cleanId);
      }

      var version = versions[0];

      var moviePath =
        "/rest/v1/movies?select=id,title,is_published" +
        "&id=eq." + encodeURIComponent(version.movie_id) +
        "&is_published=eq.true&limit=1";

      return supabaseGet(moviePath).then(function (movieRows) {
        if (!movieRows || !movieRows.length) {
          throw new Error("Movie not found or unpublished for movie_id=" + version.movie_id);
        }

        return deliverMediaMessage(chatId, version, movieRows[0].title).then(function (copiedMessage) {
          console.log(
            "File delivered. Message ID: " +
            copiedMessage.message_id
          );

          var warningText =
            "⚠️ This file will be deleted from this chat in 10 minutes.\n\n" +
            "Please save or forward it before the time expires!";

          return bot.sendMessage(
            chatId,
            warningText
          ).then(function (warningMessage) {
            scheduleMessageDeletion(
              chatId,
              copiedMessage.message_id,
              "Delivered file"
            );

            scheduleMessageDeletion(
              chatId,
              warningMessage.message_id,
              "Warning message"
            );

            return copiedMessage;
          }).catch(function (error) {
            console.error("Warning message failed:", error.message);

            scheduleMessageDeletion(
              chatId,
              copiedMessage.message_id,
              "Delivered file"
            );

            return copiedMessage;
          });
        });
      });
    })
    .catch(function (error) {
      console.error("Movie delivery error:", error.message);

      return bot.sendMessage(
        chatId,
        "Sorry bro, this file could not be delivered.\n" +
        "Please try again later or contact the JJ Movies admin."
      ).catch(function (sendError) {
        console.error(
          "Could not send error message:",
          sendError.message
        );
      });
    });
}

// /start command
bot.onText(/\/start(?:\s+(.+))?/, function (msg, match) {
  var chatId = msg.chat.id;
  var payload = match && match[1] ? match[1].trim() : "";

  var startOptions = {
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🌐 Open JJ Movies Site", url: WEBSITE_URL }
        ]
      ]
    }
  };

  if (!payload) {
    return bot.sendMessage(
      chatId,
      "🎬 Welcome to JJ Movies!\n\n" +
      "🍿 Open our website and choose a movie quality to receive the file.\n\n" +
      "⚠️ Delivered files and their warning messages are scheduled " +
      "for deletion after 10 minutes. Please save or forward your file before then.\n\n" +
      "❤️ Enjoy your movie!",
      startOptions
    );
  }

  sendMovieVersion(chatId, payload);
});

// Help command
bot.onText(/\/help/, function (msg) {
  bot.sendMessage(
    msg.chat.id,
    "🎬 JJ Movies Bot\n\n" +
    "/start - Start the bot\n" +
    "/help - Show help\n\n" +
    "Files and their warning messages are scheduled for deletion " +
    "10 minutes after delivery. Please save or forward your file in time.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🌐 Open JJ Movies Site", url: WEBSITE_URL }
          ]
        ]
      }
    }
  ).catch(function (error) {
    console.error("Help message failed:", error.message);
  });
});

// Telegram polling errors
bot.on("polling_error", function (error) {
  console.error("Telegram polling error:", error.message);
});

console.log("JJ Files Bot started with 10 minutes deletion notice!");
