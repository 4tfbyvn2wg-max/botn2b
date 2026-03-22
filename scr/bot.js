const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const fs = require("fs");
const https = require("https");

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("❌ La variable DISCORD_TOKEN est manquante dans les secrets.");
  process.exit(1);
}

// ─── CLIENT ──────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ─── STOCKAGE ────────────────────────────────────────────────────────────────

let artists = {}; // { channelId: "Nom affiché" }
let lastVideos = {}; // { channelId: "lastVideoId" }
let notifChannelId = null;

const DATA_DIR = "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const ARTISTS_FILE = `${DATA_DIR}/artists.json`;
const CHANNEL_FILE = `${DATA_DIR}/channel.json`;
const LAST_FILE = `${DATA_DIR}/lastVideos.json`;

if (fs.existsSync(ARTISTS_FILE))
  artists = JSON.parse(fs.readFileSync(ARTISTS_FILE, "utf-8"));
if (fs.existsSync(CHANNEL_FILE))
  notifChannelId = JSON.parse(fs.readFileSync(CHANNEL_FILE, "utf-8"));
if (fs.existsSync(LAST_FILE))
  lastVideos = JSON.parse(fs.readFileSync(LAST_FILE, "utf-8"));

if (Array.isArray(artists)) {
  artists = {};
  fs.writeFileSync(ARTISTS_FILE, JSON.stringify(artists, null, 2));
}

function save() {
  fs.writeFileSync(ARTISTS_FILE, JSON.stringify(artists, null, 2));
  fs.writeFileSync(LAST_FILE, JSON.stringify(lastVideos, null, 2));
}

// ─── HTTP GET HELPER ─────────────────────────────────────────────────────────

function httpGet(url, redirectCount = 0, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (redirectCount > 5) return resolve(null);

    const options = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
        Connection: "keep-alive",
      },
    };

    const req = https
      .get(url, options, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : `https://www.youtube.com${res.headers.location}`;
          return resolve(httpGet(next, redirectCount + 1, timeoutMs));
        }

        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", () => resolve(null));

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// ─── RÉSOLUTION HANDLE → CHANNEL ID ─────────────────────────────────────────

/**
 * Accepte toutes ces formes :
 *   UCxxxxxx                           → ID direct
 *   @CentralCee                        → handle
 *   https://youtube.com/@CentralCee    → URL handle
 *   https://youtube.com/channel/UCxxx → URL channel
 *   https://youtube.com/c/nom          → URL custom
 *
 * Retourne { channelId, name } ou null.
 */
async function resolveChannel(input) {
  input = input
    .trim()
    .replace(/[?&]si=[^&\s]+/g, "")
    .trim();

  // 1. Déjà un channel ID valide
  if (/^UC[\w-]{22}$/.test(input)) {
    const v = await fetchLatestVideo(input);
    return { channelId: input, name: v?.author ?? input };
  }

  // 2. URL contenant /channel/UCxxx
  const directIdMatch = input.match(/\/channel\/(UC[\w-]{22})/);
  if (directIdMatch) {
    const id = directIdMatch[1];
    const v = await fetchLatestVideo(id);
    return { channelId: id, name: v?.author ?? id };
  }

  // 2b. URL d'une vidéo YouTube (watch?v=, youtu.be/, /shorts/, /live/)
  const videoIdMatch = input.match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/,
  );
  if (videoIdMatch) {
    const videoId = videoIdMatch[1];
    console.log(
      `🎬 URL vidéo détectée, extraction de la chaîne pour : ${videoId}`,
    );
    // Essai via oEmbed → author_url peut contenir /channel/UCxxx ou /@handle
    const oEmbed = await httpGet(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    );
    if (oEmbed) {
      try {
        const data = JSON.parse(oEmbed);
        const authorUrl = data.author_url ?? "";
        // Cas 1 : author_url contient directement /channel/UCxxx
        const chIdFromOembed = authorUrl.match(/\/channel\/(UC[\w-]{22})/);
        if (chIdFromOembed) {
          const channelId = chIdFromOembed[1];
          const v = await fetchLatestVideo(channelId);
          return {
            channelId,
            name: v?.author ?? data.author_name ?? channelId,
          };
        }
        // Cas 2 : author_url contient /@handle → scraper cette page
        const handleFromOembed = authorUrl.match(/\/@([\w.-]+)/);
        if (handleFromOembed) {
          const html = await httpGet(
            `https://www.youtube.com/@${handleFromOembed[1]}`,
          );
          if (html) {
            const found =
              html.match(/"browseId":"(UC[\w-]{22})"/) ||
              html.match(/\/channel\/(UC[\w-]{22})/);
            if (found) {
              const channelId = found[1];
              const v = await fetchLatestVideo(channelId);
              return {
                channelId,
                name: v?.author ?? data.author_name ?? channelId,
              };
            }
          }
        }
      } catch {
        /* continue */
      }
    }
    // Fallback : scraper la page vidéo directement
    const page = await httpGet(`https://www.youtube.com/watch?v=${videoId}`);
    if (page) {
      const found =
        page.match(/"browseId":"(UC[\w-]{22})"/) ||
        page.match(/\/channel\/(UC[\w-]{22})/);
      if (found) {
        const channelId = found[1];
        const v = await fetchLatestVideo(channelId);
        return { channelId, name: v?.author ?? channelId };
      }
    }
    return null;
  }

  // 3. Extraire le handle depuis n'importe quelle URL ou entrée directe
  let handle = input;
  const handleFromUrl = input.match(/youtube\.com\/@([\w.-]+)/);
  const customFromUrl = input.match(/youtube\.com\/c\/([\w.-]+)/);
  if (handleFromUrl) handle = handleFromUrl[1];
  else if (customFromUrl) handle = customFromUrl[1];
  else
    handle = handle
      .replace(/^https?:\/\/(www\.)?youtube\.com\/?/, "")
      .replace(/^@/, "");

  handle = handle.split("?")[0].split("/")[0].trim();

  console.log(`🔍 Résolution du handle : ${handle}`);

  // 4. Essayer via l'API Invidious (alternative open-source à YouTube)
  const invidiousInstances = [
    "https://inv.nadeko.net",
    "https://invidious.privacyredirect.com",
    "https://yt.cdaut.de",
  ];

  for (const instance of invidiousInstances) {
    try {
      const apiUrl = `${instance}/api/v1/search?q=${encodeURIComponent(handle)}&type=channel`;
      console.log(`🔍 Essai Invidious : ${instance}`);
      const data = await httpGet(apiUrl);
      if (!data) continue;

      const results = JSON.parse(data);
      if (!Array.isArray(results) || results.length === 0) continue;

      // Trouver le premier canal qui correspond au handle
      const match = results.find(
        (r) =>
          r.type === "channel" &&
          (r.authorId?.startsWith("UC") ||
            r.handle?.toLowerCase() === `@${handle.toLowerCase()}` ||
            r.author?.toLowerCase().includes(handle.toLowerCase())),
      );

      if (match?.authorId) {
        const channelId = match.authorId;
        const name = match.author ?? handle;
        console.log(
          `✅ Résolu via Invidious : ${handle} → ${channelId} (${name})`,
        );
        return { channelId, name };
      }
    } catch {
      continue;
    }
  }

  // 5. Fallback : scraper directement la page YouTube
  const urlsToTry = [
    `https://www.youtube.com/@${handle}`,
    `https://www.youtube.com/c/${handle}`,
  ];

  for (const pageUrl of urlsToTry) {
    const html = await httpGet(pageUrl);
    if (!html) continue;

    const patterns = [
      /"browseId":"(UC[\w-]{22})"/,
      /\/channel\/(UC[\w-]{22})/,
      /"channelId":"(UC[\w-]{22})"/,
      /"externalChannelId":"(UC[\w-]{22})"/,
    ];

    for (const pattern of patterns) {
      const found = html.match(pattern);
      if (found) {
        const channelId = found[1];
        const v = await fetchLatestVideo(channelId);
        const name = v?.author ?? handle;
        console.log(
          `✅ Résolu via scraping : ${handle} → ${channelId} (${name})`,
        );
        return { channelId, name };
      }
    }
  }

  return null;
}

// ─── FLUX RSS YOUTUBE ────────────────────────────────────────────────────────

function fetchLatestVideo(channelId) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    httpGet(url).then(async (xml) => {
      if (!xml) return resolve(null);
      try {
        const videoIdMatch = xml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
        const titleMatches = xml.match(/<title>([^<]+)<\/title>/g);
        const authorMatch = xml.match(/<name>([^<]+)<\/name>/);

        if (!videoIdMatch) return resolve(null);

        const videoId = videoIdMatch[1];
        const title =
          titleMatches?.[1]?.replace(/<\/?title>/g, "").trim() ?? "Sans titre";
        const author = authorMatch?.[1]?.trim() ?? channelId;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const shortsPage = await httpGet(
          `https://www.youtube.com/shorts/${videoId}`,
        );
        if (shortsPage && shortsPage.includes('"isShort":true'))
          return resolve(null);
        resolve({ videoId, title, author, url: videoUrl });
      } catch {
        resolve(null);
      }
    });
  });
}

// ─── VÉRIFICATION DES NOUVELLES VIDÉOS ───────────────────────────────────────

async function checkNew() {
  const channelIds = Object.keys(artists);
  if (!notifChannelId || channelIds.length === 0) return;

  const discordChannel = client.channels.cache.get(notifChannelId);
  if (!discordChannel) {
    console.warn("⚠️  Salon Discord introuvable :", notifChannelId);
    return;
  }

  for (const channelId of channelIds) {
    const latest = await fetchLatestVideo(channelId);
    if (!latest) {
      console.warn(
        `⚠️  Pas de vidéo récupérée pour : ${artists[channelId]} (${channelId})`,
      );
      continue;
    }

    if (!lastVideos[channelId]) {
      lastVideos[channelId] = latest.videoId;
      save();
      continue;
    }

    if (latest.videoId !== lastVideos[channelId]) {
      lastVideos[channelId] = latest.videoId;
      save();
      try {
        await discordChannel.send(
          `🎵 **Nouvelle sortie !**\n` +
            `**${latest.author}** vient de publier : **${latest.title}**\n` +
            `${latest.url}`,
        );
        console.log(`📢 Nouvelle vidéo : ${latest.author} — ${latest.title}`);
      } catch (err) {
        console.error(
          `❌ Impossible d'envoyer la notification pour ${latest.author} : ${err.message}`,
        );
        console.error(
          `   → Vérifie que le bot a la permission "Envoyer des messages" dans le salon.`,
        );
      }
    }
  }
}

// ─── COMMANDES SLASH ─────────────────────────────────────────────────────────

const slashCommands = [
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Ajouter un artiste à suivre")
    .addStringOption((opt) =>
      opt
        .setName("artiste")
        .setDescription("URL YouTube, @handle, ou ID de chaîne (UCxxxxxx)")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Retirer un artiste de la liste")
    .addStringOption((opt) =>
      opt
        .setName("artiste")
        .setDescription("URL YouTube, @handle, ou ID de chaîne")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("list")
    .setDescription("Afficher la liste des artistes suivis"),

  new SlashCommandBuilder()
    .setName("channel")
    .setDescription("Définir le salon où poster les notifications")
    .addChannelOption((opt) =>
      opt.setName("salon").setDescription("Choisis le salon").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("check")
    .setDescription("Forcer la vérification des nouvelles vidéos maintenant"),
];

// ─── ENREGISTREMENT DES COMMANDES ────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: slashCommands.map((cmd) => cmd.toJSON()),
    });
    console.log(`✅ ${slashCommands.length} commandes slash enregistrées.`);
  } catch (err) {
    console.error("❌ Erreur :", err);
  }
}

// ─── PROTECTION ANTI-CRASH GLOBALE ───────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error(
    "❌ [UNCAUGHT EXCEPTION] Le bot ne crash pas grâce à la protection :",
    err?.message ?? err,
  );
});

process.on("unhandledRejection", (reason) => {
  console.error(
    "❌ [UNHANDLED REJECTION] Le bot ne crash pas grâce à la protection :",
    reason?.message ?? reason,
  );
});

// ─── ÉVÉNEMENTS ──────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  registerCommands();

  // Lancer la 1ère vérification avec protection
  safeCheck();
  setInterval(safeCheck, 10 * 60 * 1000);
  console.log("⏱️  Vérification automatique toutes les 10 min.");
});

async function safeCheck() {
  try {
    await checkNew();
  } catch (err) {
    console.error("❌ Erreur dans checkNew (ignorée) :", err?.message ?? err);
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  try {
    // /add
    if (cmd === "add") {
      const input = interaction.options.getString("artiste");
      await interaction.deferReply();

      const resolved = await resolveChannel(input);
      if (!resolved) {
        return interaction.editReply(
          `❌ Impossible de trouver la chaîne : \`${input}\`\n\n` +
            `Essaie avec l'URL complète de la chaîne YouTube (pas d'une vidéo).`,
        );
      }

      const { channelId, name } = resolved;
      if (artists[channelId]) {
        return interaction.editReply(`❗ **${name}** est déjà dans la liste.`);
      }

      artists[channelId] = name;
      save();
      console.log(`➕ Ajouté : ${name} (${channelId})`);
      return interaction.editReply(
        `✅ **${name}** ajouté ! Notif dès qu'il/elle sort quelque chose.`,
      );
    }

    // /remove
    if (cmd === "remove") {
      const input = interaction.options.getString("artiste");
      await interaction.deferReply();

      let channelId = null;
      let name = null;

      if (artists[input]) {
        channelId = input;
        name = artists[input];
      } else {
        // Cherche par nom
        const found = Object.entries(artists).find(
          ([, n]) => n.toLowerCase() === input.toLowerCase(),
        );
        if (found) {
          channelId = found[0];
          name = found[1];
        } else {
          const resolved = await resolveChannel(input);
          if (resolved && artists[resolved.channelId]) {
            channelId = resolved.channelId;
            name = artists[channelId];
          }
        }
      }

      if (!channelId) {
        return interaction.editReply(`❗ Artiste introuvable dans la liste.`);
      }

      delete artists[channelId];
      delete lastVideos[channelId];
      save();
      return interaction.editReply(`🗑️ **${name}** retiré de la liste.`);
    }

    // /list — paginé pour éviter la limite 2000 chars de Discord
    if (cmd === "list") {
      const entries = Object.entries(artists);
      if (entries.length === 0) {
        return interaction.reply(
          "Aucun artiste suivi. Utilise `/add` pour en ajouter !",
        );
      }

      const sorted = entries.map(([, n]) => `• ${n}`).sort();
      const header = `🎧 **Artistes suivis (${entries.length}) :**\n`;
      const chunks = [];
      let current = header;

      for (const line of sorted) {
        if ((current + "\n" + line).length > 1900) {
          chunks.push(current);
          current = line;
        } else {
          current += (current === header ? "" : "\n") + line;
        }
      }
      chunks.push(current);

      await interaction.reply({ content: chunks[0], ephemeral: false });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i], ephemeral: false });
      }
      return;
    }

    // /channel
    if (cmd === "channel") {
      const salon = interaction.options.getChannel("salon");
      notifChannelId = salon.id;
      fs.writeFileSync(CHANNEL_FILE, JSON.stringify(notifChannelId, null, 2));
      return interaction.reply(`✅ Salon de notifications défini : ${salon}`);
    }

    // /check
    if (cmd === "check") {
      await interaction.deferReply();
      await safeCheck();
      return interaction.editReply("✅ Vérification terminée !");
    }
  } catch (err) {
    console.error(`❌ Erreur commande /${cmd} :`, err?.message ?? err);
    // Tenter d'informer l'utilisateur sans crasher
    try {
      const msg =
        "❌ Une erreur est survenue. Réessaie dans quelques secondes.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch {
      /* ignore */
    }
  }
});

// ─── RECONNEXION AUTO ─────────────────────────────────────────────────────────

client.on("disconnect", () =>
  console.warn("⚠️  Déconnecté de Discord, reconnexion..."),
);
client.on("error", (err) =>
  console.error("❌ Erreur client Discord :", err?.message ?? err),
);

// ─── CONNEXION ───────────────────────────────────────────────────────────────

client.login(TOKEN);
