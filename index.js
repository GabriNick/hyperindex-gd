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

// ==================== CONFIG ====================
const GUILD_ID = "1493493321149190174";

const CHANNEL_SUBMIT = "1493748721970577489";   // Canal donde solo se permiten /submit
const CHANNEL_REVIEW = "1494189412228141107";   // Canal de revisión con botones
const CHANNEL_FILES = "1494134281218560111";    // Canal privado para archivos
const CHANNEL_NOTIFY = "1494184620676218880";   // Canal de notificaciones
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
        .setDescription("Delete a song (owner only)")
        .addIntegerOption(opt => opt.setName("levelid").setDescription("Level ID").setRequired(true))
        .addStringOption(opt => opt.setName("name").setDescription("Song name").setRequired(true))
];

// ==================== REGISTER COMMANDS ====================
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log("Registering commands...");
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        console.log("✅ Commands registered successfully");
    } catch (error) {
        console.error("❌ Error registering commands:", error);
    }
})();

// ==================== BLOCK NON-COMMAND MESSAGES ====================
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    if (CHANNELS_COMMANDS_ONLY.includes(message.channel.id)) {
        await message.delete().catch(() => {});

        try {
            await message.author.send({
                content: `⚠️ **Commands Only Channel**\n\n` +
                         `This channel only allows slash commands.\n` +
                         `Please use \`/submit\` or \`/submit-mashup\`.`
            });
        } catch (err) {
            const temp = await message.channel.send({
                content: `${message.author} This channel only allows slash commands (/submit, /submit-mashup).`
            });
            setTimeout(() => temp.delete().catch(() => {}), 8000);
        }
    }
});

// ==================== INTERACTIONS ====================
client.on("interactionCreate", async interaction => {

    // ==================== BUTTONS ====================
    if (interaction.isButton()) {

        // REJECT → Abre el modal (SIN deferUpdate antes)
        if (interaction.customId.startsWith("reject_")) {
            const id = interaction.customId.replace("reject_", "");
            const data = pendingSubmissions[id];
            if (!data) return;

            const modal = new ModalBuilder()
                .setCustomId(`reject_modal_${id}`)
                .setTitle("Reject Submission");

            const reasonInput = new TextInputBuilder()
                .setCustomId("reject_reason")
                .setLabel("Reason for rejection")
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder("Why are you rejecting this song?")
                .setRequired(true)
                .setMaxLength(500);

            const row = new ActionRowBuilder().addComponents(reasonInput);
            modal.addComponents(row);

            await interaction.showModal(modal);
            return;
        }

        // APPROVE (normal y verify)
        if (interaction.customId.startsWith("approve_") || interaction.customId.startsWith("approve_verify_")) {
            await interaction.deferUpdate().catch(() => {});

            const isVerify = interaction.customId.startsWith("approve_verify_");
            const id = isVerify 
                ? interaction.customId.replace("approve_verify_", "") 
                : interaction.customId.replace("approve_", "");

            const data = pendingSubmissions[id];
            if (!data) return;

            try {
                const filesChannel = await client.channels.fetch(CHANNEL_FILES);
                const fileMsg = await filesChannel.send({
                    content: `${data.name} — ${data.artist}`,
                    files: [{ attachment: data.attachmentBuffer, name: data.attachmentName }]
                });

                const permanentUrl = fileMsg.attachments.first()?.url;
                if (!permanentUrl) throw new Error("Could not get permanent URL");

                const OWNER = process.env.GITHUB_OWNER || "gabrinick";
                const REPO = process.env.GITHUB_REPO || "hyperindex-gd";
                const PATH = process.env.GITHUB_PATH || "index.json";

                const { data: file } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: PATH });
                const json = JSON.parse(Buffer.from(file.content, "base64").toString());

                if (!json.nongs) json.nongs = { hosted: {} };

                const newId = Date.now().toString();

                json.nongs.hosted[newId] = {
                    name: data.name,
                    artist: data.artist,
                    url: permanentUrl,
                    startOffset: 0,
                    songs: data.songs || [],
                    verifiedLevelIDs: isVerify && data.levelid ? [Number(data.levelid)] : []
                };

                const updated = Buffer.from(JSON.stringify(json, null, 2)).toString("base64");

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
                        ? `⭐ **${data.name}** approved and verified` 
                        : `✅ **${data.name}** approved`,
                    components: []
                });

                const notifyChannel = await client.channels.fetch(CHANNEL_NOTIFY);
                await notifyChannel.send({
                    content: `<@${data.userId}> Your song **${data.name}** has been ${isVerify ? "approved and verified ⭐" : "approved ✅"}`,
                    allowedMentions: { users: [data.userId] }
                });

            } catch (error) {
                console.error("[APPROVE ERROR]", error);
            }
        }

        return;
    }

    // ==================== MODAL SUBMIT (Rejection Reason) ====================
    if (interaction.isModalSubmit() && interaction.customId.startsWith("reject_modal_")) {
        const id = interaction.customId.replace("reject_modal_", "");
        const data = pendingSubmissions[id];
        if (!data) return;

        const reason = interaction.fields.getTextInputValue("reject_reason");

        await interaction.deferUpdate().catch(() => {});

        const notifyChannel = await client.channels.fetch(CHANNEL_NOTIFY).catch(() => null);
        if (notifyChannel) {
            await notifyChannel.send({
                content: `<@${data.userId}> Your song **${data.name}** has been rejected ❌\n\n**Reason:** ${reason}`,
                allowedMentions: { users: [data.userId] }
            });
        }

        delete pendingSubmissions[id];

        await interaction.editReply({
            content: `❌ **${data.name}** rejected\n**Reason:** ${reason}`,
            components: []
        });
        return;
    }

    // Slash Commands
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

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
    }

    if (interaction.commandName === "delete") {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.editReply({ content: "You don't have permission ❌" });
        }
        await interaction.editReply({ content: "Delete command is under maintenance." });
    }
});

// ==================== SEND FOR REVIEW ====================
async function sendForReview(interaction, data, title) {
    try {
        console.log(`[REVIEW] Processing: ${data.name}`);

        const fileRes = await fetch(data.attachmentUrl);
        if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);

        data.attachmentBuffer = Buffer.from(await fileRes.arrayBuffer());
        delete data.attachmentUrl;

        const gdbRes = await fetch(`https://gdbrowser.com/api/level/${data.levelid}`);
        if (!gdbRes.ok) throw new Error("GDBrowser error");

        const level = await gdbRes.json();
        if (!level.songID) throw new Error("No songID found");

        data.songs = [Number(level.songID)];

        const reviewId = Date.now().toString();
        pendingSubmissions[reviewId] = { ...data, userId: interaction.user.id };

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_${reviewId}`).setLabel("Approve ✅").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`approve_verify_${reviewId}`).setLabel("Approve + Verify ⭐").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`reject_${reviewId}`).setLabel("Reject ❌").setStyle(ButtonStyle.Danger)
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