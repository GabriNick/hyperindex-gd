require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    Routes,
    REST,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");

const { Octokit } = require("@octokit/rest");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ==================== GD OFFICIAL SONGS ====================
const GD_OFFICIAL_SONGS = {
    1:  "Stereo Madness",
    2:  "Back On Track",
    3:  "Polargeist",
    4:  "Dry Out",
    5:  "Base After Base",
    6:  "Can't Let Go",
    7:  "Jumper",
    8:  "Time Machine",
    9:  "Cycles",
    10: "xStep",
    11: "Clutterfunk",
    12: "Theory of Everything",
    13: "Electroman Adventures",
    14: "Clubstep",
    15: "Electrodynamix",
    16: "Hexagon Force",
    17: "Blast Processing",
    18: "Theory of Everything 2",
    19: "Geometrical Dominator",
    20: "Deadlocked",
    21: "Fingerdash",
    22: "Dash"
};

// Si el songID está en el rango 1-22, es una canción oficial:
// - En el mensaje de review se muestra el nombre real
// - En el index.json se guarda como negativo (ej: 13 → -13)
function resolveOfficialSong(songId) {
    const num = Number(songId);
    if (GD_OFFICIAL_SONGS[num]) {
        return { isOfficial: true, name: GD_OFFICIAL_SONGS[num], indexId: -num };
    }
    return { isOfficial: false, name: String(songId), indexId: num };
}

// ==================== CONFIG ====================
const GUILD_ID = "1493493321149190174";

const CHANNEL_SUBMIT = "1493748721970577489";   // Solo comandos
const CHANNEL_REVIEW = "1494189412228141107";   // Revisión con botones
const CHANNEL_FILES = "1494134281218560111";    // Canal privado para archivos
const CHANNEL_NOTIFY = "1494184620676218880";   // Notificaciones
const OWNER_ID = "1388922967223832606";

const CHANNELS_COMMANDS_ONLY = [CHANNEL_SUBMIT];

const pendingSubmissions = {};

// ==================== COMMANDS ====================
const commands = [
    new SlashCommandBuilder()
        .setName("submit")
        .setDescription("Submit a song")
        .addAttachmentOption(opt => opt.setName("file").setDescription("Audio file (.mp3)").setRequired(true))
        .addStringOption(opt => opt.setName("name").setDescription("Song name").setRequired(true))
        .addStringOption(opt => opt.setName("artist").setDescription("Artist").setRequired(true))
        .addIntegerOption(opt => opt.setName("levelid").setDescription("Level ID").setRequired(true)),

    new SlashCommandBuilder()
        .setName("submit-mashup")
        .setDescription("Submit a mashup")
        .addAttachmentOption(opt => opt.setName("file").setDescription("Audio file (.mp3)").setRequired(true))
        .addStringOption(opt => opt.setName("gd_song").setDescription("GD Song").setRequired(true))
        .addStringOption(opt => opt.setName("gd_artist").setDescription("GD Artist").setRequired(true))
        .addStringOption(opt => opt.setName("song_name").setDescription("Mashup name").setRequired(true))
        .addStringOption(opt => opt.setName("song_artist").setDescription("Mashup artist").setRequired(true))
        .addStringOption(opt => opt.setName("creator").setDescription("Mashup creator").setRequired(true))
        .addIntegerOption(opt => opt.setName("levelid").setDescription("Level ID").setRequired(true)),

    new SlashCommandBuilder()
        .setName("delete")
        .setDescription("Delete a song (OWNER ONLY)")
        .addIntegerOption(opt => opt.setName("levelid").setDescription("Level ID").setRequired(true))
        .addStringOption(opt => opt.setName("name").setDescription("Song name").setRequired(true)),

    new SlashCommandBuilder()
        .setName("fix-expired-links")
        .setDescription("Check and fix all expired song links (Owner only)")
];

// ==================== REGISTER COMMANDS ====================
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ Commands registered successfully");
    } catch (e) {
        console.error("Error registering commands:", e);
    }
})();

// ==================== BLOQUEO DE MENSAJES ====================
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (CHANNELS_COMMANDS_ONLY.includes(message.channel.id)) {
        await message.delete().catch(() => {});
        try {
            await message.author.send({ content: `⚠️ This channel only allows slash commands (/submit, /submit-mashup).` });
        } catch {
            const temp = await message.channel.send({ content: `${message.author} This channel only allows slash commands.` });
            setTimeout(() => temp.delete().catch(() => {}), 8000);
        }
    }
});

// ==================== INTERACTIONS ====================
client.on("interactionCreate", async interaction => {

    // ==================== BUTTONS ====================
    if (interaction.isButton()) {

        // APPROVE / APPROVE + VERIFY
        // FIX: deferUpdate va acá adentro, no afuera, para no romper el reject modal
        if (interaction.customId.startsWith("approve_") || interaction.customId.startsWith("approve_verify_")) {
            await interaction.deferUpdate().catch(() => {});

            const isVerify = interaction.customId.startsWith("approve_verify_");
            const id = isVerify
                ? interaction.customId.replace("approve_verify_", "")
                : interaction.customId.replace("approve_", "");
            const data = pendingSubmissions[id];

            if (!data) {
                await interaction.editReply({ content: "❌ Submission not found (bot may have restarted).", components: [] });
                return;
            }

            try {
                const OWNER = process.env.GITHUB_OWNER || "gabrinick";
                const REPO = process.env.GITHUB_REPO || "hyperindex-gd";
                const PATH = process.env.GITHUB_PATH || "index.json";

                // 1. Subir el archivo al canal de archivos via webhook
                const filesChannel = await client.channels.fetch(CHANNEL_FILES);
                let webhook = (await filesChannel.fetchWebhooks()).first();
                if (!webhook) {
                    webhook = await filesChannel.createWebhook({ name: "HyperIndex Archive" });
                }

                const uploadedMsg = await webhook.send({
                    files: [{ attachment: data.attachmentBuffer, name: data.attachmentName }]
                });

                const fileUrl = uploadedMsg.attachments.first()?.url;
                if (!fileUrl) throw new Error("Failed to get file URL after upload");

                // 2. Leer el index.json de GitHub
                const { data: file } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: PATH });
                const json = JSON.parse(Buffer.from(file.content, "base64").toString());

                if (!json.nongs) json.nongs = {};
                if (!json.nongs.hosted) json.nongs.hosted = {};

                // 3. Agregar la entrada
                const songKey = `${data.levelid}_${Date.now()}`;
                json.nongs.hosted[songKey] = {
                    name: data.name,
                    artist: data.artist,
                    url: fileUrl,
                    songs: data.songs,
                    verifiedLevelIDs: isVerify ? [data.levelid] : []
                };

                // 4. Guardar en GitHub
                await octokit.repos.createOrUpdateFileContents({
                    owner: OWNER,
                    repo: REPO,
                    path: PATH,
                    message: `Add song: ${data.name}`,
                    content: Buffer.from(JSON.stringify(json, null, 2)).toString("base64"),
                    sha: file.sha
                });

                // 5. Notificar al usuario
                const notifyChannel = await client.channels.fetch(CHANNEL_NOTIFY).catch(() => null);
                if (notifyChannel) {
                    await notifyChannel.send({
                        content: `<@${data.userId}> Your song **${data.name}** has been approved ${isVerify ? "⭐ and verified!" : "✅!"}`,
                        allowedMentions: { users: [data.userId] }
                    });
                }

                // 6. Limpiar y editar el mensaje de review
                delete pendingSubmissions[id];
                await interaction.editReply({
                    content: `${isVerify ? "⭐ Approved + Verified" : "✅ Approved"}: **${data.name}** — ${data.artist}`,
                    components: []
                });

            } catch (err) {
                console.error("[APPROVE ERROR]", err);
                await interaction.editReply({ content: `❌ Error approving: ${err.message}`, components: [] });
            }
            return;
        }

        // REJECT
        // FIX: NO hacemos deferUpdate acá porque necesitamos mostrar un modal
        if (interaction.customId.startsWith("reject_")) {
            const id = interaction.customId.replace("reject_", "");
            const data = pendingSubmissions[id];
            if (!data) {
                await interaction.reply({ content: "❌ Submission not found (bot may have restarted).", ephemeral: true });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`reject_modal_${id}`)
                .setTitle("Reject Submission");

            const reasonInput = new TextInputBuilder()
                .setCustomId("reject_reason")
                .setLabel("Reason for rejection")
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder("Why are you rejecting this song?")
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
            await interaction.showModal(modal);
            return;
        }
    }

    // ==================== MODAL SUBMIT (REJECT) ====================
    if (interaction.isModalSubmit() && interaction.customId.startsWith("reject_modal_")) {
        const id = interaction.customId.replace("reject_modal_", "");
        const data = pendingSubmissions[id];

        if (!data) {
            await interaction.reply({ content: "❌ Submission not found (bot may have restarted).", ephemeral: true });
            return;
        }

        const reason = interaction.fields.getTextInputValue("reject_reason");

        // FIX: modales usan deferReply, no deferUpdate
        await interaction.deferReply({ ephemeral: true });

        const notifyChannel = await client.channels.fetch(CHANNEL_NOTIFY).catch(() => null);
        if (notifyChannel) {
            await notifyChannel.send({
                content: `<@${data.userId}> Your song **${data.name}** has been rejected ❌\n\n**Reason:** ${reason}`,
                allowedMentions: { users: [data.userId] }
            });
        }

        // Editar el mensaje original de review para sacar los botones
        try {
            const reviewChannel = await client.channels.fetch(CHANNEL_REVIEW);
            // Buscar el mensaje que tiene los botones de esta submission
            const messages = await reviewChannel.messages.fetch({ limit: 50 });
            const reviewMsg = messages.find(m =>
                m.components.length > 0 &&
                m.components[0].components.some(c => c.customId === `reject_${id}`)
            );
            if (reviewMsg) {
                await reviewMsg.edit({
                    content: `${reviewMsg.content}\n\n❌ **Rejected** — Reason: ${reason}`,
                    components: []
                });
            }
        } catch (e) {
            console.error("[REJECT] Could not edit review message:", e);
        }

        delete pendingSubmissions[id];

        await interaction.editReply({ content: `❌ **${data.name}** rejected.\nReason: ${reason}` });
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // ==================== SUBMIT / SUBMIT-MASHUP ====================
    if (interaction.commandName === "submit" || interaction.commandName === "submit-mashup") {
        const attachment = interaction.options.getAttachment("file");

        const data = {
            name: interaction.commandName === "submit"
                ? interaction.options.getString("name")
                : `${interaction.options.getString("gd_song")} X ${interaction.options.getString("song_artist")} - ${interaction.options.getString("song_name")}`,
            artist: interaction.commandName === "submit"
                ? interaction.options.getString("artist")
                : `${interaction.options.getString("gd_artist")} (mashup by ${interaction.options.getString("creator")})`,
            attachmentUrl: attachment.url,
            attachmentName: attachment.name,
            levelid: interaction.options.getInteger("levelid")
        };

        await sendForReview(interaction, data, interaction.commandName === "submit" ? "New Song" : "New Mashup");
        return;
    }

    // ==================== DELETE ====================
    // FIX: este comando no existía para nada, ahora sí
    if (interaction.commandName === "delete") {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.editReply({ content: "You don't have permission ❌" });
        }

        const levelId = interaction.options.getInteger("levelid");
        const songName = interaction.options.getString("name");

        try {
            const OWNER = process.env.GITHUB_OWNER || "gabrinick";
            const REPO = process.env.GITHUB_REPO || "hyperindex-gd";
            const PATH = process.env.GITHUB_PATH || "index.json";

            const { data: file } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: PATH });
            const json = JSON.parse(Buffer.from(file.content, "base64").toString());

            if (!json.nongs?.hosted) {
                return interaction.editReply({ content: "❌ No songs found in database." });
            }

            // Buscar la entrada por levelid y nombre
            const key = Object.keys(json.nongs.hosted).find(k => {
                const song = json.nongs.hosted[k];
                return k.startsWith(`${levelId}_`) && song.name.toLowerCase() === songName.toLowerCase();
            });

            if (!key) {
                return interaction.editReply({ content: `❌ Song **${songName}** with Level ID **${levelId}** not found.` });
            }

            const deleted = json.nongs.hosted[key];
            delete json.nongs.hosted[key];

            await octokit.repos.createOrUpdateFileContents({
                owner: OWNER,
                repo: REPO,
                path: PATH,
                message: `Delete song: ${deleted.name}`,
                content: Buffer.from(JSON.stringify(json, null, 2)).toString("base64"),
                sha: file.sha
            });

            await interaction.editReply({ content: `🗑️ **${deleted.name}** by ${deleted.artist} has been deleted from the database.` });

        } catch (err) {
            console.error("[DELETE ERROR]", err);
            await interaction.editReply({ content: `❌ Error deleting: ${err.message}` });
        }
        return;
    }

    // ==================== FIX EXPIRED LINKS ====================
    // FIX: ahora realmente repara los links buscando el archivo en CHANNEL_FILES
    if (interaction.commandName === "fix-expired-links") {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.editReply({ content: "You don't have permission ❌" });
        }

        await interaction.editReply({ content: "🔍 Starting full check and repair of expired links..." });

        let checked = 0;
        let fixed = 0;
        let failed = 0;

        try {
            const OWNER = process.env.GITHUB_OWNER || "gabrinick";
            const REPO = process.env.GITHUB_REPO || "hyperindex-gd";
            const PATH = process.env.GITHUB_PATH || "index.json";

            const { data: file } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: PATH });
            const json = JSON.parse(Buffer.from(file.content, "base64").toString());

            if (!json.nongs?.hosted) {
                return interaction.editReply({ content: "No songs found in database." });
            }

            // Cargar todos los mensajes del canal de archivos para buscar los archivos originales
            const filesChannel = await client.channels.fetch(CHANNEL_FILES);
            let webhook = (await filesChannel.fetchWebhooks()).first();
            if (!webhook) {
                webhook = await filesChannel.createWebhook({ name: "HyperIndex Archive" });
            }

            // Traer todos los mensajes del canal de archivos (hasta 500)
            let allMessages = [];
            let lastId = null;
            while (true) {
                const batch = await filesChannel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
                if (batch.size === 0) break;
                allMessages = allMessages.concat([...batch.values()]);
                lastId = batch.last().id;
                if (batch.size < 100) break;
            }

            let changed = false;

            for (const [songKey, song] of Object.entries(json.nongs.hosted)) {
                if (!song.url) continue;
                checked++;

                // Verificar si el link está vivo
                let isAlive = false;
                try {
                    const res = await fetch(song.url, { method: "HEAD" });
                    isAlive = res.ok;
                } catch {
                    isAlive = false;
                }

                if (isAlive) continue;

                console.log(`[FIX] Dead link found: ${song.name} — searching in archive...`);

                // Buscar en los mensajes del canal de archivos un archivo con el mismo nombre
                const matchingMsg = allMessages.find(msg =>
                    msg.attachments.size > 0 &&
                    msg.attachments.some(att =>
                        att.name && song.name &&
                        att.name.toLowerCase().includes(song.name.toLowerCase().split(" ")[0])
                    )
                );

                if (matchingMsg) {
                    const newUrl = matchingMsg.attachments.first().url;
                    json.nongs.hosted[songKey].url = newUrl;
                    fixed++;
                    changed = true;
                    console.log(`[FIX] Repaired: ${song.name} → ${newUrl}`);
                } else {
                    // No encontramos el archivo: re-subir no es posible sin el original
                    failed++;
                    console.log(`[FIX] Could not repair: ${song.name} — file not found in archive`);
                }
            }

            // Guardar cambios en GitHub si hubo reparaciones
            if (changed) {
                await octokit.repos.createOrUpdateFileContents({
                    owner: OWNER,
                    repo: REPO,
                    path: PATH,
                    message: `Fix expired links (${fixed} fixed)`,
                    content: Buffer.from(JSON.stringify(json, null, 2)).toString("base64"),
                    sha: file.sha
                });
            }

            await interaction.editReply({
                content:
                    `✅ Check & Repair completed!\n\n` +
                    `Songs checked: **${checked}**\n` +
                    `Links repaired: **${fixed}**\n` +
                    `Could not repair (file not in archive): **${failed}**` +
                    (failed > 0 ? `\n\n⚠️ Songs that could not be repaired need to be re-submitted manually.` : "")
            });

        } catch (err) {
            console.error("[FIX ERROR]", err);
            await interaction.editReply({ content: `❌ Error during repair: ${err.message}` });
        }
        return;
    }
});

// ==================== SEND FOR REVIEW ====================
async function sendForReview(interaction, data, title) {
    try {
        const fileRes = await fetch(data.attachmentUrl);
        if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);

        data.attachmentBuffer = Buffer.from(await fileRes.arrayBuffer());
        delete data.attachmentUrl;

        const gdbRes = await fetch(`https://gdbrowser.com/api/level/${data.levelid}`);
        if (!gdbRes.ok) throw new Error("GDBrowser error");

        const level = await gdbRes.json();
        if (!level.songID) throw new Error("No songID found");

        const resolved = resolveOfficialSong(level.songID);
        // En el index.json: negativo si es oficial (ej: -13), positivo si es custom
        data.songs = [resolved.indexId];
        // Para mostrar en el mensaje de review
        const songDisplay = resolved.isOfficial
            ? `${resolved.name} (official)`
            : `ID ${resolved.indexId}`;

        const reviewId = Date.now().toString();
        pendingSubmissions[reviewId] = { ...data, userId: interaction.user.id };

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_${reviewId}`).setLabel("Approve ✅").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`approve_verify_${reviewId}`).setLabel("Approve + Verify ⭐").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`reject_${reviewId}`).setLabel("Reject ❌").setStyle(ButtonStyle.Danger)
        );

        const channel = await client.channels.fetch(CHANNEL_REVIEW);
        await channel.send({
            content: `**${title}**: ${data.name} — ${data.artist}\n🎵 Songs: ${songDisplay}`,
            files: [{ attachment: data.attachmentBuffer, name: data.attachmentName }],
            components: [row]
        });

        await interaction.editReply({ content: "✅ Submitted for review" });

    } catch (err) {
        console.error("[ERROR]", err);
        await interaction.editReply({ content: `❌ Error: ${err.message}` }).catch(() => {});
    }
}

client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log("✅ Bot connected successfully"))
    .catch(err => console.error("Login error:", err));