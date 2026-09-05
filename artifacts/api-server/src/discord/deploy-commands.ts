import { REST, Routes } from "discord.js";
import { commands } from "./commands";
import { logger } from "../lib/logger";

export async function deployCommands(
  token: string,
  clientId: string,
  guildIds: readonly string[] = [],
) {
  const rest = new REST().setToken(token);
  const body = commands.map((command) => command.data.toJSON());

  logger.info(
    { count: body.length },
    "Registering Discord slash commands",
  );

  if (guildIds.length > 0) {
    await Promise.all(
      guildIds.map((guildId) =>
        rest.put(Routes.applicationGuildCommands(clientId, guildId), {
          body,
        }),
      ),
    );
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
  }

  logger.info(
    { guildCount: guildIds.length },
    "Discord slash commands registered globally and to joined servers",
  );
}
