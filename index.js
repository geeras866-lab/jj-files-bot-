
var http = require("http");
var https = require("https");
var TelegramBot = require("node-telegram-bot-api");

var token = process.env.BOT_TOKEN;
var SUPABASE_URL = process.env.SUPABASE_URL;
var SUPABASE_KEY = process.env.SUPABASE_KEY;
var PORT = process.env.PORT || 10000;

var DELETE_AFTER_MS = 5 * 60 * 1000;

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

// Read data from Supabase using the configured API key.
function supabaseGet(path) {
  return new Promise(function (resolve, reject) {
    var requestUrl = new URL(SUPABASE_URL + path);

    var options = {
      hostname: requestUrl.hostname,
      port: 443,
      path: requestUrl.pathname + requestUrl.search,
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        Accept: "application/json"
      }
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

// Convert a Telegram message link into a source chat ID and message ID.
function getTelegramMessage(link) {
  var parsed;

  try {
    parsed = new URL(link);
  } catch (error) {
    throw new Error("Invalid Telegram link");
  }

  var host = parsed.hostname.toLowerCase();

  if (host !== "t.me" && host !== "telegram.me") {
    throw new Error("The source must be a Telegram message link");
  }

  var parts = parsed.pathname.split("/").filter(Boolean);

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

  throw new Error("Unsupported Telegram message link format");
}

// Send the selected movie version to the user.
function sendMovieVersion(chatId, versionId) {
  if (!/^\d+$/.test(String(versionId))) {
    return bot.sendMessage(
      chatId,
      "Invalid movie link. Please open the quality button on JJ Movies again."
    );
  }

  var versionPath =
    "/rest/v1/movie_versions?select=id,movie_id,quality,audio_language,viewing_url" +
    "&id=eq." + encodeURIComponent(versionId) +
    "&limit=1";

  return supabaseGet(versionPath)
    .then(function (versions) {
      if (!versions.length) {
        throw new Error("Movie version not found");
      }

      var version = versions[0];

      var moviePath =
        "/rest/v1/movies?select=id,title,is_published" +
        "&id=eq." + encodeURIComponent(version.movie_id) +
        "&is_published=eq.true&limit=1";

      return supabaseGet(moviePath).then(function (movieRows) {
        if (!movieRows.length) {
          throw new Error("Movie is not published");
        }

        if (!version.viewing_url) {
          throw new Error("Telegram source link is missing");
        }

        var source = getTelegramMessage(version.viewing_url);

        console.log(
          "Sending version " + version.id +
          " (" + version.quality + ") to user " + chatId
        );

        return bot.copyMessage(
          chatId,
          source.chatId,
          source.messageId
        ).then(function (copiedMessage) {
          console.log(
            "File delivered. Message ID: " +
            copiedMessage.message_id
          );

          // Warn immediately after successful delivery.
          bot.sendMessage(
            chatId,
            "⚠️ This file will be deleted from this chat in 5 minutes.\n\n" +
            "Please save or forward it before the time expires!"
          ).catch(function (error) {
            console.error("Warning message failed:", error.message);
          });

          // Delete the delivered file/message after five minutes.
          setTimeout(function () {
            bot.deleteMessage(
              chatId,
              copiedMessage.message_id
            ).then(function () {
              console.log(
                "Delivered message deleted after 5 minutes."
              );
            }).catch(function (error) {
              console.error(
                "Could not delete delivered message:",
                error.message
              );
            });
          }, DELETE_AFTER_MS);

          return copiedMessage;
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
        console.error("Could not send error message:", sendError.message);
      });
    });
}

// Website deep link: https://t.me/jj_files_bot?start=VERSION_ID
bot.onText(/\/start(?:\s+(.+))?/, function (msg, match) {
  var chatId = msg.chat.id;
  var payload = match && match[1] ? match[1].trim() : "";

  if (!payload) {
    return bot.sendMessage(
      chatId,
      "Welcome to JJ Movies! 🎬\n\n" +
      "Open JJ Movies website and choose a movie quality to receive a file.\n\n" +
      "⚠️ Delivered files are scheduled for deletion after 5 minutes. " +
      "Please save or forward them before then."
    );
  }

  sendMovieVersion(chatId, payload);
});

bot.onText(/\/help/, function (msg) {
  bot.sendMessage(
    msg.chat.id,
    "JJ Movies Bot 🎬\n\n" +
    "/start - Start the bot\n" +
    "/help - Show help\n\n" +
    "Files are scheduled for deletion 5 minutes after delivery. " +
    "Please save or forward them in time."
  ).catch(function (error) {
    console.error("Help message failed:", error.message);
  });
});

bot.on("polling_error", function (error) {
  console.error("Telegram polling error:", error.message);
});

console.log("JJ Files Bot started!");
