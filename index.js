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
const axios   = require("axios");
const crypto  = require("crypto");

// ==================== BACKBLAZE B2 ====================
async function uploadToB2(buffer, fileName) {
    const keyId      = process.env.B2_KEY_ID;
    const appKey     = process.env.B2_APP_KEY;
    const bucketId   = process.env.B2_BUCKET_ID;
    const bucketName = process.env.B2_BUCKET_NAME;

    const authRes = await axios.get("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
        auth: { username: keyId, password: appKey }
    });
    const { authorizationToken, apiUrl, downloadUrl } = authRes.data;

    const uploadUrlRes = await axios.post(
        `${apiUrl}/b2api/v2/b2_get_upload_url`,
        { bucketId },
        { headers: { Authorization: authorizationToken } }
    );
    const { uploadUrl, authorizationToken: uploadToken } = uploadUrlRes.data;

    const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
    await axios.post(uploadUrl, buffer, {
        headers: {
            Authorization: uploadToken,
            "X-Bz-File-Name": encodeURIComponent(fileName),
            "Content-Type": "audio/mpeg",
            "Content-Length": buffer.length,
            "X-Bz-Content-Sha1": sha1
        },
        maxBodyLength: Infinity
    });

    return `${downloadUrl}/file/${bucketName}/${encodeURIComponent(fileName)}`;
}

// ==================== GD OFFICIAL SONGS ====================
const GD_OFFICIAL_SONGS = {
    1:  "Stereo Madness",     2:  "Back On Track",
    3:  "Polargeist",         4:  "Dry Out",
    5:  "Base After Base",    6:  "Can't Let Go",
    7:  "Jumper",             8:  "Time Machine",
    9:  "Cycles",             10: "xStep",
    11: "Clutterfunk",        12: "Theory of Everything",
    13: "Electroman Adventures", 14: "Clubstep",
    15: "Electrodynamix",     16: "Hexagon Force",
    17: "Blast Processing",   18: "Theory of Everything 2",
    19: "Geometrical Dominator", 20: "Deadlocked",
    21: "Fingerdash",         22: "Dash"
};

function resolveOfficialSong(songId) {
    const num = Number(songId);
    if (GD_OFFICIAL_SONGS[num]) return { isOfficial: true, name: GD_OFFICIAL_SONGS[num], indexId: -num };
    return { isOfficial: false, name: String(songId), indexId: num };
}

// ==================== CONFIG ====================
const GUILD_ID        = "1493493321149190174";
const CHANNEL_SUBMIT  = "1493748721970577489";
const CHANNEL_FILES   = "1494134281218560111";
const CHANNEL_NOTIFY  = "1494184620676218880";
const CHANNEL_FORUM   = "1505686280875278417";
const OWNER_ID        = "1388922967223832606";
const MOD_ROLE_ID     = "1493712287998017660";

// Forum tag IDs
const TAG_PENDING          = "1505687454190141571";
const TAG_APPROVED         = "1505686453080952883";
const TAG_APPROVED_VERIFY  = "1505686592272994379";
const TAG_REJECTED         = "1505686504637468742";
const TAG_MASHUP           = "1505687534863122632";
const TAG_ORIGINAL         = "1505687564672045228";

const CHANNELS_COMMANDS_ONLY = [CHANNEL_SUBMIT];

// pendingSubmissions: { reviewId -> data }
// data incluye: name, artist, levelid, isMashup, isOriginal, songs, songDisplay,
//               attachmentBuffer, attachmentName, userId, threadId
const pendingSubmissions = {};

// ==================== HELPERS ====================
function isModOrOwner(interaction) {
    if (interaction.user.id === OWNER_ID) return true;
    return interaction.member?.roles?.cache?.has(MOD_ROLE_ID) ?? false;
}

async function getIndex() {
    const OWNER = process.env.GITHUB_OWNER || "gabrinick";
    const REPO  = process.env.GITHUB_REPO  || "hyperindex-gd";
    const PATH  = process.env.GITHUB_PATH  || "index.json";
    const { data: file } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: PATH });
    const json = JSON.parse(Buffer.from(file.content, "base64").toString());
    return { file, json, OWNER, REPO, PATH };
}

async function saveIndex(OWNER, REPO, PATH, json, sha, message) {
    await octokit.repos.createOrUpdateFileContents({
        owner: OWNER, repo: REPO, path: PATH, message,
        content: Buffer.from(JSON.stringify(json, null, 2)).toString("base64"),
        sha
    });
}

// Actualiza los tags y cierra/bloquea el thread del foro
async function closeForumThread(threadId, tagIds) {
    try {
        const thread = await client.channels.fetch(threadId);
        await thread.setAppliedTags(tagIds);
        await thread.setLocked(true);
        await thread.setArchived(true);
    } catch (e) {
        console.error("[FORUM] Could not close thread:", e);
    }
}

// Reconstruye los botones del post del foro (para editar después de un edit de submission)
function buildForumRows(reviewId) {
    const modRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_${reviewId}`).setLabel("Approve ✅").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`approve_verify_${reviewId}`).setLabel("Approve + Verify ⭐").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`reject_${reviewId}`).setLabel("Reject ❌").setStyle(ButtonStyle.Danger)
    );
    const userRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`edit_sub_${reviewId}`).setLabel("✏️ Edit my submission").setStyle(ButtonStyle.Secondary)
    );
    return [modRow, userRow];
}

// ==================== SUBMISSION HISTORY (en memoria) ====================
const submissionHistory = {};

function recordSubmission(userId, entry) {
    if (!submissionHistory[userId]) submissionHistory[userId] = [];
    submissionHistory[userId].unshift(entry);
    if (submissionHistory[userId].length > 50) submissionHistory[userId].length = 50;
}

function updateSubmissionStatus(userId, reviewId, status, reason = null) {
    if (!submissionHistory[userId]) return;
    const entry = submissionHistory[userId].find(e => e.reviewId === reviewId);
    if (entry) {
        entry.status = status;
        if (reason) entry.reason = reason;
    }
}

// ==================== COMMANDS ====================
const commands = [
    new SlashCommandBuilder()
        .setName("submit")
        .setDescription("Submit a song")
        .addAttachmentOption(opt => opt.setName("file").setDescription("Audio file (.mp3)").setRequired(true))
        .addStringOption(opt => opt.setName("name").setDescription("Song name").setRequired(true))
        .addStringOption(opt => opt.setName("artist").setDescription("Artist").setRequired(true))
        .addIntegerOption(opt => opt.setName("levelid").setDescription("Level ID").setRequired(true))
        .addBooleanOption(opt => opt.setName("original").setDescription("Is this an original song?").setRequired(true)),

    new SlashCommandBuilder()
        .setName("submit-mashup")
        .setDescription("Submit a mashup")
        .addAttachmentOption(opt => opt.setName("file").setDescription("Audio file (.mp3)").setRequired(true))
        .addStringOption(opt => opt.setName("gd_song").setDescription("GD Song").setRequired(true))
        .addStringOption(opt => opt.setName("gd_artist").setDescription("GD Artist").setRequired(true))
        .addStringOption(opt => opt.setName("song_name").setDescription("Mashup name").setRequired(true))
        .addStringOption(opt => opt.setName("song_artist").setDescription("Mashup artist").setRequired(true))
        .addStringOption(opt => opt.setName("creator").setDescription("Mashup creator").setRequired(true))
        .addIntegerOption(opt => opt.setName("levelid").setDescription("Level ID").setRequired(true))
        .addBooleanOption(opt => opt.setName("original").setDescription("Is this an original mashup?").setRequired(true)),

    new SlashCommandBuilder()
        .setName("submit-status")
        .setDescription("See the status of all your submissions"),

    new SlashCommandBuilder()
        .setName("edit-approved")
        .setDescription("Edit an approved song (mods/owner only)")
        .addIntegerOption(opt => opt.setName("levelid").setDescription("Level ID").setRequired(true))
        .addStringOption(opt => opt.setName("name").setDescription("Current song name").setRequired(true))
        .addStringOption(opt => opt.setName("new_name").setDescription("New song name").setRequired(false))
        .addStringOption(opt => opt.setName("new_artist").setDescription("New artist").setRequired(false)),

    new SlashCommandBuilder()
        .setName("delete")
        .setDescription("Delete a song (owner only)")
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

        // ── APPROVE / APPROVE + VERIFY ──
        if (interaction.customId.startsWith("approve_") || interaction.customId.startsWith("approve_verify_")) {
            if (!isModOrOwner(interaction)) {
                await interaction.reply({ content: "❌ You don't have permission to do this.", ephemeral: true });
                return;
            }

            await interaction.deferUpdate().catch(() => {});

            const isVerify = interaction.customId.startsWith("approve_verify_");
            const reviewId = isVerify
                ? interaction.customId.replace("approve_verify_", "")
                : interaction.customId.replace("approve_", "");
            const data = pendingSubmissions[reviewId];

            if (!data) {
                await interaction.followUp({ content: "❌ Submission not found (bot may have restarted).", ephemeral: true });
                return;
            }

            try {
                const fileUrl = await uploadToB2(data.attachmentBuffer, data.attachmentName);

                const { file, json, OWNER, REPO, PATH } = await getIndex();
                if (!json.nongs) json.nongs = {};
                if (!json.nongs.hosted) json.nongs.hosted = {};

                const songKey = `${data.levelid}_${Date.now()}`;
                json.nongs.hosted[songKey] = {
                    name: data.name,
                    artist: data.artist,
                    url: fileUrl,
                    songs: data.songs,
                    verifiedLevelIDs: isVerify ? [data.levelid] : []
                };

                await saveIndex(OWNER, REPO, PATH, json, file.sha, `Add song: ${data.name}`);

                updateSubmissionStatus(data.userId, reviewId, isVerify ? "approved_verified" : "approved");

                // Notificar al usuario
                const notifyChannel = await client.channels.fetch(CHANNEL_NOTIFY).catch(() => null);
                if (notifyChannel) {
                    await notifyChannel.send({
                        content: `<@${data.userId}> Your ${data.isMashup ? "mashup" : "song"} **${data.name}** has been approved ${isVerify ? "⭐ and verified!" : "✅!"}`,
                        allowedMentions: { users: [data.userId] }
                    });
                }

                // Cerrar el thread del foro con el tag correcto
                const closeTags = [isVerify ? TAG_APPROVED_VERIFY : TAG_APPROVED];
                if (data.isMashup)  closeTags.push(TAG_MASHUP);
                if (data.isOriginal) closeTags.push(TAG_ORIGINAL);
                await closeForumThread(data.threadId, closeTags);

                delete pendingSubmissions[reviewId];

            } catch (err) {
                console.error("[APPROVE ERROR]", err);
                await interaction.followUp({ content: `❌ Error approving: ${err.message}`, ephemeral: true });
            }
            return;
        }

        // ── REJECT ──
        if (interaction.customId.startsWith("reject_") && !interaction.customId.startsWith("reject_modal_")) {
            if (!isModOrOwner(interaction)) {
                await interaction.reply({ content: "❌ You don't have permission to do this.", ephemeral: true });
                return;
            }

            const reviewId = interaction.customId.replace("reject_", "");
            const data = pendingSubmissions[reviewId];
            if (!data) {
                await interaction.reply({ content: "❌ Submission not found (bot may have restarted).", ephemeral: true });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`reject_modal_${reviewId}`)
                .setTitle("Reject Submission");
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId("reject_reason")
                        .setLabel("Reason for rejection")
                        .setStyle(TextInputStyle.Paragraph)
                        .setPlaceholder("Why are you rejecting this song?")
                        .setRequired(true)
                )
            );
            await interaction.showModal(modal);
            return;
        }

        // ── EDIT SUBMISSION (botón del usuario en el foro) ──
        if (interaction.customId.startsWith("edit_sub_")) {
            const reviewId = interaction.customId.replace("edit_sub_", "");
            const data = pendingSubmissions[reviewId];

            if (!data) {
                await interaction.reply({ content: "❌ Submission not found (bot may have restarted).", ephemeral: true });
                return;
            }

            if (interaction.user.id !== data.userId) {
                await interaction.reply({ content: "❌ Only the person who submitted this can edit it.", ephemeral: true });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`edit_sub_modal_${reviewId}`)
                .setTitle("Edit your submission");
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId("edit_name")
                        .setLabel("Song name")
                        .setStyle(TextInputStyle.Short)
                        .setValue(data.name)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId("edit_artist")
                        .setLabel("Artist")
                        .setStyle(TextInputStyle.Short)
                        .setValue(data.artist)
                        .setRequired(true)
                )
            );
            await interaction.showModal(modal);
            return;
        }
    }

    // ==================== MODALS ====================
    if (interaction.isModalSubmit()) {

        // ── REJECT MODAL ──
        if (interaction.customId.startsWith("reject_modal_")) {
            const reviewId = interaction.customId.replace("reject_modal_", "");
            const data = pendingSubmissions[reviewId];

            if (!data) {
                await interaction.reply({ content: "❌ Submission not found (bot may have restarted).", ephemeral: true });
                return;
            }

            const reason = interaction.fields.getTextInputValue("reject_reason");
            await interaction.deferReply({ ephemeral: true });

            updateSubmissionStatus(data.userId, reviewId, "rejected", reason);

            const notifyChannel = await client.channels.fetch(CHANNEL_NOTIFY).catch(() => null);
            if (notifyChannel) {
                await notifyChannel.send({
                    content: `<@${data.userId}> Your ${data.isMashup ? "mashup" : "song"} **${data.name}** has been rejected ❌\n\n**Reason:** ${reason}`,
                    allowedMentions: { users: [data.userId] }
                });
            }

            // Postear la razón en el thread antes de cerrarlo
            try {
                const thread = await client.channels.fetch(data.threadId);
                await thread.send({ content: `❌ **Rejected**\n**Reason:** ${reason}` });
            } catch (e) {
                console.error("[REJECT] Could not post reason in thread:", e);
            }

            const closeTags = [TAG_REJECTED];
            if (data.isMashup)   closeTags.push(TAG_MASHUP);
            if (data.isOriginal) closeTags.push(TAG_ORIGINAL);
            await closeForumThread(data.threadId, closeTags);

            delete pendingSubmissions[reviewId];
            await interaction.editReply({ content: `❌ **${data.name}** rejected.\nReason: ${reason}` });
            return;
        }

        // ── EDIT SUBMISSION MODAL ──
        if (interaction.customId.startsWith("edit_sub_modal_")) {
            const reviewId = interaction.customId.replace("edit_sub_modal_", "");
            const data = pendingSubmissions[reviewId];

            if (!data) {
                await interaction.reply({ content: "❌ Submission not found (bot may have restarted).", ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            const newName   = interaction.fields.getTextInputValue("edit_name").trim();
            const newArtist = interaction.fields.getTextInputValue("edit_artist").trim();
            const oldName   = data.name;
            const oldArtist = data.artist;

            data.name   = newName;
            data.artist = newArtist;

            // Actualizar historial en memoria
            const histEntry = submissionHistory[data.userId]?.find(e => e.reviewId === reviewId);
            if (histEntry) { histEntry.name = newName; histEntry.artist = newArtist; }

            // Editar el primer mensaje del thread con la info actualizada
            try {
                const thread   = await client.channels.fetch(data.threadId);
                const messages = await thread.messages.fetch({ limit: 5 });
                const firstMsg = messages.last(); // el más antiguo
                if (firstMsg) {
                    const updatedContent = buildForumContent(data);
                    await firstMsg.edit({ content: updatedContent, components: buildForumRows(reviewId) });
                }
                await thread.send({ content: `✏️ **Submission edited by submitter**\nName: **${oldName}** → **${newName}**\nArtist: **${oldArtist}** → **${newArtist}**` });
            } catch (e) {
                console.error("[EDIT_SUB] Could not edit thread:", e);
            }

            await interaction.editReply({ content: `✏️ Updated!\nName: **${oldName}** → **${newName}**\nArtist: **${oldArtist}** → **${newArtist}**` });
            return;
        }
    }

    if (!interaction.isChatInputCommand()) return;

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // ==================== SUBMIT / SUBMIT-MASHUP ====================
    if (interaction.commandName === "submit" || interaction.commandName === "submit-mashup") {
        const attachment = interaction.options.getAttachment("file");
        const isMashup   = interaction.commandName === "submit-mashup";
        const isOriginal = interaction.options.getBoolean("original");

        const data = {
            name: isMashup
                ? `${interaction.options.getString("gd_song")} X ${interaction.options.getString("song_artist")} - ${interaction.options.getString("song_name")}`
                : interaction.options.getString("name"),
            artist: isMashup
                ? `${interaction.options.getString("gd_artist")} (mashup by ${interaction.options.getString("creator")})`
                : interaction.options.getString("artist"),
            attachmentUrl:  attachment.url,
            attachmentName: attachment.name,
            levelid:    interaction.options.getInteger("levelid"),
            isMashup,
            isOriginal,
            userId: interaction.user.id
        };

        await sendForReview(interaction, data, isMashup ? "New Mashup" : "New Song");
        return;
    }

    // ==================== SUBMIT-STATUS ====================
    if (interaction.commandName === "submit-status") {
        const history = submissionHistory[interaction.user.id];

        if (!history || history.length === 0) {
            await interaction.editReply({ content: "📭 You haven't submitted anything yet." });
            return;
        }

        const statusEmoji = { pending: "⏳", approved: "✅", approved_verified: "⭐", rejected: "❌" };
        const statusLabel = { pending: "Pending", approved: "Approved", approved_verified: "Approved + Verified", rejected: "Rejected" };

        const lines = history.map(e => {
            const emoji = statusEmoji[e.status] || "❓";
            const label = statusLabel[e.status] || e.status;
            const date  = new Date(e.submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
            const type  = e.type === "mashup" ? "🎛️ Mashup" : "🎵 Song";
            const orig  = e.isOriginal ? " · 🎼 Original" : "";
            let line = `${emoji} **${e.name}** — ${e.artist}\n  ${type}${orig} · Level \`${e.levelid}\` · ${label} · ${date}`;
            if (e.status === "rejected" && e.reason) line += `\n  > Reason: ${e.reason}`;
            return line;
        });

        const header = `📋 **Your submissions (${history.length}):**\n\n`;
        const chunks = [];
        let current  = header;
        for (const line of lines) {
            if ((current + line + "\n\n").length > 1900) { chunks.push(current); current = ""; }
            current += line + "\n\n";
        }
        if (current) chunks.push(current);

        await interaction.editReply({ content: chunks[0] });
        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i], ephemeral: true });
        }
        return;
    }

    // ==================== EDIT-APPROVED ====================
    if (interaction.commandName === "edit-approved") {
        if (!isModOrOwner(interaction)) {
            await interaction.editReply({ content: "❌ You don't have permission to use this command." });
            return;
        }

        const levelId   = interaction.options.getInteger("levelid");
        const songName  = interaction.options.getString("name");
        const newName   = interaction.options.getString("new_name");
        const newArtist = interaction.options.getString("new_artist");

        if (!newName && !newArtist) {
            await interaction.editReply({ content: "❌ Provide at least one field to update (new_name or new_artist)." });
            return;
        }

        try {
            const { file, json, OWNER, REPO, PATH } = await getIndex();

            if (!json.nongs?.hosted) {
                await interaction.editReply({ content: "❌ No songs in the database." });
                return;
            }

            const key = Object.keys(json.nongs.hosted).find(k => {
                const s = json.nongs.hosted[k];
                return k.startsWith(`${levelId}_`) && s.name.toLowerCase() === songName.toLowerCase();
            });

            if (!key) {
                const matches = Object.entries(json.nongs.hosted)
                    .filter(([k]) => k.startsWith(`${levelId}_`))
                    .map(([, s]) => `• **${s.name}** — ${s.artist}`);
                const hint = matches.length > 0 ? `\n\nSongs with that Level ID:\n${matches.join("\n")}` : "";
                await interaction.editReply({ content: `❌ Song **${songName}** not found for Level ID **${levelId}**.${hint}` });
                return;
            }

            const song    = json.nongs.hosted[key];
            const oldName = song.name;
            const changes = [];
            if (newName)   { changes.push(`Name: **${song.name}** → **${newName}**`);       song.name   = newName; }
            if (newArtist) { changes.push(`Artist: **${song.artist}** → **${newArtist}**`); song.artist = newArtist; }

            await saveIndex(OWNER, REPO, PATH, json, file.sha, `Edit song: ${oldName}`);
            await interaction.editReply({ content: `✏️ Song updated!\n${changes.join("\n")}` });

        } catch (err) {
            console.error("[EDIT-APPROVED ERROR]", err);
            await interaction.editReply({ content: `❌ Error: ${err.message}` });
        }
        return;
    }

    // ==================== DELETE ====================
    if (interaction.commandName === "delete") {
        if (interaction.user.id !== OWNER_ID) {
            await interaction.editReply({ content: "❌ You don't have permission to use this command." });
            return;
        }

        const levelId  = interaction.options.getInteger("levelid");
        const songName = interaction.options.getString("name");

        try {
            const { file, json, OWNER, REPO, PATH } = await getIndex();

            if (!json.nongs?.hosted) {
                await interaction.editReply({ content: "❌ No songs found in database." });
                return;
            }

            const key = Object.keys(json.nongs.hosted).find(k => {
                const s = json.nongs.hosted[k];
                return k.startsWith(`${levelId}_`) && s.name.toLowerCase() === songName.toLowerCase();
            });

            if (!key) {
                const matches = Object.entries(json.nongs.hosted)
                    .filter(([k]) => k.startsWith(`${levelId}_`))
                    .map(([, s]) => `• **${s.name}** — ${s.artist}`);
                if (matches.length > 0) {
                    await interaction.editReply({
                        content: `❌ Song **${songName}** not found for Level ID **${levelId}**.\n\nSongs with that Level ID:\n${matches.join("\n")}`
                    });
                    return;
                }
                await interaction.editReply({ content: `❌ No songs found for Level ID **${levelId}**.` });
                return;
            }

            const deleted = json.nongs.hosted[key];
            delete json.nongs.hosted[key];
            await saveIndex(OWNER, REPO, PATH, json, file.sha, `Delete song: ${deleted.name}`);
            await interaction.editReply({ content: `🗑️ **${deleted.name}** by ${deleted.artist} has been deleted.` });

        } catch (err) {
            console.error("[DELETE ERROR]", err);
            await interaction.editReply({ content: `❌ Error deleting: ${err.message}` });
        }
        return;
    }

    // ==================== FIX EXPIRED LINKS ====================
    if (interaction.commandName === "fix-expired-links") {
        if (interaction.user.id !== OWNER_ID) {
            await interaction.editReply({ content: "❌ You don't have permission." });
            return;
        }

        await interaction.editReply({ content: "🔍 Checking all links..." });
        let checked = 0, failed = 0;

        try {
            const { json } = await getIndex();
            if (!json.nongs?.hosted) { await interaction.editReply({ content: "No songs found." }); return; }

            const deadSongs = [];
            for (const [, song] of Object.entries(json.nongs.hosted)) {
                if (!song.url) continue;
                checked++;
                let isAlive = false;
                try { const res = await fetch(song.url, { method: "HEAD" }); isAlive = res.ok; } catch { isAlive = false; }
                if (!isAlive) { failed++; deadSongs.push(`• **${song.name}** — ${song.artist}`); }
            }

            const deadList = deadSongs.length > 0 ? `\n\nDead links:\n${deadSongs.join("\n")}` : "";
            await interaction.editReply({
                content: `✅ Done!\nChecked: **${checked}** · Dead: **${failed}**${deadList}` +
                    (failed > 0 ? `\n\n⚠️ These need to be re-submitted.` : "\n\n🎉 All links alive!")
            });

        } catch (err) {
            console.error("[FIX ERROR]", err);
            await interaction.editReply({ content: `❌ Error: ${err.message}` });
        }
        return;
    }
});

// ==================== BUILD FORUM POST CONTENT ====================
function buildForumContent(data) {
    const type     = data.isMashup ? "🎛️ Mashup" : "🎵 Song";
    const original = data.isOriginal ? "\n🎼 **Original:** Yes" : "\n🎼 **Original:** No";
    return [
        `${type} submission`,
        ``,
        `🎵 **Name:** ${data.name}`,
        `🎤 **Artist:** ${data.artist}`,
        `🔢 **Level ID:** ${data.levelid}`,
        `🎶 **GD Song:** ${data.songDisplay}`,
        original,
        `👤 **Submitted by:** <@${data.userId}>`
    ].join("\n");
}

// ==================== SEND FOR REVIEW (crea el post en el foro) ====================
async function sendForReview(interaction, data, title) {
    try {
        // Descargar archivo
        const fileRes = await fetch(data.attachmentUrl);
        if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
        data.attachmentBuffer = Buffer.from(await fileRes.arrayBuffer());
        delete data.attachmentUrl;

        // Obtener info del nivel desde GDBrowser
        const gdbRes = await fetch(`https://gdbrowser.com/api/level/${data.levelid}`);
        if (!gdbRes.ok) throw new Error("GDBrowser error");
        const level = await gdbRes.json();

        let resolved;
        if (level.officialSong && level.officialSong > 0) {
            resolved = resolveOfficialSong(level.officialSong);
        } else if (level.customSong && level.customSong > 0) {
            resolved = { isOfficial: false, name: String(level.customSong), indexId: Number(level.customSong) };
        } else {
            throw new Error("Could not determine song for this level");
        }

        data.songs       = [resolved.indexId];
        data.songDisplay = resolved.isOfficial ? `${resolved.name} (official)` : `ID ${resolved.indexId}`;

        const reviewId = Date.now().toString();
        pendingSubmissions[reviewId] = { ...data };

        // Tags iniciales del post
        const initialTags = [TAG_PENDING];
        if (data.isMashup)   initialTags.push(TAG_MASHUP);
        if (data.isOriginal) initialTags.push(TAG_ORIGINAL);

        // Crear el thread en el foro
        const forum = await client.channels.fetch(CHANNEL_FORUM);
        const thread = await forum.threads.create({
            name: `${data.name} — ${data.artist}`,
            appliedTags: initialTags,
            message: {
                content: buildForumContent(data),
                files:   [{ attachment: data.attachmentBuffer, name: data.attachmentName }],
                components: buildForumRows(reviewId)
            }
        });

        // Guardar el threadId en la submission
        pendingSubmissions[reviewId].threadId = thread.id;

        // Registrar en historial
        recordSubmission(data.userId, {
            reviewId,
            type:        data.isMashup ? "mashup" : "song",
            name:        data.name,
            artist:      data.artist,
            levelid:     data.levelid,
            isOriginal:  data.isOriginal,
            status:      "pending",
            submittedAt: new Date().toISOString()
        });

        await interaction.editReply({ content: `✅ Submitted! You can track it with \`/submit-status\`.\n🔗 ${thread.url}` });

    } catch (err) {
        console.error("[SUBMIT ERROR]", err);
        await interaction.editReply({ content: `❌ Error: ${err.message}` }).catch(() => {});
    }
}

client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log("✅ Bot connected successfully"))
    .catch(err => console.error("Login error:", err));
