import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  commands,
  getAfkStatus,
  clearAfkStatus,
  globalBlacklist,
} from "./commands";
import { deployCommands } from "./deploy-commands";
import { logger } from "../lib/logger";

const commandMap = new Map(commands.map((command) => [command.data.name, command]));

export function startDiscordBot() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  const clientId = process.env["DISCORD_CLIENT_ID"];

  if (!token || !clientId) {
    logger.warn(
      "DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID not set — Discord bot will not start",
    );
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(
      { tag: readyClient.user.tag },
      "Discord bot logged in and online",
    );

    try {
      await deployCommands(
        token,
        clientId,
        readyClient.guilds.cache.map((guild) => guild.id),
      );
    } catch (err) {
      logger.error({ err }, "Failed to register Discord slash commands");
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commandMap.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error(
        { err, command: interaction.commandName },
        "Error executing Discord command",
      );
      const reply = {
        content: "Something went wrong running that command.",
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const entry = globalBlacklist.get(member.id);
    if (!entry) return;

    await member
      .send(
        `You have been removed from **${member.guild.name}** because you are on this bot's global blacklist. Reason: ${entry.reason}`,
      )
      .catch(() => undefined);

    await member
      .kick(`Global blacklist: ${entry.reason}`)
      .catch((err) =>
        logger.error(
          { err, userId: member.id },
          "Failed to auto-kick blacklisted user",
        ),
      );

    logger.info(
      { userId: member.id, guildId: member.guild.id },
      "Auto-kicked blacklisted user on join",
    );
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;

    const authorAfk = getAfkStatus(guildId, message.author.id);
    if (authorAfk) {
      clearAfkStatus(guildId, message.author.id);
      await message
        .reply("Welcome back! I've removed your AFK status.")
        .catch(() => undefined);
    }

    if (message.mentions.users.size > 0) {
      const notices: string[] = [];
      for (const [userId, user] of message.mentions.users) {
        if (userId === message.author.id) continue;
        const status = getAfkStatus(guildId, userId);
        if (status) {
          notices.push(`${user.username} is AFK: ${status.reason}`);
        }
      }
      if (notices.length > 0) {
        await message.reply(notices.join("\n")).catch(() => undefined);
      }
    }
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, "Discord client error");
  });

  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to log in to Discord");
  });

  const shutdown = () => {
    logger.info("Shutting down Discord bot");
    client.destroy();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return client;
}
