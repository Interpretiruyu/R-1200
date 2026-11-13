
require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    Events,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require("discord.js");

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const {
    DISCORD_TOKEN,
    CLIENT_ID,
    GUILD_ID,
    CHANNEL_ID,
    API_SECRET
} = process.env;

const API_URL = process.env.API_URL.replace(/\/+$/, "");

const ALLOWED_ROLE_IDS = new Set(
    (process.env.ALLOWED_ROLE_IDS || "")
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
);

const publishedMessages = new Map();
const expiredCodes = new Set();
const activeInvasions = new Map();

let historyLoaded = false;
let checking = false;

const commands = [
    new SlashCommandBuilder()
        .setName("invasions")
        .setDescription("Show active servers"),

    new SlashCommandBuilder()
        .setName("invasion")
        .setDescription("Get info")
        .addStringOption(option =>
            option
                .setName("code")
                .setDescription("Invasion Code")
                .setRequired(true)
        )
].map(command => command.toJSON());

async function getInvasions() {
    const response = await fetch(`${API_URL}/list`, {
        headers: {
            Authorization: `Bearer ${API_SECRET}`
        }
    });

    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.success || !Array.isArray(data.Invasions)) {
        throw new Error("Invalid API response");
    }

    return data.Invasions;
}

function createEmbed(invasion, expired = false) {
    return new EmbedBuilder()
        .setTitle("⚠️ New active server")
        .setDescription("Server Info:")
        .addFields(
            {
                name: "Invasion Code",
                value: `\`${invasion.Code}\``,
                inline: false
            },
            {
                name: "Place ID",
                value: String(invasion.PlaceId),
                inline: true
            },
            {
                name: "Status",
                value: expired ? "Expired" : "Active",
                inline: true
            },
            {
                name: "Expires",
                value: `<t:${Math.floor(invasion.ExpiresAt / 1000)}:R>`,
                inline: false
            }
        )
        .setColor(expired ? 0x777777 : 0xD32F2F)
        .setTimestamp();
}

function createButton(code, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(disabled ? "expired_code" : `show_code:${code}`)
            .setLabel(disabled ? "Code is expired" : "Show code")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
    );
}

async function recoverMessages(channel) {
    const messages = await channel.messages.fetch({
        limit: 100
    });

    for (const message of messages.values()) {
        const embed = message.embeds[0];

        if (!embed || embed.title !== "⚠️ New active server") {
            continue;
        }

        const codeField = embed.fields.find(
            field => field.name === "Invasion Code"
        );

        if (!codeField) continue;

        const code = codeField.value.replace(/`/g, "");

        publishedMessages.set(code, message.id);

        const statusField = embed.fields.find(
            field => field.name === "Status"
        );

        if (statusField && statusField.value.includes("Expired")) {
            expiredCodes.add(code);
        }
    }

    historyLoaded = true;
}

async function markExpired(channel, code, messageId) {
    if (expiredCodes.has(code)) return;

    try {
        const message = await channel.messages.fetch(messageId);

        const embed = EmbedBuilder.from(message.embeds[0]);

        const fields = embed.data.fields || [];

        const statusIndex = fields.findIndex(
            field => field.name === "Status"
        );

        if (statusIndex !== -1) {
            fields[statusIndex] = {
                ...fields[statusIndex],
                value: "Expired."
            };
        }

        embed.setFields(fields);
        embed.setColor(0x777777);

        await message.edit({
            embeds: [embed],
            components: [createButton(code, true)]
        });

        expiredCodes.add(code);
    } catch (error) {
        console.error("Failed to update expired message:", error.message);
    }
}

async function checkInvasions() {
    if (checking) return;

    checking = true;

    try {
        const invasions = await getInvasions();

        const channel = await client.channels.fetch(CHANNEL_ID);

        if (!channel || !channel.isTextBased() || !channel.messages) {
            throw new Error("Invalid Discord channel");
        }

        if (!historyLoaded) {
            await recoverMessages(channel);
        }

        activeInvasions.clear();

        const activeCodes = new Set();

        for (const invasion of invasions) {
            activeCodes.add(invasion.Code);
            activeInvasions.set(invasion.Code, invasion);

            if (expiredCodes.has(invasion.Code)) {
                continue;
            }

            let messageId = publishedMessages.get(invasion.Code);
            let message = null;

            if (messageId) {
                try {
                    message = await channel.messages.fetch(messageId);
                } catch {
                    message = null;
                }
            }

            if (!message) {
                message = await channel.send({
                    embeds: [createEmbed(invasion)],
                    components: [createButton(invasion.Code)]
                });

                publishedMessages.set(invasion.Code, message.id);
            }
        }

        for (const [code, messageId] of publishedMessages) {
            if (!activeCodes.has(code)) {
                await markExpired(channel, code, messageId);
                activeInvasions.delete(code);
            }
        }

    } catch (error) {
        console.error("Invasion check failed:", error.message);
    } finally {
        checking = false;
    }
}

async function hasAllowedRole(interaction) {
    if (!interaction.inGuild()) return false;

    const member = await interaction.guild.members.fetch(
        interaction.user.id
    );

    return member.roles.cache.some(role =>
        ALLOWED_ROLE_IDS.has(role.id)
    );
}

client.on(Events.InteractionCreate, async interaction => {
    try {
        if (interaction.isButton()) {
            if (!interaction.customId.startsWith("show_code:")) {
                return;
            }

            const code = interaction.customId.slice("show_code:".length);
            const invasion = activeInvasions.get(code);

            if (!invasion) {
                return interaction.reply({
                    content: "This server isn't exist.",
                    flags: MessageFlags.Ephemeral
                });
            }

            return interaction.reply({
                content: `Invasion Code: \`${code}\``,
                flags: MessageFlags.Ephemeral
            });
        }

        if (!interaction.isChatInputCommand()) return;

        if (!await hasAllowedRole(interaction)) {
            return interaction.reply({
                content: "Missing access.",
                flags: MessageFlags.Ephemeral
            });
        }

        const invasions = await getInvasions();

        if (interaction.commandName === "invasions") {
            if (invasions.length === 0) {
                return interaction.reply({
                    content: "No active servers for now.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const description = invasions
                .slice(0, 15)
                .map(invasion =>
                    `**${invasion.Code}**\n` +
                    `Place ID: \`${invasion.PlaceId}\`\n` +
                    `Истекает: <t:${Math.floor(invasion.ExpiresAt / 1000)}:R>`
                )
                .join("\n\n");

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("Active servers")
                        .setDescription(description)
                        .setColor(0xD32F2F)
                ],
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === "invasion") {
            const code = interaction.options
                .getString("code")
                .trim()
                .toUpperCase();

            const invasion = invasions.find(
                item => item.Code === code
            );

            if (!invasion) {
                return interaction.reply({
                    content: "Server isn't active now or you're late.",
                    flags: MessageFlags.Ephemeral
                });
            }

            return interaction.reply({
                embeds: [createEmbed(invasion)],
                flags: MessageFlags.Ephemeral
            });
        }

    } catch (error) {
        console.error("Interaction error:", error.message);

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: "Error.",
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }
});

client.once(Events.ClientReady ?? "clientReady", async () => {
    console.log(`Bot logged in as ${client.user.tag}`);

    const rest = new REST({ version: "10" })
        .setToken(DISCORD_TOKEN);

    try {
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );

        console.log("Slash commands registered");
    } catch (error) {
        console.error("Command registration failed:", error);
    }

    await checkInvasions();

    setInterval(checkInvasions, 15000);
});

if (
    !DISCORD_TOKEN ||
    !CLIENT_ID ||
    !GUILD_ID ||
    !CHANNEL_ID ||
    !API_SECRET ||
    !ALLOWED_ROLE_IDS.size
) {
    throw new Error("Check your .env configuration");
}

client.login(DISCORD_TOKEN);
