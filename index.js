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

const CHANNEL_SUBMIT = "1493748721970577489";   // Solo comandos
const CHANNEL_REVIEW = "1494189412228141107";   // Revisión con botones
const CHANNEL_FILES = "1494134281218560111";    // Archivos permanentes
const CHANNEL_NOTIFY = "1494184620676218880";   // Notificaciones
const OWNER_ID = "1388922967223832606";

const CHANNELS_COMMANDS_ONLY = [CHANNEL_SUBMIT];

const pendingSubmissions = {};

// ==================== COMMANDS ====================
const commands = [ /* ... tus comandos submit, submit-mashup y delete se mantienen igual ... */ ];

// Register commands (mantengo igual)
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
            await message.author.send({
                content: `⚠️ **This channel is commands only**\n\nPlease use \`/submit\` or \`/submit-mashup\`.`
            });
        } catch {
            const temp = await message.channel.send({
                content: `${message.author} This channel only allows slash commands.`
            });
            setTimeout(() => temp.delete().catch(() => {}), 8000);
        }
    }
});

// ==================== INTERACTIONS ====================
client.on("interactionCreate", async interaction => {

    // ===== BOTONES =====
    if (interaction.isButton()) {
        await interaction.deferUpdate().catch(() => {});

        // APROBAR
        if (interaction.customId.startsWith("approve_") || interaction.customId.startsWith("approve_verify_")) {
            const isVerify = interaction.customId.startsWith("approve_verify_");
            const id = isVerify ? interaction.customId.replace("approve_verify_", "") : interaction.customId.replace("approve_", "");
            const data = pendingSubmissions[id];
            if (!data) return;

            // ... (mantengo la lógica de approve igual, solo cambio el mensaje final si querés)
            // Por ahora la dejo como estaba, pero podés mejorarla después.
        }

        // RECHAZAR → Abre Modal para motivo
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
                .setPlaceholder("Write the reason why this song is being rejected...")
                .setRequired(true)
                .setMaxLength(500);

            const row = new ActionRowBuilder().addComponents(reasonInput);
            modal.addComponents(row);

            await interaction.showModal(modal);
        }
        return;
    }

    // ===== MODAL SUBMIT (Motivo de rechazo) =====
    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith("reject_modal_")) {
            const id = interaction.customId.replace("reject_modal_", "");
            const data = pendingSubmissions[id];
            if (!data) return;

            const reason = interaction.fields.getTextInputValue("reject_reason");

            await interaction.deferUpdate();

            // Notificación con motivo
            const notifyChannel = await client.channels.fetch(CHANNEL_NOTIFY).catch(() => null);
            if (notifyChannel) {
                await notifyChannel.send({
                    content: `<@${data.userId}> Your song **${data.name}** has been rejected ❌\n\n` +
                             `**Reason:** ${reason}`,
                    allowedMentions: { users: [data.userId] }
                });
            }

            delete pendingSubmissions[id];

            await interaction.editReply({
                content: `❌ **${data.name}** rejected\nReason: ${reason}`,
                components: []
            });
        }
        return;
    }

    // Slash Commands (submit, submit-mashup, delete) - se mantienen igual
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // ... (tu lógica de submit y submit-mashup se mantiene igual)
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
});

// ==================== SEND FOR REVIEW (sin cambios) ====================
async function sendForReview(interaction, data, title) {
    try {
        const fileRes = await fetch(data.attachmentUrl);
        data.attachmentBuffer = Buffer.from(await fileRes.arrayBuffer());
        delete data.attachmentUrl;

        const gdbRes = await fetch(`https://gdbrowser.com/api/level/${data.levelid}`);
        const level = await gdbRes.json();
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