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
    MessageFlags
} = require("discord.js");

const { Octokit } = require("@octokit/rest");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,    // ✅ ADDED: to receive messages
        GatewayIntentBits.MessageContent    // ✅ ADDED: to read message content
    ]
});
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ==================== CONFIG ====================
const GUILD_ID = "1493493321149190174";
const CHANNEL_REVIEW = "1494189412228141107";
const CHANNEL_FILES = "1494134281218560111";
const CHANNEL_NOTIFY = "1494184620676218880";
const OWNER_ID = "1388922967223832606";

// ✅ ADDED: channel IDs where only slash commands are allowed
// Add more IDs separated by commas: ["ID1", "ID2"]
const CHANNELS_COMMANDS_ONLY = [CHANNEL_REVIEW];

const pendingSubmissions = {};

// ==================== COMANDOS ====================
const commands = [
    new SlashCommandBuilder()
        .setName("submit")
        .setDescription("Submit a song")
        .addAttachmentOption(opt => opt.setName("archivo").setDescription("Audio file (.mp3)").setRequired(true))
        .addStringOption(opt => opt.setName("name").setDescription("Song name").setRequired(true))
        .addStringOption(opt => opt.setName("artist").setDescription("Artist").setRequired(true))
        .addIntegerOption(opt => opt.setName("levelid").setDescription("Level ID").setRequired(true)),

    new SlashCommandBuilder()
        .setName("submit-mashup")
        .setDescription("Submit a mashup")
        .addAttachmentOption(opt => opt.setName("archivo").setDescription("Audio file (.mp3)").setRequired(true))
        .addStringOption(opt => opt.setName("gd_song").setDescription("GD song").setRequired(true))
        .addStringOption(opt => opt.setName("gd_artist").setDescription("GD artist").setRequired(true))
        .addStringOption(opt => opt.setName("song_name").setDescription("Mashup name").setRequired(true))
        .addStringOption(opt => opt.setName("song_artist").setDescription("Mashup artist").setRequired(true))
        .addStringOption(opt => opt.setName("creator").setDescription("Mashup creator").setRequired(true))
        .addIntegerOption(opt => opt.setName("levelid").setDescription("Level ID").setRequired(true)),

    new SlashCommandBuilder()
        .setName("delete")
        .setDescription("Delete a song (owner only)")
        .addIntegerOption(opt =>
            opt.setName("levelid")
                .setDescription("Level ID")
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("name")
                .setDescription("Song name")
                .setRequired(true)
)
];

// Registrar comandos
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ Commands registered");
    } catch (e) {
        console.error("Error registering commands:", e);
    }
})();

// ==================== DELETE MESSAGES (slash commands only) ====================
// ✅ ADDED: deletes any regular message in the listed channels
client.on("messageCreate", async (message) => {
    if (message.author.bot) return; // ignore bots

    if (CHANNELS_COMMANDS_ONLY.includes(message.channel.id)) {
        await message.delete().catch(() => {}); // .catch in case it was already deleted
        const warning = await message.channel.send({
            content: `${message.author} This channel is for slash commands only (/submit, /submit-mashup).`,
        });
        setTimeout(() => warning.delete().catch(() => {}), 5000); // auto-deletes after 5s
    }
});

// ==================== INTERACTIONS ====================
client.on("interactionCreate", async interaction => {

    // ===== BOTONES =====
    if (interaction.isButton()) {

        // APROBAR / APROBAR + VERIFY
        if (
            interaction.customId.startsWith("approve_") ||
            interaction.customId.startsWith("approve_verify_")
        ) {

            await interaction.deferUpdate();

            const isVerify = interaction.customId.startsWith("approve_verify_");

            let id;

            if (interaction.customId.startsWith("approve_verify_")) {
                id = interaction.customId.replace("approve_verify_", "");
            } else {
                id = interaction.customId.replace("approve_", "");
            }
            const data = pendingSubmissions[id];

            if (!data) {
                return interaction.followUp({
                    content: "This submission has expired ❌",
                    ephemeral: true
                });
            }

            try {
                console.log(`[APPROVE] ${data.name} | verify: ${isVerify}`);

                // ===== Subir archivo =====
                const filesChannel = await client.channels.fetch(CHANNEL_FILES);

                const fileMsg = await filesChannel.send({
                    content: `${data.name} — ${data.artist}`,
                    files: [{
                        attachment: data.attachmentBuffer,
                        name: data.attachmentName
                    }]
                });

                const permanentUrl = fileMsg.attachments.first()?.url;

                if (!permanentUrl) {
                    throw new Error("Could not retrieve the file URL");
                }

                // ===== GitHub =====
                const OWNER = process.env.GITHUB_OWNER;
                const REPO = process.env.GITHUB_REPO;
                const PATH = process.env.GITHUB_PATH;

                const { data: file } = await octokit.repos.getContent({
                    owner: OWNER,
                    repo: REPO,
                    path: PATH
                });

                const content = Buffer.from(file.content, "base64").toString();
                const json = JSON.parse(content);

                if (!json.nongs) json.nongs = {};
                if (!json.nongs.hosted) json.nongs.hosted = {};

                const newId = Date.now().toString();

                console.log({
                    isVerify,
                    levelid: data.levelid
                });

                const entry = {
                    name: data.name,
                    artist: data.artist,
                    url: permanentUrl,
                    startOffset: 0,
                    songs: data.songs || []
                };

                if (isVerify && data.levelid) {
                    entry.verifiedLevelIDs = [Number(data.levelid)];
                } else {
                    entry.verifiedLevelIDs = [];
                }

                json.nongs.hosted[newId] = entry;

                const updated = Buffer.from(
                    JSON.stringify(json, null, 2)
                ).toString("base64");

                await octokit.repos.createOrUpdateFileContents({
                    owner: OWNER,
                    repo: REPO,
                    path: PATH,
                    message: `Add song: ${data.name}`,
                    content: updated,
                    sha: file.sha
                });

                delete pendingSubmissions[id];

                await interaction.editReply({
                    content: isVerify
                        ? `⭐ **${data.name}** approved and verified for the level`
                        : `✅ **${data.name}** approved`,
                    components: []
                });

                const notifyChannel = await client.channels.fetch(CHANNEL_NOTIFY);

                await notifyChannel.send({
                    content: `<@${data.userId}> your song **${data.name}** was ${
                        isVerify ? "approved and verified ⭐" : "approved ✅"
                    }`,
                    allowedMentions: { users: [data.userId] }
                });

            } catch (error) {
                console.error("[APPROVE ERROR]", error);

                await interaction.followUp({
                    content: `❌ Error: ${error.message}`,
                    ephemeral: true
                });

                const notifyChannel = await client.channels.fetch(CHANNEL_NOTIFY);

                await notifyChannel.send({
                    content: `<@${data.userId}> your song **${data?.name ?? "Song"}** was rejected ❌`,
                    allowedMentions: { users: [data.userId] }
                });
            }
        }

        // REJECT
        if (interaction.customId.startsWith("reject_")) {

            await interaction.deferUpdate();

            const id = interaction.customId.replace("reject_", "");
            const data = pendingSubmissions[id];

            delete pendingSubmissions[id];

            await interaction.editReply({
                content: `❌ **${data?.name ?? "Song"}** rejected`,
                components: []
            });

            // ✅ BUG FIX: notify the user in the notifications channel
            const notifyChannel = await client.channels.fetch(CHANNEL_NOTIFY);
            await notifyChannel.send({
                content: `<@${data.userId}> your song **${data?.name ?? "Song"}** was rejected ❌`,
                allowedMentions: { users: [data.userId] }
            });
        }
        if (interaction.customId.startsWith("delete_")) {

            await interaction.deferUpdate();

            const id = interaction.customId.replace("delete_", "");

            try {
                const OWNER = process.env.GITHUB_OWNER;
                const REPO = process.env.GITHUB_REPO;
                const PATH = process.env.GITHUB_PATH;

                const { data: file } = await octokit.repos.getContent({
                    owner: OWNER,
                    repo: REPO,
                    path: PATH
                });

                const content = Buffer.from(file.content, "base64").toString();
                const json = JSON.parse(content);

                const song = json.nongs.hosted[id];

                if (!song) {
                    return interaction.followUp({
                        content: "❌ Song no longer exists",
                        ephemeral: true
                    });
                }

                delete json.nongs.hosted[id];

                const updated = Buffer.from(
                    JSON.stringify(json, null, 2)
                ).toString("base64");

                await octokit.repos.createOrUpdateFileContents({
                    owner: OWNER,
                    repo: REPO,
                    path: PATH,
                    message: `Delete song: ${song.name}`,
                    content: updated,
                    sha: file.sha
                });

                await interaction.editReply({
                    content: `🗑️ **${song.name}** deleted successfully`,
                    components: []
                });

            } catch (err) {
                console.error(err);

                await interaction.followUp({
                    content: `❌ Error: ${err.message}`,
                    ephemeral: true
                });
            }
        }

        return;
    }

    if (!interaction.isChatInputCommand()) return;

    console.log(`[CMD] ${interaction.commandName} used by ${interaction.user.tag}`);

    // deferReply rápido
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }



    if (interaction.commandName === "submit" || interaction.commandName === "submit-mashup") {
        const attachment = interaction.options.getAttachment("archivo");

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

        await sendForReview(interaction, data, interaction.commandName === "submit" ? "New song" : "New mashup");
    }

    if (interaction.commandName === "delete") {

        if (interaction.user.id !== OWNER_ID) {
            return interaction.editReply({ content: "You don't have permission ❌" });
        }

        const levelid = interaction.options.getInteger("levelid");
        const query = interaction.options.getString("name").toLowerCase();

        try {
            // ===== Obtener songID desde GD =====
            const gdbRes = await fetch(`https://gdbrowser.com/api/level/${levelid}`);
            if (!gdbRes.ok) throw new Error("GDBrowser request failed");

            const level = await gdbRes.json();
            const songID = Number(level.songID);

            if (!songID) throw new Error("Could not find songID");

            // ===== GitHub config =====
            const OWNER = process.env.GITHUB_OWNER;
            const REPO = process.env.GITHUB_REPO;
            const PATH = process.env.GITHUB_PATH;

            const { data: file } = await octokit.repos.getContent({
                owner: OWNER,
                repo: REPO,
                path: PATH
            });

            const content = Buffer.from(file.content, "base64").toString();
            const json = JSON.parse(content);

            const entries = Object.entries(json.nongs.hosted);

            // ===== Filtrar =====
            const matches = entries.filter(([id, song]) => {
                return (
                    song.name.toLowerCase().includes(query) &&
                    (song.songs || []).includes(songID)
                );
            });

            if (matches.length === 0) {
                return interaction.editReply({
                    content: "❌ No matches found"
                });
            }

            // ===== SOLO UNO → borrar directo =====
            if (matches.length === 1) {
                const [id, song] = matches[0];

                delete json.nongs.hosted[id];

                const updated = Buffer.from(
                    JSON.stringify(json, null, 2)
                ).toString("base64");

                await octokit.repos.createOrUpdateFileContents({
                    owner: OWNER,
                    repo: REPO,
                    path: PATH,
                    message: `Delete song: ${song.name}`,
                    content: updated,
                    sha: file.sha
                });

                return interaction.editReply({
                    content: `🗑️ **${song.name}** deleted`
                });
            }

            // ===== MULTIPLES → botones =====
            const row = new ActionRowBuilder();

            matches.slice(0, 5).forEach(([id, song]) => {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`delete_${id}`)
                        .setLabel(song.name.slice(0, 80))
                        .setStyle(ButtonStyle.Danger)
                );
            });

            await interaction.editReply({
                content: `⚠️ Multiple matches found, choose which one to delete:`,
                components: [row]
            });

        } catch (err) {
            console.error(err);
            await interaction.editReply({
                content: `❌ Error: ${err.message}`
            });
        }
    }
});

// ==================== SEND FOR REVIEW ====================
async function sendForReview(interaction, data, title) {
    try {
        console.log(`[REVIEW] Processing: ${data.name}`);

        // Descargar archivo
        const fileRes = await fetch(data.attachmentUrl);
        if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);

        data.attachmentBuffer = Buffer.from(await fileRes.arrayBuffer());
        delete data.attachmentUrl;

        console.log(`[REVIEW] File downloaded (${data.attachmentBuffer.length} bytes)`);

        // GDBrowser
        const gdbRes = await fetch(`https://gdbrowser.com/api/level/${data.levelid}`);
        if (!gdbRes.ok) throw new Error("GDBrowser error");

        const level = await gdbRes.json();
        if (!level.songID) throw new Error("Could not find songID");

        data.songs = [Number(level.songID)];

        // Guardar temporalmente
        const reviewId = Date.now().toString();
        pendingSubmissions[reviewId] = {
            ...data,
            userId: interaction.user.id
        };

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`approve_${reviewId}`)
                .setLabel("Approve ✅")
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId(`approve_verify_${reviewId}`)
                .setLabel("Approve + Verify ⭐")
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId(`reject_${reviewId}`)
                .setLabel("Reject ❌")
                .setStyle(ButtonStyle.Danger)
        );
        
        const channel = await client.channels.fetch(CHANNEL_REVIEW);
        await channel.send({
            content: `**${title}**: ${data.name} — ${data.artist}\n🎵 Songs: ${data.songs.join(", ")}`,
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