import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  type ChatInputCommandInteraction,
  type TextChannel,
  type GuildMember,
} from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  type AudioPlayer,
} from "@discordjs/voice";
import prism from "prism-media";
import ffmpegPath from "ffmpeg-static";

if (ffmpegPath) {
  process.env["FFMPEG_PATH"] = ffmpegPath;
}

export interface BotCommand {
  data: Pick<SlashCommandBuilder, "name" | "toJSON">;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

interface Warning {
  moderatorId: string;
  reason: string;
  timestamp: number;
}

const warnings = new Map<string, Map<string, Warning[]>>();

function getGuildWarnings(guildId: string): Map<string, Warning[]> {
  let guildWarnings = warnings.get(guildId);
  if (!guildWarnings) {
    guildWarnings = new Map();
    warnings.set(guildId, guildWarnings);
  }
  return guildWarnings;
}

type ModActionType = "ban" | "kick" | "timeout" | "warn";

interface ModAction {
  type: ModActionType;
  moderatorId: string;
  reason: string;
  timestamp: number;
}

const modActions = new Map<string, Map<string, ModAction[]>>();

function logModAction(
  guildId: string,
  userId: string,
  action: ModAction,
): void {
  let guildActions = modActions.get(guildId);
  if (!guildActions) {
    guildActions = new Map();
    modActions.set(guildId, guildActions);
  }
  const userActions = guildActions.get(userId) ?? [];
  userActions.push(action);
  guildActions.set(userId, userActions);
}

function getModActions(guildId: string, userId: string): ModAction[] {
  return modActions.get(guildId)?.get(userId) ?? [];
}

interface AfkStatus {
  reason: string;
  timestamp: number;
}

export const afkStatuses = new Map<string, Map<string, AfkStatus>>();

export function getAfkStatus(
  guildId: string,
  userId: string,
): AfkStatus | undefined {
  return afkStatuses.get(guildId)?.get(userId);
}

export function setAfkStatus(
  guildId: string,
  userId: string,
  status: AfkStatus,
): void {
  let guildAfk = afkStatuses.get(guildId);
  if (!guildAfk) {
    guildAfk = new Map();
    afkStatuses.set(guildId, guildAfk);
  }
  guildAfk.set(userId, status);
}

export function clearAfkStatus(guildId: string, userId: string): void {
  afkStatuses.get(guildId)?.delete(userId);
}

export interface BlacklistEntry {
  reason: string;
  moderatorId: string;
  timestamp: number;
}

export const globalBlacklist = new Map<string, BlacklistEntry>();

const configuredBotOwnerId = "1498031500791386153";

function isBotOwner(interaction: ChatInputCommandInteraction): boolean {
  return interaction.user.id === configuredBotOwnerId;
}

const players = new Map<string, AudioPlayer>();
const queues = new Map<string, string[]>();
const nowPlaying = new Map<string, string>();
const volumes = new Map<string, number>();
const resources = new Map<
  string,
  ReturnType<typeof createAudioResource>
>();
type LoopMode = "off" | "track" | "queue";
const loopModes = new Map<string, LoopMode>();

function getQueue(guildId: string): string[] {
  let queue = queues.get(guildId);
  if (!queue) {
    queue = [];
    queues.set(guildId, queue);
  }
  return queue;
}

function playTrack(
  guildId: string,
  url: string,
  player: AudioPlayer,
  startSeconds = 0,
) {
  nowPlaying.set(guildId, url);
  const transcoder = new prism.FFmpeg({
    args: [
      ...(startSeconds > 0 ? ["-ss", String(startSeconds)] : []),
      "-i",
      url,
      "-analyzeduration",
      "0",
      "-loglevel",
      "0",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
    ],
  });

  const resource = createAudioResource(transcoder, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });

  resource.volume?.setVolume(volumes.get(guildId) ?? 1);
  resources.set(guildId, resource);

  player.once("error", () => {
    transcoder.destroy();
  });

  player.play(resource);
}

function playNext(guildId: string, player: AudioPlayer) {
  const loopMode = loopModes.get(guildId) ?? "off";
  const current = nowPlaying.get(guildId);

  if (loopMode === "track" && current) {
    playTrack(guildId, current, player);
    return;
  }

  const queue = getQueue(guildId);
  const next = queue.shift();

  if (!next) {
    nowPlaying.delete(guildId);
    return;
  }

  if (loopMode === "queue" && current) {
    queue.push(current);
  }

  playTrack(guildId, next, player);
}

function ensurePlayer(guildId: string, connection: ReturnType<typeof getVoiceConnection>) {
  let player = players.get(guildId);
  if (!player) {
    player = createAudioPlayer();
    players.set(guildId, player);
    connection?.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
      playNext(guildId, player!);
    });
  }
  return player;
}

const ping: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the bot is online"),
  execute: async (interaction) => {
    const sent = Date.now() - interaction.createdTimestamp;
    await interaction.reply(`Pong! (${sent}ms)`);
  },
};

const say: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("say")
    .setDescription("Have the bot repeat a message")
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("The message to repeat")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    const message = interaction.options.getString("message", true);
    await interaction.reply(message);
  },
};

const uptime: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("uptime")
    .setDescription("Show how long the bot has been online"),
  execute: async (interaction) => {
    const seconds = Math.floor(process.uptime());
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    await interaction.reply(`Online for ${hrs}h ${mins}m ${secs}s`);
  },
};

const purge: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Bulk-delete recent messages from this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Number of messages to delete (1-100)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100),
    ),
  execute: async (interaction) => {
    const amount = interaction.options.getInteger("amount", true);
    const channel = interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: "This command can only be used in a server text channel.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const deleted = await (channel as TextChannel).bulkDelete(amount, true);

    await interaction.editReply(
      `Deleted ${deleted.size} message${deleted.size === 1 ? "" : "s"}. Note: Discord only allows bulk-deleting messages younger than 14 days.`,
    );
  },
};

const ban: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member from the server")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to ban")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason for the ban")
        .setRequired(false),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const reason =
      interaction.options.getString("reason") ?? "No reason provided";

    await interaction.deferReply({ ephemeral: true });

    const member = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    if (member) {
      const executorMember = interaction.member as GuildMember | null;
      if (
        executorMember &&
        member.roles.highest.position >= executorMember.roles.highest.position &&
        interaction.guild.ownerId !== interaction.user.id
      ) {
        await interaction.editReply(
          "You can't ban a member with an equal or higher role than you.",
        );
        return;
      }

      if (!member.bannable) {
        await interaction.editReply(
          "I don't have permission to ban that member (their role may be higher than mine).",
        );
        return;
      }
    }

    try {
      await interaction.guild.members.ban(targetUser.id, { reason });
      logModAction(interaction.guild.id, targetUser.id, {
        type: "ban",
        moderatorId: interaction.user.id,
        reason,
        timestamp: Date.now(),
      });
      await interaction.editReply(
        `Banned **${targetUser.tag}**. Reason: ${reason}`,
      );
    } catch (err) {
      await interaction.editReply(
        "Failed to ban that user. Check the bot's permissions and role position.",
      );
    }
  },
};

const kick: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member from the server")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to kick")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason for the kick")
        .setRequired(false),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const reason =
      interaction.options.getString("reason") ?? "No reason provided";

    await interaction.deferReply({ ephemeral: true });

    const member = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    if (!member) {
      await interaction.editReply("That user isn't a member of this server.");
      return;
    }

    const executorMember = interaction.member as GuildMember | null;
    if (
      executorMember &&
      member.roles.highest.position >= executorMember.roles.highest.position &&
      interaction.guild.ownerId !== interaction.user.id
    ) {
      await interaction.editReply(
        "You can't kick a member with an equal or higher role than you.",
      );
      return;
    }

    if (!member.kickable) {
      await interaction.editReply(
        "I don't have permission to kick that member (their role may be higher than mine).",
      );
      return;
    }

    try {
      await member.kick(reason);
      logModAction(interaction.guild.id, targetUser.id, {
        type: "kick",
        moderatorId: interaction.user.id,
        reason,
        timestamp: Date.now(),
      });
      await interaction.editReply(
        `Kicked **${targetUser.tag}**. Reason: ${reason}`,
      );
    } catch (err) {
      await interaction.editReply(
        "Failed to kick that user. Check the bot's permissions and role position.",
      );
    }
  },
};

const addrole: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("addrole")
    .setDescription("Add a role to a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to give the role to")
        .setRequired(true),
    )
    .addRoleOption((option) =>
      option
        .setName("role")
        .setDescription("The role to add")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const role = interaction.options.getRole("role", true);

    await interaction.deferReply({ ephemeral: true });

    const member = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    if (!member) {
      await interaction.editReply("That user isn't a member of this server.");
      return;
    }

    const botMember = interaction.guild.members.me;
    if (
      !botMember ||
      role.position >= botMember.roles.highest.position
    ) {
      await interaction.editReply(
        "I can't assign that role — it's positioned above my highest role. Move my role above it in Server Settings.",
      );
      return;
    }

    const executorMember = interaction.member as GuildMember | null;
    if (
      executorMember &&
      role.position >= executorMember.roles.highest.position &&
      interaction.guild.ownerId !== interaction.user.id
    ) {
      await interaction.editReply(
        "You can't assign a role equal to or higher than your own highest role.",
      );
      return;
    }

    if (member.roles.cache.has(role.id)) {
      await interaction.editReply(
        `**${targetUser.tag}** already has the **${role.name}** role.`,
      );
      return;
    }

    try {
      await member.roles.add(role.id);
      await interaction.editReply(
        `Added **${role.name}** to **${targetUser.tag}**.`,
      );
    } catch (err) {
      await interaction.editReply(
        "Failed to add that role. Check the bot's permissions and role position.",
      );
    }
  },
};

const removerole: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("removerole")
    .setDescription("Remove a role from a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to remove the role from")
        .setRequired(true),
    )
    .addRoleOption((option) =>
      option
        .setName("role")
        .setDescription("The role to remove")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const role = interaction.options.getRole("role", true);

    await interaction.deferReply({ ephemeral: true });

    const member = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    if (!member) {
      await interaction.editReply("That user isn't a member of this server.");
      return;
    }

    const botMember = interaction.guild.members.me;
    if (
      !botMember ||
      role.position >= botMember.roles.highest.position
    ) {
      await interaction.editReply(
        "I can't remove that role — it's positioned above my highest role. Move my role above it in Server Settings.",
      );
      return;
    }

    const executorMember = interaction.member as GuildMember | null;
    if (
      executorMember &&
      role.position >= executorMember.roles.highest.position &&
      interaction.guild.ownerId !== interaction.user.id
    ) {
      await interaction.editReply(
        "You can't remove a role equal to or higher than your own highest role.",
      );
      return;
    }

    if (!member.roles.cache.has(role.id)) {
      await interaction.editReply(
        `**${targetUser.tag}** doesn't have the **${role.name}** role.`,
      );
      return;
    }

    try {
      await member.roles.remove(role.id);
      await interaction.editReply(
        `Removed **${role.name}** from **${targetUser.tag}**.`,
      );
    } catch (err) {
      await interaction.editReply(
        "Failed to remove that role. Check the bot's permissions and role position.",
      );
    }
  },
};

const join: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("join")
    .setDescription("Have the bot join your current voice channel"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const member = interaction.member as GuildMember | null;
    const voiceChannel = member?.voice.channel;

    if (!voiceChannel) {
      await interaction.reply({
        content: "You need to be in a voice channel first.",
        ephemeral: true,
      });
      return;
    }

    const botMember = interaction.guild.members.me;
    const permissions = voiceChannel.permissionsFor(botMember ?? interaction.client.user.id);
    if (!permissions?.has(PermissionFlagsBits.Connect)) {
      await interaction.reply({
        content: "I don't have permission to join that voice channel.",
        ephemeral: true,
      });
      return;
    }

    try {
      joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true,
      });

      await interaction.reply(`Joined **${voiceChannel.name}**.`);
    } catch (err) {
      await interaction.reply({
        content: "Failed to join the voice channel.",
        ephemeral: true,
      });
    }
  },
};

const leave: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Have the bot leave its current voice channel"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const connection = getVoiceConnection(interaction.guild.id);

    if (!connection) {
      await interaction.reply({
        content: "I'm not in a voice channel.",
        ephemeral: true,
      });
      return;
    }

    connection.destroy();
    await interaction.reply("Left the voice channel.");
  },
};

const play: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription(
      "Play or queue audio from a direct URL in the bot's voice channel",
    )
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("Direct link to an audio/video stream")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const connection = getVoiceConnection(interaction.guild.id);
    if (!connection) {
      await interaction.reply({
        content: "I'm not in a voice channel. Use /join first.",
        ephemeral: true,
      });
      return;
    }

    const url = interaction.options.getString("url", true);
    const guildId = interaction.guild.id;

    await interaction.deferReply();

    try {
      const player = ensurePlayer(guildId, connection);

      if (player.state.status === AudioPlayerStatus.Idle) {
        playTrack(guildId, url, player);
        await interaction.editReply(`Now playing: ${url}`);
      } else {
        const queue = getQueue(guildId);
        queue.push(url);
        await interaction.editReply(
          `Added to queue (position ${queue.length}): ${url}`,
        );
      }
    } catch (err) {
      await interaction.editReply(
        "Failed to play that audio. Make sure the URL points directly to an audio/video stream.",
      );
    }
  },
};

const stop: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop audio playback and clear the queue"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const player = players.get(interaction.guild.id);
    if (!player || player.state.status === AudioPlayerStatus.Idle) {
      await interaction.reply({
        content: "Nothing is playing right now.",
        ephemeral: true,
      });
      return;
    }

    getQueue(interaction.guild.id).length = 0;
    nowPlaying.delete(interaction.guild.id);
    player.stop();
    await interaction.reply("Stopped playback and cleared the queue.");
  },
};

const skip: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current track and play the next one in queue"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const player = players.get(interaction.guild.id);
    if (!player || player.state.status === AudioPlayerStatus.Idle) {
      await interaction.reply({
        content: "Nothing is playing right now.",
        ephemeral: true,
      });
      return;
    }

    player.stop();
    await interaction.reply("Skipped.");
  },
};

const queueCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current audio queue"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const player = players.get(interaction.guild.id);
    const queue = getQueue(interaction.guild.id);
    const isPlaying = player?.state.status !== AudioPlayerStatus.Idle;
    const current = nowPlaying.get(interaction.guild.id);

    if (!isPlaying && queue.length === 0) {
      await interaction.reply({
        content: "Nothing is playing and the queue is empty.",
        ephemeral: true,
      });
      return;
    }

    const lines = [
      isPlaying && current ? `Now playing: ${current}` : "Nothing playing",
      ...queue.map((url, i) => `${i + 1}. ${url}`),
    ];

    await interaction.reply(lines.join("\n"));
  },
};

const nowPlayingCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the currently playing track"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const player = players.get(interaction.guild.id);
    const current = nowPlaying.get(interaction.guild.id);

    if (!player || player.state.status === AudioPlayerStatus.Idle || !current) {
      await interaction.reply({
        content: "Nothing is playing right now.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply(`Now playing: ${current}`);
  },
};

const volume: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set the playback volume (0-200%)")
    .addIntegerOption((option) =>
      option
        .setName("percent")
        .setDescription("Volume percentage (0-200)")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const guildId = interaction.guild.id;
    const percent = interaction.options.getInteger("percent", true);
    const level = percent / 100;

    volumes.set(guildId, level);

    const resource = resources.get(guildId);
    if (resource?.volume) {
      resource.volume.setVolume(level);
    }

    await interaction.reply(`Volume set to ${percent}%.`);
  },
};

const loop: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set the loop mode")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Loop mode")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Track", value: "track" },
          { name: "Queue", value: "queue" },
        ),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const mode = interaction.options.getString("mode", true) as LoopMode;
    loopModes.set(interaction.guild.id, mode);

    const labels: Record<LoopMode, string> = {
      off: "Loop disabled.",
      track: "Now looping the current track.",
      queue: "Now looping the whole queue.",
    };

    await interaction.reply(labels[mode]);
  },
};

const shuffle: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffle the current queue"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const queue = getQueue(interaction.guild.id);
    if (queue.length < 2) {
      await interaction.reply({
        content: "Not enough tracks in the queue to shuffle.",
        ephemeral: true,
      });
      return;
    }

    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j]!, queue[i]!];
    }

    await interaction.reply(`Shuffled ${queue.length} track(s) in the queue.`);
  },
};

const remove: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a track from the queue by its position")
    .addIntegerOption((option) =>
      option
        .setName("position")
        .setDescription("Position in the queue (see /queue)")
        .setRequired(true)
        .setMinValue(1),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const queue = getQueue(interaction.guild.id);
    const position = interaction.options.getInteger("position", true);
    const index = position - 1;

    if (index < 0 || index >= queue.length) {
      await interaction.reply({
        content: `Invalid position. The queue currently has ${queue.length} track(s).`,
        ephemeral: true,
      });
      return;
    }

    const [removed] = queue.splice(index, 1);
    await interaction.reply(`Removed from queue: ${removed}`);
  },
};

const clearQueue: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("clearqueue")
    .setDescription("Clear the queue without stopping the current track"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const queue = getQueue(interaction.guild.id);
    const count = queue.length;
    queue.length = 0;

    await interaction.reply(
      count > 0
        ? `Cleared ${count} track(s) from the queue.`
        : "The queue was already empty.",
    );
  },
};

const pause: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current track"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const player = players.get(interaction.guild.id);
    if (!player || player.state.status !== AudioPlayerStatus.Playing) {
      await interaction.reply({
        content: "Nothing is playing right now.",
        ephemeral: true,
      });
      return;
    }

    player.pause();
    await interaction.reply("Paused playback.");
  },
};

const resume: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume paused playback"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const player = players.get(interaction.guild.id);
    if (!player || player.state.status !== AudioPlayerStatus.Paused) {
      await interaction.reply({
        content: "Playback isn't paused.",
        ephemeral: true,
      });
      return;
    }

    player.unpause();
    await interaction.reply("Resumed playback.");
  },
};

const seek: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Jump to a specific timestamp in the current track")
    .addIntegerOption((option) =>
      option
        .setName("seconds")
        .setDescription("Timestamp in seconds to jump to")
        .setRequired(true)
        .setMinValue(0),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const guildId = interaction.guild.id;
    const player = players.get(guildId);
    const current = nowPlaying.get(guildId);

    if (
      !player ||
      !current ||
      (player.state.status !== AudioPlayerStatus.Playing &&
        player.state.status !== AudioPlayerStatus.Paused)
    ) {
      await interaction.reply({
        content: "Nothing is playing right now.",
        ephemeral: true,
      });
      return;
    }

    const seconds = interaction.options.getInteger("seconds", true);

    playTrack(guildId, current, player, seconds);

    await interaction.reply(`Jumped to ${seconds}s.`);
  },
};

const lyrics: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("lyrics")
    .setDescription("Look up lyrics for a song")
    .addStringOption((option) =>
      option
        .setName("artist")
        .setDescription("Artist name")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("title")
        .setDescription("Song title")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    const artist = interaction.options.getString("artist", true);
    const title = interaction.options.getString("title", true);

    await interaction.deferReply();

    try {
      const response = await fetch(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
      );

      if (!response.ok) {
        await interaction.editReply(
          `No lyrics found for "${title}" by ${artist}.`,
        );
        return;
      }

      const data = (await response.json()) as { lyrics?: string };
      const text = data.lyrics?.trim();

      if (!text) {
        await interaction.editReply(
          `No lyrics found for "${title}" by ${artist}.`,
        );
        return;
      }

      const header = `**${title} — ${artist}**\n\n`;
      const maxBodyLength = 1900 - header.length;
      const body =
        text.length > maxBodyLength
          ? `${text.slice(0, maxBodyLength)}...`
          : text;

      await interaction.editReply(`${header}${body}`);
    } catch (err) {
      await interaction.editReply(
        "Something went wrong looking up those lyrics.",
      );
    }
  },
};

const eightBallResponses = [
  "It is certain.",
  "Without a doubt.",
  "Yes, definitely.",
  "You may rely on it.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Yes.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
];

const eightBall: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Ask the magic 8-ball a question")
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("Your question")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    const question = interaction.options.getString("question", true);
    const answer =
      eightBallResponses[
        Math.floor(Math.random() * eightBallResponses.length)
      ];

    await interaction.reply(`🎱 **${question}**\n${answer}`);
  },
};

const pollEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

const poll: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Create a poll")
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("The poll question")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("options")
        .setDescription("Comma-separated options (2-10). Leave blank for yes/no")
        .setRequired(false),
    ),
  execute: async (interaction) => {
    const question = interaction.options.getString("question", true);
    const rawOptions = interaction.options.getString("options");

    const options = rawOptions
      ? rawOptions
          .split(",")
          .map((option) => option.trim())
          .filter(Boolean)
      : ["Yes", "No"];

    if (options.length < 2 || options.length > 10) {
      await interaction.reply({
        content: "Please provide between 2 and 10 options.",
        ephemeral: true,
      });
      return;
    }

    const lines = options.map(
      (option, i) => `${pollEmojis[i]} ${option}`,
    );

    const response = await interaction.reply({
      content: `📊 **${question}**\n\n${lines.join("\n")}`,
      withResponse: true,
    });

    const message = response.resource?.message;
    if (message) {
      for (let i = 0; i < options.length; i++) {
        await message.react(pollEmojis[i]!);
      }
    }
  },
};

function parseDuration(input: string): number | null {
  const match = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(
    input.trim(),
  );
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1,
    sec: 1,
    secs: 1,
    second: 1,
    seconds: 1,
    m: 60,
    min: 60,
    mins: 60,
    minute: 60,
    minutes: 60,
    h: 3600,
    hr: 3600,
    hrs: 3600,
    hour: 3600,
    hours: 3600,
    d: 86400,
    day: 86400,
    days: 86400,
  };

  const seconds = amount * (multipliers[unit] ?? 0);
  return seconds > 0 ? seconds : null;
}

const remind: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("remind")
    .setDescription("Set a reminder")
    .addStringOption((option) =>
      option
        .setName("time")
        .setDescription("e.g. 10m, 2h, 1d, 30s")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("What should I remind you about?")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    const timeInput = interaction.options.getString("time", true);
    const message = interaction.options.getString("message", true);
    const seconds = parseDuration(timeInput);

    if (!seconds) {
      await interaction.reply({
        content:
          "I couldn't understand that time. Try something like 10m, 2h, 1d, or 30s.",
        ephemeral: true,
      });
      return;
    }

    const maxSeconds = 30 * 86400;
    if (seconds > maxSeconds) {
      await interaction.reply({
        content: "Reminders can be set at most 30 days out.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply(
      `Got it! I'll remind you in ${timeInput}: "${message}"`,
    );

    const userId = interaction.user.id;

    setTimeout(async () => {
      try {
        const user = await interaction.client.users.fetch(userId);
        await user.send(`⏰ Reminder: ${message}`);
      } catch {
        if (interaction.channel?.isSendable()) {
          await interaction.channel.send(
            `⏰ <@${userId}> Reminder: ${message}`,
          );
        }
      }
    }, seconds * 1000);
  },
};

const warn: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Manage user warnings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Warn a user")
        .addUserOption((option) =>
          option.setName("user").setDescription("User to warn").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Reason for the warning")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List warnings for a user")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("User to check")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setDescription("Clear all warnings for a user")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("User to clear")
            .setRequired(true),
        ),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const member = interaction.member as GuildMember;
    if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await interaction.reply({
        content: "You don't have permission to manage warnings.",
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser("user", true);
    const guildWarnings = getGuildWarnings(interaction.guild.id);

    if (subcommand === "add") {
      const reason = interaction.options.getString("reason", true);
      const userWarnings = guildWarnings.get(targetUser.id) ?? [];
      userWarnings.push({
        moderatorId: interaction.user.id,
        reason,
        timestamp: Date.now(),
      });
      guildWarnings.set(targetUser.id, userWarnings);
      logModAction(interaction.guild.id, targetUser.id, {
        type: "warn",
        moderatorId: interaction.user.id,
        reason,
        timestamp: Date.now(),
      });

      await interaction.reply(
        `Warned ${targetUser.tag}. They now have ${userWarnings.length} warning(s).`,
      );
      return;
    }

    if (subcommand === "list") {
      const userWarnings = guildWarnings.get(targetUser.id) ?? [];

      if (userWarnings.length === 0) {
        await interaction.reply(`${targetUser.tag} has no warnings.`);
        return;
      }

      const lines = userWarnings.map(
        (w, i) =>
          `${i + 1}. ${w.reason} — by <@${w.moderatorId}> on <t:${Math.floor(w.timestamp / 1000)}:d>`,
      );

      await interaction.reply(
        `**Warnings for ${targetUser.tag}:**\n${lines.join("\n")}`,
      );
      return;
    }

    if (subcommand === "clear") {
      const hadWarnings = (guildWarnings.get(targetUser.id)?.length ?? 0) > 0;
      guildWarnings.delete(targetUser.id);

      await interaction.reply(
        hadWarnings
          ? `Cleared all warnings for ${targetUser.tag}.`
          : `${targetUser.tag} had no warnings.`,
      );
    }
  },
};

const timeout: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Temporarily mute a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to time out")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("duration")
        .setDescription("e.g. 10m, 1h, 1d (max 28d)")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason for the timeout")
        .setRequired(false),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const durationInput = interaction.options.getString("duration", true);
    const reason =
      interaction.options.getString("reason") ?? "No reason provided";

    const seconds = parseDuration(durationInput);
    const maxSeconds = 28 * 86400;

    if (!seconds) {
      await interaction.reply({
        content:
          "I couldn't understand that duration. Try something like 10m, 1h, or 1d.",
        ephemeral: true,
      });
      return;
    }

    if (seconds > maxSeconds) {
      await interaction.reply({
        content: "Timeouts can be at most 28 days.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const member = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    if (!member) {
      await interaction.editReply("That user isn't a member of this server.");
      return;
    }

    const executorMember = interaction.member as GuildMember | null;
    if (
      executorMember &&
      member.roles.highest.position >= executorMember.roles.highest.position &&
      interaction.guild.ownerId !== interaction.user.id
    ) {
      await interaction.editReply(
        "You can't time out a member with an equal or higher role than you.",
      );
      return;
    }

    if (!member.moderatable) {
      await interaction.editReply(
        "I don't have permission to time out that member (their role may be higher than mine).",
      );
      return;
    }

    try {
      await member.timeout(seconds * 1000, reason);
      logModAction(interaction.guild.id, targetUser.id, {
        type: "timeout",
        moderatorId: interaction.user.id,
        reason,
        timestamp: Date.now(),
      });
      await interaction.editReply(
        `Timed out **${targetUser.tag}** for ${durationInput}. Reason: ${reason}`,
      );
    } catch (err) {
      await interaction.editReply(
        "Something went wrong trying to time out that member.",
      );
    }
  },
};

const modlogs: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("modlogs")
    .setDescription("Show moderation history for a user")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("User to look up")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const actions = getModActions(interaction.guild.id, targetUser.id);

    if (actions.length === 0) {
      await interaction.reply(`${targetUser.tag} has no moderation history.`);
      return;
    }

    const sorted = [...actions].sort((a, b) => b.timestamp - a.timestamp);

    const labels: Record<ModActionType, string> = {
      ban: "🔨 Ban",
      kick: "👢 Kick",
      timeout: "🔇 Timeout",
      warn: "⚠️ Warn",
    };

    const lines = sorted.map(
      (action) =>
        `${labels[action.type]} — ${action.reason} — by <@${action.moderatorId}> on <t:${Math.floor(action.timestamp / 1000)}:d>`,
    );

    const header = `**Moderation history for ${targetUser.tag}:**\n\n`;
    const maxBodyLength = 1900 - header.length;
    const body = lines.join("\n");
    const truncated =
      body.length > maxBodyLength
        ? `${body.slice(0, maxBodyLength)}...`
        : body;

    await interaction.reply(`${header}${truncated}`);
  },
};

const modstats: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("modstats")
    .setDescription("Show server-wide moderation stats")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const guildActions = modActions.get(interaction.guild.id);

    if (!guildActions || guildActions.size === 0) {
      await interaction.reply("No moderation actions have been logged yet.");
      return;
    }

    const typeCounts: Record<ModActionType, number> = {
      ban: 0,
      kick: 0,
      timeout: 0,
      warn: 0,
    };
    const moderatorCounts = new Map<string, number>();
    const targetCounts = new Map<string, number>();
    let total = 0;

    for (const [userId, actions] of guildActions) {
      for (const action of actions) {
        total += 1;
        typeCounts[action.type] += 1;
        moderatorCounts.set(
          action.moderatorId,
          (moderatorCounts.get(action.moderatorId) ?? 0) + 1,
        );
        targetCounts.set(userId, (targetCounts.get(userId) ?? 0) + 1);
      }
    }

    const topModerators = [...moderatorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count], i) => `${i + 1}. <@${id}> — ${count} action(s)`)
      .join("\n");

    const topTargets = [...targetCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count], i) => `${i + 1}. <@${id}> — ${count} action(s)`)
      .join("\n");

    const summary =
      `**Moderation stats for ${interaction.guild.name}**\n\n` +
      `Total actions: ${total}\n` +
      `🔨 Bans: ${typeCounts.ban}  👢 Kicks: ${typeCounts.kick}  🔇 Timeouts: ${typeCounts.timeout}  ⚠️ Warns: ${typeCounts.warn}\n\n` +
      `**Most active moderators:**\n${topModerators || "None"}\n\n` +
      `**Most actioned members:**\n${topTargets || "None"}`;

    await interaction.reply(summary);
  },
};

const serverinfo: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Show information about this server"),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const guild = interaction.guild;
    await interaction.deferReply();
    const fullGuild = await guild.fetch();

    const owner = await fullGuild.fetchOwner().catch(() => null);
    const createdTimestamp = Math.floor(
      fullGuild.createdTimestamp / 1000,
    );

    const boostLevelLabels: Record<number, string> = {
      0: "None",
      1: "Level 1",
      2: "Level 2",
      3: "Level 3",
    };

    const summary =
      `**${fullGuild.name}**\n\n` +
      `Owner: ${owner ? `<@${owner.id}>` : "Unknown"}\n` +
      `Members: ${fullGuild.memberCount}\n` +
      `Roles: ${fullGuild.roles.cache.size}\n` +
      `Channels: ${fullGuild.channels.cache.size}\n` +
      `Boost level: ${boostLevelLabels[fullGuild.premiumTier] ?? fullGuild.premiumTier} (${fullGuild.premiumSubscriptionCount ?? 0} boosts)\n` +
      `Created: <t:${createdTimestamp}:D> (<t:${createdTimestamp}:R>)`;

    if (fullGuild.iconURL()) {
      await interaction.editReply({
        content: summary,
        files: [fullGuild.iconURL({ size: 256 })!],
      });
    } else {
      await interaction.editReply(summary);
    }
  },
};

const userinfo: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Show information about a member")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to look up (defaults to you)")
        .setRequired(false),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const targetUser =
      interaction.options.getUser("user") ?? interaction.user;

    await interaction.deferReply();

    const member = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    if (!member) {
      await interaction.editReply("That user isn't a member of this server.");
      return;
    }

    const createdTimestamp = Math.floor(targetUser.createdTimestamp / 1000);
    const joinedTimestamp = member.joinedTimestamp
      ? Math.floor(member.joinedTimestamp / 1000)
      : null;

    const roles = member.roles.cache
      .filter((role) => role.id !== interaction.guild!.id)
      .sort((a, b) => b.position - a.position)
      .map((role) => `<@&${role.id}>`);

    const statusLabels: Record<string, string> = {
      online: "🟢 Online",
      idle: "🌙 Idle",
      dnd: "⛔ Do Not Disturb",
      offline: "⚪ Offline",
    };
    const presenceStatus = member.presence?.status ?? "offline";

    const summary =
      `**${targetUser.tag}**\n\n` +
      `Status: ${statusLabels[presenceStatus] ?? presenceStatus}\n` +
      `Nickname: ${member.nickname ?? "None"}\n` +
      `Account created: <t:${createdTimestamp}:D> (<t:${createdTimestamp}:R>)\n` +
      `Joined server: ${joinedTimestamp ? `<t:${joinedTimestamp}:D> (<t:${joinedTimestamp}:R>)` : "Unknown"}\n` +
      `Roles (${roles.length}): ${roles.length > 0 ? roles.join(", ") : "None"}`;

    const avatarUrl = targetUser.displayAvatarURL({ size: 256 });
    await interaction.editReply({
      content: summary,
      files: avatarUrl ? [avatarUrl] : [],
    });
  },
};

const roleinfo: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription("Show information about a role")
    .addRoleOption((option) =>
      option
        .setName("role")
        .setDescription("The role to look up")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const role = interaction.options.getRole("role", true);

    await interaction.deferReply();

    const fullRole = await interaction.guild.roles
      .fetch(role.id)
      .catch(() => null);

    if (!fullRole) {
      await interaction.editReply("I couldn't find that role.");
      return;
    }

    const createdTimestamp = Math.floor(fullRole.createdTimestamp / 1000);

    const keyPermissions = [
      "Administrator",
      "ManageGuild",
      "ManageRoles",
      "ManageChannels",
      "ManageMessages",
      "KickMembers",
      "BanMembers",
      "ModerateMembers",
      "MentionEveryone",
    ] as const;

    const permissionLabels: Record<(typeof keyPermissions)[number], string> =
      {
        Administrator: "Administrator",
        ManageGuild: "Manage Server",
        ManageRoles: "Manage Roles",
        ManageChannels: "Manage Channels",
        ManageMessages: "Manage Messages",
        KickMembers: "Kick Members",
        BanMembers: "Ban Members",
        ModerateMembers: "Timeout Members",
        MentionEveryone: "Mention Everyone",
      };

    const grantedPermissions = keyPermissions
      .filter((perm) => fullRole.permissions.has(PermissionFlagsBits[perm]))
      .map((perm) => permissionLabels[perm]);

    const summary =
      `**${fullRole.name}**\n\n` +
      `Color: ${fullRole.hexColor === "#000000" ? "Default" : fullRole.hexColor}\n` +
      `Members: ${fullRole.members.size}\n` +
      `Position: ${fullRole.position}\n` +
      `Mentionable: ${fullRole.mentionable ? "Yes" : "No"}\n` +
      `Hoisted (shown separately): ${fullRole.hoist ? "Yes" : "No"}\n` +
      `Managed by integration: ${fullRole.managed ? "Yes" : "No"}\n` +
      `Created: <t:${createdTimestamp}:D> (<t:${createdTimestamp}:R>)\n` +
      `Key permissions: ${grantedPermissions.length > 0 ? grantedPermissions.join(", ") : "None"}`;

    await interaction.editReply(summary);
  },
};

const afk: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("afk")
    .setDescription("Mark yourself as AFK")
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why you're AFK")
        .setRequired(false),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const reason = interaction.options.getString("reason") ?? "AFK";

    setAfkStatus(interaction.guild.id, interaction.user.id, {
      reason,
      timestamp: Date.now(),
    });

    await interaction.reply(
      `You're now marked as AFK: ${reason}. I'll let people know if they mention you.`,
    );
  },
};

const tempban: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("tempban")
    .setDescription("Temporarily ban a member; auto-unbanned when it expires")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to temp-ban")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("duration")
        .setDescription("e.g. 10m, 1h, 1d, 7d")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason for the ban")
        .setRequired(false),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const durationInput = interaction.options.getString("duration", true);
    const reason =
      interaction.options.getString("reason") ?? "No reason provided";

    const seconds = parseDuration(durationInput);

    if (!seconds) {
      await interaction.reply({
        content:
          "I couldn't understand that duration. Try something like 10m, 1h, or 7d.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const member = await guild.members.fetch(targetUser.id).catch(() => null);

    if (member) {
      const executorMember = interaction.member as GuildMember | null;
      if (
        executorMember &&
        member.roles.highest.position >= executorMember.roles.highest.position &&
        guild.ownerId !== interaction.user.id
      ) {
        await interaction.editReply(
          "You can't ban a member with an equal or higher role than you.",
        );
        return;
      }

      if (!member.bannable) {
        await interaction.editReply(
          "I don't have permission to ban that member (their role may be higher than mine).",
        );
        return;
      }
    }

    try {
      await guild.members.ban(targetUser.id, { reason });
      logModAction(guild.id, targetUser.id, {
        type: "ban",
        moderatorId: interaction.user.id,
        reason: `${reason} (temp-ban: ${durationInput})`,
        timestamp: Date.now(),
      });

      setTimeout(() => {
        guild.members
          .unban(targetUser.id, "Temp-ban expired")
          .catch(() => undefined);
      }, seconds * 1000);

      await interaction.editReply(
        `Temp-banned **${targetUser.tag}** for ${durationInput}. Reason: ${reason}`,
      );
    } catch (err) {
      await interaction.editReply(
        "Failed to ban that user. Check the bot's permissions and role position.",
      );
    }
  },
};

async function getOrCreateMutedRole(guild: import("discord.js").Guild) {
  let role = guild.roles.cache.find((r) => r.name === "Muted");
  if (!role) {
    role = await guild.roles.create({
      name: "Muted",
      color: "#5c5c5c",
      permissions: [],
      reason: "Created for /mute command",
    });

    await Promise.all(
      guild.channels.cache.map(async (channel) => {
        if (channel.isThread()) return;
        if (!channel.isTextBased() && !channel.isVoiceBased()) return;
        try {
          await channel.permissionOverwrites.edit(role!, {
            SendMessages: false,
            AddReactions: false,
            Speak: false,
          });
        } catch {
          // Missing permissions on this channel; skip it.
        }
      }),
    );
  }
  return role;
}

const mute: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Silence a member using a Muted role")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to mute")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason for the mute")
        .setRequired(false),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const reason =
      interaction.options.getString("reason") ?? "No reason provided";

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const member = await guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      await interaction.editReply("That user isn't a member of this server.");
      return;
    }

    const executorMember = interaction.member as GuildMember | null;
    if (
      executorMember &&
      member.roles.highest.position >= executorMember.roles.highest.position &&
      guild.ownerId !== interaction.user.id
    ) {
      await interaction.editReply(
        "You can't mute a member with an equal or higher role than you.",
      );
      return;
    }

    try {
      const mutedRole = await getOrCreateMutedRole(guild);
      await member.roles.add(mutedRole, reason);
      logModAction(guild.id, targetUser.id, {
        type: "timeout",
        moderatorId: interaction.user.id,
        reason: `${reason} (muted role)`,
        timestamp: Date.now(),
      });
      await interaction.editReply(
        `Muted **${targetUser.tag}**. Reason: ${reason}`,
      );
    } catch (err) {
      await interaction.editReply(
        "Failed to mute that member. Check the bot's permissions and role position.",
      );
    }
  },
};

const unmute: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Remove the Muted role from a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to unmute")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const member = await guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      await interaction.editReply("That user isn't a member of this server.");
      return;
    }

    const mutedRole = guild.roles.cache.find((r) => r.name === "Muted");
    if (!mutedRole || !member.roles.cache.has(mutedRole.id)) {
      await interaction.editReply(`${targetUser.tag} isn't muted.`);
      return;
    }

    try {
      await member.roles.remove(mutedRole, "Unmuted");
      await interaction.editReply(`Unmuted **${targetUser.tag}**.`);
    } catch (err) {
      await interaction.editReply(
        "Failed to unmute that member. Check the bot's permissions and role position.",
      );
    }
  },
};

const blacklist: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("Manage the global blacklist (bot owner only)")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a user to the global blacklist")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The user to blacklist")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Reason for blacklisting")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a user from the global blacklist")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The user to remove")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("check")
        .setDescription("Check if a user is on the global blacklist")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The user to check")
            .setRequired(true),
        ),
    ),
  execute: async (interaction) => {
    const subcommand = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser("user", true);

    if (subcommand === "check") {
      const entry = globalBlacklist.get(targetUser.id);
      if (!entry) {
        await interaction.reply(
          `${targetUser.tag} is not on the global blacklist.`,
        );
        return;
      }
      await interaction.reply(
        `**${targetUser.tag}** is blacklisted.\nReason: ${entry.reason}\nBy: <@${entry.moderatorId}>\nSince: <t:${Math.floor(entry.timestamp / 1000)}:D>`,
      );
      return;
    }

    const isOwner = await isBotOwner(interaction);
    if (!isOwner) {
      await interaction.reply({
        content: "Only the bot owner can manage the global blacklist.",
        ephemeral: true,
      });
      return;
    }

    if (subcommand === "add") {
      const reason =
        interaction.options.getString("reason") ?? "No reason provided";
      globalBlacklist.set(targetUser.id, {
        reason,
        moderatorId: interaction.user.id,
        timestamp: Date.now(),
      });
      await interaction.reply(
        `Added **${targetUser.tag}** to the global blacklist. Reason: ${reason}`,
      );
      return;
    }

    if (subcommand === "remove") {
      const existed = globalBlacklist.delete(targetUser.id);
      await interaction.reply(
        existed
          ? `Removed **${targetUser.tag}** from the global blacklist.`
          : `${targetUser.tag} was not on the global blacklist.`,
      );
      return;
    }
  },
};

const setupRoleNames = Array.from(
  new Set([
    "[ES] Founder",
    "[ES] Owner",
    "[ES] Co-Owner",
    "[ES] Executive Owner",
    "[ES] Assistant Executive Owner",
    "[ES] Chief Executive Officer",
    "[ES] Chief Operations Officer",
    "[ES] Chief Technology Officer",
    "[ES] Chief Security Officer",
    "[ES] Executive Director",
    "[ES] Deputy Director",
    "[ES] Director",
    "[ES] Assistant Director",
    "[ES] Senior Administrator",
    "[ES] Administrator",
    "[ES] Head Manager",
    "[ES] General Manager",
    "[ES] Operations Manager",
    "[ES] Development Manager",
    "[ES] Security Manager",
    "[ES] Community Manager",
    "[ES] Project Manager",
    "[ES] Department Manager",
    "[ES] Assistant Manager",
    "[ES] Senior Management",
    "[ES] Management",
    "[ES] Management Team",
    "[ES] Head Developer",
    "[ES] Lead Developer",
    "[ES] Senior Developer",
    "[ES] Developer",
    "[ES] Junior Developer",
    "[ES] Bot Developer",
    "[ES] Discord Developer",
    "[ES] Systems Developer",
    "[ES] Backend Developer",
    "[ES] Frontend Developer",
    "[ES] Web Developer",
    "[ES] Database Developer",
    "[ES] API Developer",
    "[ES] Integration Developer",
    "[ES] Automation Developer",
    "[ES] Minecraft Developer",
    "[ES] Game Developer",
    "[ES] Developer Team",
    "[ES] Chief Security",
    "[ES] Security Director",
    "[ES] Head of Security",
    "[ES] Lead Security",
    "[ES] Senior Security",
    "[ES] Security Administrator",
    "[ES] Security Manager",
    "[ES] Security Specialist",
    "[ES] Security Analyst",
    "[ES] Security Officer",
    "[ES] Security Agent",
    "[ES] Security Staff",
    "[ES] Security Team",
    "[ES] Global Blacklist Director",
    "[ES] Global Blacklist Manager",
    "[ES] Global Blacklist Administrator",
    "[ES] Global Blacklist Staff",
    "[ES] Global Blacklist Investigator",
    "[ES] Global Blacklist Reviewer",
    "[ES] Global Blacklist Auditor",
    "[ES] Global Blacklist Appeals",
    "[ES] Blacklist Enforcement",
    "[ES] Blacklist Team",
    "[ES] Head of QA",
    "[ES] QA Director",
    "[ES] QA Manager",
    "[ES] Lead Tester",
    "[ES] Senior Tester",
    "[ES] Tester",
    "[ES] Beta Tester",
    "[ES] Alpha Tester",
    "[ES] Bug Hunter",
    "[ES] Bug Reporter",
    "[ES] Quality Assurance",
    "[ES] Testing Team",
    "[ES] Incident Commander",
    "[ES] Incident Director",
    "[ES] Incident Manager",
    "[ES] Response Manager",
    "[ES] Response Team",
    "[ES] Threat Analyst",
    "[ES] Threat Investigator",
    "[ES] Investigation Staff",
    "[ES] Incident Response",
    "[ES] Community Director",
    "[ES] Community Manager",
    "[ES] Senior Moderator",
    "[ES] Moderator",
    "[ES] Trial Moderator",
    "[ES] Senior Support",
    "[ES] Support Staff",
    "[ES] Community Staff",
    "[ES] Community Team",
    "[ES] Helper",
    "[ES] Minecraft Director",
    "[ES] Minecraft Manager",
    "[ES] Minecraft Administrator",
    "[ES] Minecraft Developer",
    "[ES] Minecraft Engineer",
    "[ES] Minecraft Moderator",
    "[ES] Minecraft Tester",
    "[ES] Minecraft Builder",
    "[ES] Minecraft Support",
    "[ES] Minecraft Team",
    "[ES] Media Director",
    "[ES] Media Manager",
    "[ES] Content Director",
    "[ES] Content Creator",
    "[ES] Graphic Designer",
    "[ES] Video Editor",
    "[ES] Social Media Manager",
    "[ES] Media Team",
    "[ES] Partnership Director",
    "[ES] Partnership Manager",
    "[ES] Partnership Representative",
    "[ES] Relations Manager",
    "[ES] Public Relations",
    "[ES] Partner",
    "[ES] Partner Team",
    "[ES] ESN Bot",
    "[ES] Security Bot",
    "[ES] Global Blacklist Bot",
    "[ES] Moderation Bot",
    "[ES] Protection Bot",
    "[ES] Minecraft Bot",
    "[ES] Development Bot",
    "[ES] Testing Bot",
    "[ES] Utility Bot",
    "[ES] Verified Developer",
    "[ES] Verified Security",
    "[ES] Verified Staff",
    "[ES] Bot Owner",
    "[ES] Bot Manager",
    "[ES] Bot Tester",
    "[ES] Contributor",
    "[ES] Project Lead",
    "[ES] Project Team",
    "[ES] Early Access",
    "[ES] Sneak Peek",
    "[ES] VIP",
    "[ES] Booster",
    "[ES] Retired",
    "[ES] Former Staff",
    "[ES] Member",
  ]),
);

const administratorRoleNames = new Set([
  "[ES] Founder",
  "[ES] Owner",
  "[ES] Co-Owner",
  "[ES] Executive Owner",
  "[ES] Assistant Executive Owner",
]);

const setupChannelGroups: ReadonlyArray<{
  name: string;
  channels: ReadonlyArray<{
    name: string;
    type: ChannelType.GuildText | ChannelType.GuildVoice;
  }>;
}> = [
  {
    name: "[ES] Information",
    channels: [
      "📌・important",
      "📜・rules",
      "👋・welcome",
      "📢・announcements",
      "📰・esn-news",
      "🛡️・about-es",
      "❓・faq",
      "📋・server-info",
      "🔗・useful-links",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Bot Information",
    channels: [
      "🤖・bot-information",
      "📊・bot-status",
      "🟢・online-bots",
      "🔴・offline-bots",
      "🔧・bot-development",
      "📦・bot-releases",
      "🔄・bot-updates",
      "📝・changelogs",
      "🐛・bug-reports",
      "💡・suggestions",
      "📈・bot-statistics",
      "🧪・bot-testing",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Sneak Peeks",
    channels: [
      "👀・sneak-peeks",
      "🔒・exclusive-sneaks",
      "📸・development-media",
      "🎥・development-videos",
      "🚧・work-in-progress",
      "✨・feature-previews",
      "🔜・upcoming-updates",
      "🧪・early-access",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Global Blacklist",
    channels: [
      "🌐・global-blacklist",
      "🔎・blacklist-check",
      "📋・blacklist-log",
      "📊・blacklist-stats",
      "🚨・blacklist-alerts",
      "🔍・blacklist-investigations",
      "📝・blacklist-reports",
      "⚖️・blacklist-appeals",
      "📁・blacklist-records",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Security",
    channels: [
      "🛡️・security-center",
      "🚨・security-alerts",
      "⚠️・incident-reports",
      "🔍・security-investigations",
      "🚫・threat-alerts",
      "🧱・raid-protection",
      "🔒・security-logs",
      "📊・security-status",
      "🧪・security-testing",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Development",
    channels: [
      "💻・developer-chat",
      "🧠・development-ideas",
      "📋・project-planning",
      "🔧・coding",
      "🧪・testing",
      "🐛・bug-fixing",
      "🚀・releases",
      "📦・builds",
      "🔗・api-development",
      "🗄️・database-development",
      "⚙️・system-development",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Minecraft",
    channels: [
      "⛏️・minecraft",
      "📢・minecraft-news",
      "💬・minecraft-chat",
      "🤖・minecraft-bots",
      "🔧・minecraft-development",
      "🧪・minecraft-testing",
      "🐛・minecraft-bugs",
      "🗺️・minecraft-projects",
      "📸・minecraft-media",
      "🚀・minecraft-updates",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Support & Reports",
    channels: [
      "🎫・open-ticket",
      "❓・help",
      "🐛・report-a-bug",
      "💡・submit-suggestion",
      "⚠️・report-a-user",
      "🔐・security-report",
      "🌐・blacklist-appeal",
      "🤝・partnership-request",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Community",
    channels: [
      "💬・general",
      "🎮・gaming",
      "⛏️・minecraft-chat",
      "🤖・bot-chat",
      "📸・media",
      "😂・memes",
      "🎉・events",
      "🏆・achievements",
      "💭・off-topic",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] System Status",
    channels: [
      "📊・system-status",
      "🤖・bot-monitor",
      "🌐・api-status",
      "🗄️・database-status",
      "🔐・security-status",
      "⛏️・minecraft-status",
      "📈・system-statistics",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] ESN Updates",
    channels: [
      "📢・esn-announcements",
      "📰・esn-updates",
      "🚀・new-releases",
      "🔄・maintenance",
      "⚠️・service-alerts",
      "📜・update-history",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Partnerships",
    channels: [
      "🤝・partners",
      "📢・partner-announcements",
      "📝・partnership-info",
      "🎫・partnership-tickets",
      "📋・partner-list",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Media",
    channels: [
      "📸・media",
      "🎥・videos",
      "🎨・graphics",
      "📱・social-media",
      "📢・content",
      "⭐・community-showcase",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Staff",
    channels: [
      "🔒・staff-chat",
      "📢・staff-announcements",
      "📋・staff-tasks",
      "📝・staff-notes",
      "🚨・staff-alerts",
      "📊・staff-status",
      "🎯・staff-goals",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Development Team",
    channels: [
      "💻・dev-team",
      "🧠・dev-ideas",
      "📋・dev-projects",
      "🐛・dev-bugs",
      "🧪・dev-testing",
      "🚀・dev-releases",
      "🔧・dev-tools",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Security Team",
    channels: [
      "🔐・security-team",
      "🚨・security-command",
      "🔍・security-investigations",
      "🌐・blacklist-team",
      "📋・security-reports",
      "📊・security-data",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Archive",
    channels: [
      "📦・old-announcements",
      "📁・old-projects",
      "📝・old-reports",
      "📋・old-blacklist-records",
      "🔧・deprecated-bots",
      "🗄️・development-archive",
    ].map((name) => ({ name, type: ChannelType.GuildText })),
  },
  {
    name: "[ES] Voice Channels",
    channels: [
      "🔊・General VC",
      "💻・Development VC",
      "🔐・Security VC",
      "🤖・Bot Development VC",
      "⛏️・Minecraft VC",
      "🎮・Gaming VC",
      "👑・Executive VC",
      "🧪・Testing VC",
    ].map((name) => ({ name, type: ChannelType.GuildVoice })),
  },
];

const setupCategoryOrder = [
  "[ES] Information",
  "[ES] Bot Information",
  "[ES] Sneak Peeks",
  "[ES] Support & Reports",
  "[ES] Community",
  "[ES] Voice Channels",
  "[ES] Minecraft",
  "[ES] Media",
  "[ES] Partnerships",
  "[ES] ESN Updates",
  "[ES] System Status",
  "[ES] Development",
  "[ES] Security",
  "[ES] Global Blacklist",
  "[ES] Archive",
  "[ES] Staff",
  "[ES] Development Team",
  "[ES] Security Team",
] as const;

const addEsPrefix = (names: readonly string[]): string[] =>
  names.map((name) => `[ES] ${name}`);

const leadershipRoleNames = [
  "Founder",
  "Owner",
  "Co-Owner",
  "Executive Owner",
  "Assistant Executive Owner",
  "Chief Executive Officer",
  "Chief Operations Officer",
  "Chief Technology Officer",
  "Chief Security Officer",
  "Executive Director",
  "Deputy Director",
  "Director",
  "Assistant Director",
  "Senior Administrator",
  "Administrator",
];

const staffAccessRoleNames = addEsPrefix([
  ...leadershipRoleNames,
  "Head Manager",
  "General Manager",
  "Operations Manager",
  "Development Manager",
  "Security Manager",
  "Community Manager",
  "Project Manager",
  "Department Manager",
  "Assistant Manager",
  "Senior Management",
  "Management",
  "Management Team",
  "Community Director",
  "Senior Moderator",
  "Moderator",
  "Trial Moderator",
  "Senior Support",
  "Support Staff",
  "Community Staff",
  "Community Team",
  "Helper",
  "Verified Staff",
  "Bot Owner",
  "Bot Manager",
  "Retired",
  "Former Staff",
]);

const developerAccessRoleNames = addEsPrefix([
  ...leadershipRoleNames,
  "Head Manager",
  "General Manager",
  "Development Manager",
  "Project Manager",
  "Head Developer",
  "Lead Developer",
  "Senior Developer",
  "Developer",
  "Junior Developer",
  "Bot Developer",
  "Discord Developer",
  "Systems Developer",
  "Backend Developer",
  "Frontend Developer",
  "Web Developer",
  "Database Developer",
  "API Developer",
  "Integration Developer",
  "Automation Developer",
  "Minecraft Developer",
  "Game Developer",
  "Developer Team",
  "Verified Developer",
  "Bot Owner",
  "Bot Manager",
  "Bot Tester",
  "Contributor",
  "Project Lead",
  "Project Team",
]);

const securityAccessRoleNames = addEsPrefix([
  ...leadershipRoleNames,
  "Security Manager",
  "Chief Security",
  "Security Director",
  "Head of Security",
  "Lead Security",
  "Senior Security",
  "Security Administrator",
  "Security Specialist",
  "Security Analyst",
  "Security Officer",
  "Security Agent",
  "Security Staff",
  "Security Team",
  "Verified Security",
  "Bot Owner",
  "Bot Manager",
]);

const blacklistAccessRoleNames = addEsPrefix([
  ...securityAccessRoleNames.map((name) => name.replace("[ES] ", "")),
  "Global Blacklist Director",
  "Global Blacklist Manager",
  "Global Blacklist Administrator",
  "Global Blacklist Staff",
  "Global Blacklist Investigator",
  "Global Blacklist Reviewer",
  "Global Blacklist Auditor",
  "Global Blacklist Appeals",
  "Blacklist Enforcement",
  "Blacklist Team",
]);

const privateCategoryRoleNames: Readonly<Record<string, readonly string[]>> = {
  "[ES] Staff": staffAccessRoleNames,
  "[ES] Development": developerAccessRoleNames,
  "[ES] Development Team": developerAccessRoleNames,
  "[ES] Security": securityAccessRoleNames,
  "[ES] Security Team": securityAccessRoleNames,
  "[ES] Global Blacklist": blacklistAccessRoleNames,
};

const setupChannels: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("setup-organzie-chann")
    .setDescription("Create and organize the ES server channels")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)
    ) {
      await interaction.reply({
        content: "You need the Manage Channels permission to run this command.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const botMember = await guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.editReply(
        "I need the Manage Channels permission before I can create this layout.",
      );
      return;
    }

    const createdCategoryNames: string[] = [];
    const reusedCategoryNames: string[] = [];
    const createdChannelNames: string[] = [];
    const reusedChannelNames: string[] = [];
    const usedChannelIds = new Set<string>();
    const categories: import("discord.js").CategoryChannel[] = [];

    try {
      await guild.channels.fetch();

      for (const group of setupChannelGroups) {
        let category = guild.channels.cache.find(
          (channel) =>
            channel.type === ChannelType.GuildCategory &&
            channel.name === group.name,
        ) as import("discord.js").CategoryChannel | undefined;

        if (category) {
          reusedCategoryNames.push(group.name);
        } else {
          category = await guild.channels.create({
            name: group.name,
            type: ChannelType.GuildCategory,
            reason: "Creating the ES server channel layout",
          });
          createdCategoryNames.push(group.name);
        }
        categories.push(category);

        for (const channelConfig of group.channels) {
          let channel = guild.channels.cache.find(
            (candidate) =>
              !candidate.isThread() &&
              candidate.type === channelConfig.type &&
              candidate.name === channelConfig.name &&
              candidate.parentId === category.id &&
              !usedChannelIds.has(candidate.id),
          );

          if (!channel) {
            channel = guild.channels.cache.find(
              (candidate) =>
                !candidate.isThread() &&
                candidate.type === channelConfig.type &&
                candidate.name === channelConfig.name &&
                !usedChannelIds.has(candidate.id),
            );

            if (channel && channel.parentId !== category.id) {
              await (channel as import("discord.js").GuildChannel).setParent(
                category.id,
                {
                lockPermissions: false,
                },
              );
            }
          }

          if (channel) {
            usedChannelIds.add(channel.id);
            reusedChannelNames.push(channelConfig.name);
            continue;
          }

          const createdChannel = await guild.channels.create({
            name: channelConfig.name,
            type: channelConfig.type,
            parent: category.id,
            reason: "Creating the ES server channel layout",
          });
          usedChannelIds.add(createdChannel.id);
          createdChannelNames.push(channelConfig.name);
        }
      }

      const categoriesByName = new Map(
        categories.map((category) => [category.name, category]),
      );
      const orderedCategories = setupCategoryOrder
        .map((name) => categoriesByName.get(name))
        .filter(
          (category): category is import("discord.js").CategoryChannel =>
            category !== undefined,
        );

      const missingAccessRoles = Array.from(
        new Set(Object.values(privateCategoryRoleNames).flat()),
      ).filter(
        (name) =>
          !guild.roles.cache.some(
            (role) => role.name === name && !role.managed,
          ),
      );

      if (missingAccessRoles.length > 0) {
        await interaction.editReply(
          `The channel layout is ready, but I did not apply private-channel access because these roles are missing: ${missingAccessRoles
            .slice(0, 8)
            .join(", ")}${missingAccessRoles.length > 8 ? `, and ${missingAccessRoles.length - 8} more` : ""}. Run /setup-roles first, then run /setup-organzie-chann again.`,
        );
        return;
      }

      for (const [categoryName, accessRoleNames] of Object.entries(
        privateCategoryRoleNames,
      )) {
        const category = categoriesByName.get(categoryName);
        if (!category) continue;

        const accessRoles = accessRoleNames
          .map((name) =>
            guild.roles.cache.find(
              (role) => role.name === name && !role.managed,
            ),
          )
          .filter(
            (role): role is import("discord.js").Role =>
              role !== undefined,
          );

        await category.permissionOverwrites.set(
          [
            {
              id: guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: botMember.roles.highest.id,
              allow: [PermissionFlagsBits.ViewChannel],
            },
            ...accessRoles.map((role) => ({
              id: role.id,
              allow: [PermissionFlagsBits.ViewChannel],
            })),
          ],
          "Applying ES staff and team channel access",
        );

        const childChannels = guild.channels.cache.filter(
          (channel) =>
            channel.parentId === category.id && !channel.isThread(),
        );
        await Promise.all(
          childChannels.map((channel) =>
            (channel as import("discord.js").GuildChannel).lockPermissions(),
          ),
        );
      }

      await guild.channels.setPositions(
        orderedCategories.map((category, index) => ({
          channel: category.id,
          position: index,
        })),
      );

      await interaction.editReply(
        `ES channel organization complete.\nCategories created: ${createdCategoryNames.length}\nCategories reused: ${reusedCategoryNames.length}\nChannels created: ${createdChannelNames.length}\nChannels reused: ${reusedChannelNames.length}\n\nCommunity is above the VC category, staff/team categories are at the bottom, and private staff, developer, security, and blacklist areas now use their matching ES roles. Run /setup-organzie-chann again safely anytime.`,
      );
    } catch (err) {
      await interaction.editReply(
        "I couldn't finish setting up the ES channels. Make sure I have Manage Channels and that the channel/category names are allowed in this server.",
      );
    }
  },
};

const setupRoleColors = new Map<
  string,
  import("discord.js").ColorResolvable
>();

function addRoleColorGroup(
  names: readonly string[],
  colors: readonly import("discord.js").ColorResolvable[],
): void {
  names.forEach((name, index) => {
    setupRoleColors.set(`[ES] ${name}`, colors[index % colors.length]);
  });
}

addRoleColorGroup(
  [
    "Founder",
    "Owner",
    "Co-Owner",
    "Executive Owner",
    "Assistant Executive Owner",
    "Chief Executive Officer",
    "Chief Operations Officer",
    "Chief Technology Officer",
    "Chief Security Officer",
    "Executive Director",
    "Deputy Director",
    "Director",
    "Assistant Director",
    "Senior Administrator",
    "Administrator",
  ],
  [
    "#F59E0B",
    "#EAB308",
    "#D97706",
    "#B45309",
    "#92400E",
    "#7C3AED",
    "#6D28D9",
    "#5B21B6",
    "#4C1D95",
    "#4338CA",
    "#4F46E5",
    "#6366F1",
    "#818CF8",
    "#A78BFA",
    "#C4B5FD",
  ],
);

addRoleColorGroup(
  [
    "Head Manager",
    "General Manager",
    "Operations Manager",
    "Development Manager",
    "Security Manager",
    "Community Manager",
    "Project Manager",
    "Department Manager",
    "Assistant Manager",
    "Senior Management",
    "Management",
    "Management Team",
  ],
  [
    "#0F766E",
    "#0D9488",
    "#14B8A6",
    "#0891B2",
    "#0284C7",
    "#0369A1",
    "#2563EB",
    "#4F46E5",
    "#64748B",
    "#475569",
    "#334155",
    "#1E293B",
  ],
);

addRoleColorGroup(
  [
    "Head Developer",
    "Lead Developer",
    "Senior Developer",
    "Developer",
    "Junior Developer",
    "Bot Developer",
    "Discord Developer",
    "Systems Developer",
    "Backend Developer",
    "Frontend Developer",
    "Web Developer",
    "Database Developer",
    "API Developer",
    "Integration Developer",
    "Automation Developer",
    "Minecraft Developer",
    "Game Developer",
    "Developer Team",
  ],
  [
    "#06B6D4",
    "#0891B2",
    "#0284C7",
    "#2563EB",
    "#4F46E5",
    "#6366F1",
    "#7C3AED",
    "#8B5CF6",
    "#6D28D9",
    "#5B21B6",
    "#4338CA",
    "#3730A3",
    "#1D4ED8",
    "#0369A1",
    "#0E7490",
    "#155E75",
    "#164E63",
    "#1E3A8A",
  ],
);

addRoleColorGroup(
  [
    "Chief Security",
    "Security Director",
    "Head of Security",
    "Lead Security",
    "Senior Security",
    "Security Administrator",
    "Security Manager",
    "Security Specialist",
    "Security Analyst",
    "Security Officer",
    "Security Agent",
    "Security Staff",
    "Security Team",
  ],
  [
    "#EF4444",
    "#DC2626",
    "#B91C1C",
    "#F97316",
    "#EA580C",
    "#C2410C",
    "#E11D48",
    "#BE123C",
    "#9F1239",
    "#991B1B",
    "#7F1D1D",
    "#475569",
    "#334155",
  ],
);

addRoleColorGroup(
  [
    "Global Blacklist Director",
    "Global Blacklist Manager",
    "Global Blacklist Administrator",
    "Global Blacklist Staff",
    "Global Blacklist Investigator",
    "Global Blacklist Reviewer",
    "Global Blacklist Auditor",
    "Global Blacklist Appeals",
    "Blacklist Enforcement",
    "Blacklist Team",
  ],
  [
    "#7F1D1D",
    "#991B1B",
    "#B91C1C",
    "#DC2626",
    "#E11D48",
    "#BE123C",
    "#9F1239",
    "#881337",
    "#701A75",
    "#4C1D95",
  ],
);

addRoleColorGroup(
  [
    "Head of QA",
    "QA Director",
    "QA Manager",
    "Lead Tester",
    "Senior Tester",
    "Tester",
    "Beta Tester",
    "Alpha Tester",
    "Bug Hunter",
    "Bug Reporter",
    "Quality Assurance",
    "Testing Team",
  ],
  [
    "#8B5CF6",
    "#7C3AED",
    "#6D28D9",
    "#6366F1",
    "#4F46E5",
    "#4338CA",
    "#3730A3",
    "#312E81",
    "#A855F7",
    "#C026D3",
    "#DB2777",
    "#EC4899",
  ],
);

addRoleColorGroup(
  [
    "Incident Commander",
    "Incident Director",
    "Incident Manager",
    "Response Manager",
    "Response Team",
    "Threat Analyst",
    "Threat Investigator",
    "Investigation Staff",
    "Incident Response",
  ],
  [
    "#F97316",
    "#EA580C",
    "#C2410C",
    "#DC2626",
    "#B91C1C",
    "#D97706",
    "#CA8A04",
    "#A16207",
    "#92400E",
  ],
);

addRoleColorGroup(
  [
    "Community Director",
    "Community Manager",
    "Senior Moderator",
    "Moderator",
    "Trial Moderator",
    "Senior Support",
    "Support Staff",
    "Community Staff",
    "Community Team",
    "Helper",
  ],
  [
    "#14B8A6",
    "#0D9488",
    "#0F766E",
    "#059669",
    "#10B981",
    "#22C55E",
    "#16A34A",
    "#15803D",
    "#047857",
    "#065F46",
  ],
);

addRoleColorGroup(
  [
    "Minecraft Director",
    "Minecraft Manager",
    "Minecraft Administrator",
    "Minecraft Developer",
    "Minecraft Engineer",
    "Minecraft Moderator",
    "Minecraft Tester",
    "Minecraft Builder",
    "Minecraft Support",
    "Minecraft Team",
  ],
  [
    "#22C55E",
    "#16A34A",
    "#15803D",
    "#166534",
    "#84CC16",
    "#65A30D",
    "#4D7C0F",
    "#A16207",
    "#CA8A04",
    "#EAB308",
  ],
);

addRoleColorGroup(
  [
    "Media Director",
    "Media Manager",
    "Content Director",
    "Content Creator",
    "Graphic Designer",
    "Video Editor",
    "Social Media Manager",
    "Media Team",
  ],
  [
    "#EC4899",
    "#DB2777",
    "#BE185D",
    "#C026D3",
    "#A21CAF",
    "#9333EA",
    "#7C3AED",
    "#F43F5E",
  ],
);

addRoleColorGroup(
  [
    "Partnership Director",
    "Partnership Manager",
    "Partnership Representative",
    "Relations Manager",
    "Public Relations",
    "Partner",
    "Partner Team",
  ],
  [
    "#3B82F6",
    "#2563EB",
    "#1D4ED8",
    "#1E40AF",
    "#0EA5E9",
    "#0284C7",
    "#0369A1",
  ],
);

addRoleColorGroup(
  [
    "ESN Bot",
    "Security Bot",
    "Global Blacklist Bot",
    "Moderation Bot",
    "Protection Bot",
    "Minecraft Bot",
    "Development Bot",
    "Testing Bot",
    "Utility Bot",
  ],
  [
    "#475569",
    "#64748B",
    "#0F766E",
    "#0891B2",
    "#4F46E5",
    "#7C3AED",
    "#A855F7",
    "#DB2777",
    "#E11D48",
  ],
);

addRoleColorGroup(
  [
    "Verified Developer",
    "Verified Security",
    "Verified Staff",
    "Bot Owner",
    "Bot Manager",
    "Bot Tester",
    "Contributor",
    "Project Lead",
    "Project Team",
    "Early Access",
    "Sneak Peek",
    "VIP",
    "Booster",
    "Retired",
    "Former Staff",
    "Member",
  ],
  [
    "#22D3EE",
    "#38BDF8",
    "#60A5FA",
    "#F59E0B",
    "#D97706",
    "#A78BFA",
    "#8B5CF6",
    "#6366F1",
    "#4F46E5",
    "#F472B6",
    "#EC4899",
    "#EAB308",
    "#FBBF24",
    "#94A3B8",
    "#64748B",
    "#CBD5E1",
  ],
);

const fallbackRoleColors: readonly import("discord.js").ColorResolvable[] = [
  "#64748B",
  "#475569",
  "#0F766E",
  "#2563EB",
  "#7C3AED",
  "#DB2777",
  "#D97706",
];
setupRoleNames.forEach((name, index) => {
  if (!setupRoleColors.has(name)) {
    setupRoleColors.set(name, fallbackRoleColors[index % fallbackRoleColors.length]);
  }
});

const setupRolesColor: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("setup-roles-color")
    .setDescription("Apply a polished color palette to all ES roles")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)
    ) {
      await interaction.reply({
        content: "You need the Manage Roles permission to run this command.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const botMember = await guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply(
        "I need the Manage Roles permission before I can color these roles.",
      );
      return;
    }

    try {
      await guild.roles.fetch();
      const refreshedBotMember = await guild.members.fetchMe();
      const botHighestPosition = refreshedBotMember.roles.highest.position;
      const missingNames: string[] = [];
      const skippedNames: string[] = [];
      const failedNames: string[] = [];
      let coloredCount = 0;
      let unchangedCount = 0;

      for (const name of setupRoleNames) {
        const role = guild.roles.cache.find(
          (candidate) => candidate.name === name && !candidate.managed,
        );
        if (!role) {
          missingNames.push(name);
          continue;
        }

        if (role.position >= botHighestPosition) {
          skippedNames.push(name);
          continue;
        }

        const color = setupRoleColors.get(name) ?? "#64748B";
        if (role.hexColor.toUpperCase() === color) {
          unchangedCount += 1;
          continue;
        }

        try {
          await role.setColor(color, "Applying the ES role color palette");
          coloredCount += 1;
        } catch {
          failedNames.push(name);
        }
      }

      const formatNames = (names: string[]) =>
        names.length > 0
          ? `\n${names.slice(0, 5).join(", ")}${names.length > 5 ? `, and ${names.length - 5} more` : ""}`
          : "";

      await interaction.editReply(
        `ES role colors applied.\nColored: ${coloredCount}\nAlready matching: ${unchangedCount}\nMissing: ${missingNames.length}${formatNames(missingNames)}\nSkipped or below my role: ${skippedNames.length}${formatNames(skippedNames)}\nFailed: ${failedNames.length}${formatNames(failedNames)}\n\nThe palette uses coordinated gold, blue, teal, violet, green, rose, and security-red tones. Run /setup-roles first if any roles are missing.`,
      );
    } catch {
      await interaction.editReply(
        "I couldn't apply the ES role colors. Make sure I have Manage Roles and that my bot role is above the ES roles.",
      );
    }
  },
};

const rolePerms: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("role-perms")
    .setDescription("Give the ES roles their permissions and display settings")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.guild.ownerId !== interaction.user.id) {
      await interaction.reply({
        content: "Only the server owner can apply the ES role permissions.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const botMember = await guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply(
        "I need the Manage Roles permission before I can update these roles.",
      );
      return;
    }

    try {
      await guild.roles.fetch();
      const botHighestPosition = botMember.roles.highest.position;
      const missingNames: string[] = [];
      const skippedNames: string[] = [];
      const failedNames: string[] = [];
      let displayedCount = 0;
      let unchangedDisplayedCount = 0;
      const administratorUpdatedNames: string[] = [];
      const administratorUnchangedNames: string[] = [];

      for (const name of setupRoleNames) {
        const role = guild.roles.cache.find(
          (candidate) => candidate.name === name && !candidate.managed,
        );

        if (!role) {
          missingNames.push(name);
          continue;
        }

        if (role.position >= botHighestPosition) {
          skippedNames.push(name);
          continue;
        }

        try {
          if (role.hoist) {
            unchangedDisplayedCount += 1;
          } else {
            await role.setHoist(
              true,
              "Displaying ES role members separately in the member list",
            );
            displayedCount += 1;
          }

          if (administratorRoleNames.has(name)) {
            if (role.permissions.has(PermissionFlagsBits.Administrator)) {
              administratorUnchangedNames.push(name);
            } else {
              await role.setPermissions(
                PermissionFlagsBits.Administrator,
                "Granting Administrator to the ES owner and founder leadership role",
              );
              administratorUpdatedNames.push(name);
            }
          }
        } catch {
          failedNames.push(name);
        }
      }

      const formatNames = (names: string[]) =>
        names.length > 0
          ? `\n${names.slice(0, 6).join(", ")}${names.length > 6 ? `, and ${names.length - 6} more` : ""}`
          : "";

      await interaction.editReply(
        `ES role permissions applied.\nOwner/founder roles newly granted Administrator: ${administratorUpdatedNames.length}${formatNames(administratorUpdatedNames)}\nOwner/founder roles already had Administrator: ${administratorUnchangedNames.length}${formatNames(administratorUnchangedNames)}\nRoles newly displayed separately: ${displayedCount}\nRoles already displayed separately: ${unchangedDisplayedCount}\nMissing: ${missingNames.length}${formatNames(missingNames)}\nSkipped or below my role: ${skippedNames.length}${formatNames(skippedNames)}\nFailed: ${failedNames.length}${formatNames(failedNames)}\n\nRun /setup-roles first if the ES roles are missing. The bot role must be above the ES roles.`,
      );
    } catch {
      await interaction.editReply(
        "I couldn't update the ES role permissions. Make sure I have Manage Roles and that my bot role is above the ES roles.",
      );
    }
  },
};

const deleteAllChannels: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("deleteall-channels")
    .setDescription("Permanently delete every channel in this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption((option) =>
      option
        .setName("confirm")
        .setDescription("Required confirmation that every channel will be deleted")
        .setRequired(true),
    ),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.guild.ownerId !== interaction.user.id) {
      await interaction.reply({
        content: "Only the server owner can permanently delete all channels.",
        ephemeral: true,
      });
      return;
    }

    if (!interaction.options.getBoolean("confirm", true)) {
      await interaction.reply({
        content:
          "Nothing was deleted. Run `/deleteall-channels confirm:true` only if you want to permanently delete every channel in this server.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const botMember = await guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.editReply(
        "I need the Manage Channels permission before I can delete channels.",
      );
      return;
    }

    try {
      const fetchedChannels = await guild.channels.fetch();
      const channels = Array.from(fetchedChannels.values()).filter(
        (channel): channel is NonNullable<typeof channel> =>
          channel !== null && !channel.isThread(),
      );

      channels.sort((first, second) => {
        const firstIsCategory = first.type === ChannelType.GuildCategory;
        const secondIsCategory = second.type === ChannelType.GuildCategory;
        return Number(firstIsCategory) - Number(secondIsCategory);
      });

      let deletedCount = 0;
      const failedNames: string[] = [];

      for (const channel of channels) {
        try {
          await channel.delete("Server owner requested deletion of all channels");
          deletedCount += 1;
        } catch {
          failedNames.push(channel.name);
        }
      }

      if (failedNames.length > 0) {
        await interaction.editReply(
          `Deleted ${deletedCount} channel(s). I could not delete ${failedNames.length}: ${failedNames
            .slice(0, 8)
            .join(", ")}${failedNames.length > 8 ? `, and ${failedNames.length - 8} more` : ""}.`,
        );
        return;
      }

      await interaction.editReply(
        `Deleted all ${deletedCount} channel(s) in **${guild.name}**.`,
      );
    } catch {
      await interaction.editReply(
        "I couldn't fetch or delete the server channels. Make sure I have Manage Channels.",
      );
    }
  },
};

const setupRoles: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("setup-roles")
    .setDescription("Create and order all ES server roles")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  execute: async (interaction) => {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)
    ) {
      await interaction.reply({
        content: "You need the Manage Roles permission to run this command.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const botMember = await guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply(
        "I need the Manage Roles permission before I can create these roles.",
      );
      return;
    }

    const createdNames: string[] = [];
    const reusedNames: string[] = [];
    const rolesByName = new Map<
      string,
      import("discord.js").Role
    >();

    try {
      for (const name of setupRoleNames) {
        const existingRole = guild.roles.cache.find(
          (role) => role.name === name && !role.managed,
        );

        if (existingRole) {
          rolesByName.set(name, existingRole);
          reusedNames.push(name);
          continue;
        }

        const createdRole = await guild.roles.create({
          name,
          reason: "Creating the ES role hierarchy",
        });
        rolesByName.set(name, createdRole);
        createdNames.push(name);
      }

      await guild.roles.fetch();
      const refreshedBotMember = await guild.members.fetchMe();
      const botHighestPosition = refreshedBotMember.roles.highest.position;
      const rolesHighToLow = setupRoleNames
        .map((name) => rolesByName.get(name))
        .filter((role): role is import("discord.js").Role => role !== undefined);

      const unmanageableRoles = rolesHighToLow.filter(
        (role) => role.position >= botHighestPosition,
      );
      if (unmanageableRoles.length > 0) {
        await interaction.editReply(
          `I created/reused the roles, but I cannot order them because these roles are at or above my highest role: ${unmanageableRoles
            .map((role) => role.name)
            .join(", ")}. Move my bot role above the ES roles and run /setup-roles again.`,
        );
        return;
      }

      const topPosition = botHighestPosition - 1;
      const bottomPosition = topPosition - rolesHighToLow.length + 1;
      if (bottomPosition < 1) {
        await interaction.editReply(
          "I cannot fit the complete ES hierarchy below my bot role. Move my bot role higher and run /setup-roles again.",
        );
        return;
      }

      await guild.roles.setPositions(
        rolesHighToLow.map((role, index) => ({
          role: role.id,
          position: topPosition - index,
        })),
      );

      await interaction.editReply(
        `ES role setup complete.\nCreated: ${createdNames.length}\nReused: ${reusedNames.length}\nTotal unique ES roles: ${rolesHighToLow.length}\n\nOrder confirmed from highest to lowest: ${rolesHighToLow[0]?.name} → ${rolesHighToLow[rolesHighToLow.length - 1]?.name}\n\nRun it again safely anytime — existing roles are reused and missing roles are created.`,
      );
    } catch (err) {
      await interaction.editReply(
        "I couldn't finish setting up the ES roles. Make sure I have Manage Roles and that my bot role is above the roles I need to arrange.",
      );
    }
  },
};

export const commands: BotCommand[] = [
  ping,
  say,
  uptime,
  purge,
  ban,
  kick,
  addrole,
  removerole,
  join,
  leave,
  play,
  stop,
  skip,
  queueCommand,
  nowPlayingCommand,
  volume,
  loop,
  shuffle,
  remove,
  clearQueue,
  pause,
  resume,
  seek,
  lyrics,
  eightBall,
  poll,
  remind,
  warn,
  timeout,
  modlogs,
  modstats,
  serverinfo,
  userinfo,
  roleinfo,
  afk,
  tempban,
  mute,
  unmute,
  blacklist,
  setupChannels,
  setupRolesColor,
  rolePerms,
  deleteAllChannels,
  setupRoles,
];
