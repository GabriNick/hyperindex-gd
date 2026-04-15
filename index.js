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

// ===== CLIENTE =====
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// ===== GITHUB =====
const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
});

// ===== CONFIG =====
const GUILD_ID = "1493493321149190174";
const CHANNEL_REVIEW = "1493748721970577489";
const OWNER_ID = "1388922967223832606";
const OWNER = "gabrinick";
const REPO = "hyperindex-gd";
const PATH = "index.json";

// ===== STORAGE TEMPORAL =====
const pendingSubmissions = {};

// ===== COMANDOS =====
const commands = [

    // SUBMIT NORMAL
    new SlashCommandBuilder()
        .setName("submit")
        .setDescription("Enviar canción")
        .addStringOption(opt =>
            opt.setName("name").setDescription("Nombre").setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("artist").setDescription("Artista").setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("url").setDescription("Link directo").setRequired(true)
        )
        .addIntegerOption(opt =>
            opt.setName("levelid").setDescription("Level ID").setRequired(true)
        ),

    // SUBMIT MASHUP
    new SlashCommandBuilder()
        .setName("submit-mashup")
        .setDescription("Enviar mashup")
        .addStringOption(opt =>
            opt.setName("gd_song").setDescription("Canción GD").setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("gd_artist").setDescription("Artista GD").setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("song_name").setDescription("Nombre mashup").setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("song_artist").setDescription("Artista mashup").setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("creator").setDescription("Creador del mashup").setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("url").setDescription("Link directo").setRequired(true)
        )
        .addIntegerOption(opt =>
            opt.setName("levelid").setDescription("Level ID").setRequired(true)
        ),

    // DELETE
    new SlashCommandBuilder()
        .setName("delete")
        .setDescription("Eliminar canción (owner only)")
        .addStringOption(opt =>
            opt.setName("query")
                .setDescription("Nombre o parte del nombre")
                .setRequired(true)
        )
];

// ===== REGISTRAR COMANDOS =====
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log("Registrando comandos...");
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        console.log("Comandos registrados");
    } catch (error) {
        console.error(error);
    }
})();

// ===== EVENTOS =====
client.on("interactionCreate", async interaction => {

    // ===== COMANDOS =====
    if (interaction.isChatInputCommand()) {

        // SUBMIT NORMAL
        if (interaction.commandName === "submit") {
            const data = {
                name: interaction.options.getString("name"),
                artist: interaction.options.getString("artist"),
                url: interaction.options.getString("url"),
                levelid: interaction.options.getInteger("levelid")
            };

            await sendForReview(interaction, data, "Nueva canción");
        }

        // SUBMIT MASHUP
        if (interaction.commandName === "submit-mashup") {
            const gdSong = interaction.options.getString("gd_song");
            const gdArtist = interaction.options.getString("gd_artist");
            const songName = interaction.options.getString("song_name");
            const songArtist = interaction.options.getString("song_artist");
            const creator = interaction.options.getString("creator");

            const data = {
                name: `${gdSong} X ${songArtist} - ${songName}`,
                artist: `${gdArtist} (mashup by ${creator})`,
                url: interaction.options.getString("url"),
                levelid: interaction.options.getInteger("levelid")
            };

            await sendForReview(interaction, data, "Nuevo mashup");
        }

        // DELETE
        if (interaction.commandName === "delete") {

            if (interaction.user.id !== OWNER_ID) {
                return interaction.reply({
                    content: "No tenés permiso ❌",
                    flags: MessageFlags.Ephemeral
                });
            }

            const query = interaction.options.getString("query").toLowerCase().trim();

            try {
                const { data: file } = await octokit.repos.getContent({
                    owner: OWNER,
                    repo: REPO,
                    path: PATH
                });

                const content = Buffer.from(file.content, "base64").toString();
                const json = JSON.parse(content);

                const entries = Object.entries(json.nongs.hosted);

                const matches = entries.filter(([id, song]) =>
                    song.name.toLowerCase().includes(query)
                );

                if (matches.length === 0) {
                    return interaction.reply({
                        content: `No se encontró ninguna canción con: "${query}" ❌`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (matches.length > 1) {
                    const lista = matches.map(([id, song]) => `• ${song.name}`).join("\n");
                    return interaction.reply({
                        content: `Hay múltiples coincidencias, sé más específico ❌\n${lista}`,
                        flags: MessageFlags.Ephemeral
                    });
                }

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

                await interaction.reply({
                    content: `**${song.name}** eliminada ✅`,
                    flags: MessageFlags.Ephemeral
                });

            } catch (err) {
                console.error(err);
                await interaction.reply({
                    content: "Error al eliminar ❌",
                    flags: MessageFlags.Ephemeral
                });
            }
        }
    }

    // ===== BOTONES =====
    if (interaction.isButton()) {

        // APROBAR
        if (interaction.customId.startsWith("approve_")) {

            const id = interaction.customId.replace("approve_", "");
            const data = pendingSubmissions[id];

            if (!data) {
                return interaction.reply({
                    content: "Esta submission expiró ❌",
                    ephemeral: true
                });
            }

            try {
                const { data: file } = await octokit.repos.getContent({
                    owner: OWNER,
                    repo: REPO,
                    path: PATH
                });

                const content = Buffer.from(file.content, "base64").toString();
                const json = JSON.parse(content);

                const newId = Date.now().toString();

                json.nongs.hosted[newId] = {
                    name: data.name,
                    artist: data.artist,
                    url: data.url,
                    startOffset: 0,
                    songs: data.songs
                };

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

                await interaction.update({
                    content: `✅ **${data.name}** aprobada y agregada`,
                    components: []
                });

            } catch (error) {
                console.error(error);
                await interaction.reply({
                    content: "Error al subir ❌",
                    ephemeral: true
                });
            }
        }

        // RECHAZAR
        if (interaction.customId.startsWith("reject_")) {

            const id = interaction.customId.replace("reject_", "");
            const data = pendingSubmissions[id];
            delete pendingSubmissions[id];

            await interaction.update({
                content: `❌ **${data?.name ?? "Canción"}** rechazada`,
                components: []
            });
        }
    }
});

// ===== FUNCIÓN =====
async function sendForReview(interaction, data, title) {

    await interaction.deferReply({ ephemeral: true });

    try {
        const res = await fetch(`https://gdbrowser.com/api/level/${data.levelid}`);

        if (!res.ok) {
            return interaction.editReply({ content: "No se encontró el nivel en GDBrowser ❌" });
        }

        const level = await res.json();
        const songID = level.songID;

        if (!songID) {
            return interaction.editReply({ content: "No se pudo obtener el songID del nivel ❌" });
        }

        data.songs = [Number(songID)];
        delete data.levelid;

    } catch (err) {
        console.error(err);
        return interaction.editReply({ content: "Error al consultar GDBrowser ❌" });
    }

    const id = Date.now().toString();
    pendingSubmissions[id] = data;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("approve_" + id)
            .setLabel("Aprobar ✅")
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId("reject_" + id)
            .setLabel("Rechazar ❌")
            .setStyle(ButtonStyle.Danger)
    );

    const channel = await client.channels.fetch(CHANNEL_REVIEW);

    await channel.send({
        content: `**${title}**\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
        components: [row]
    });

    await interaction.editReply({ content: "Enviado para revisión ✅" });
}

// ===== LOGIN =====
client.login(process.env.DISCORD_TOKEN);