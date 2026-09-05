---
name: Discord bot as background service
description: How a Discord bot with slash commands was integrated into this workspace's api-server rather than as its own artifact.
---

Discord bots have no HTTP preview, so they don't fit the `createArtifact` model. Instead, run the bot as a background process started from the existing api-server's entry point (alongside `app.listen`), so it inherits the same always-on workflow instead of needing a new service/port.

**Why:** Artifacts require a preview path; a Discord gateway client has none. Piggybacking on an existing long-running Node process is the simplest way to get "stays online" behavior without inventing new infra.

**How to apply:** Add `discord.js` to the relevant server package, register slash commands via `REST.put(Routes.applicationCommands(clientId))` on bot ready, and call a `startDiscordBot()` function at the bottom of the server's `index.ts`. Requires `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_ID` secrets from the user (Bot page / General Information page at discord.com/developers/applications — non-technical users often don't know "Client ID" = "Application ID").

Note: Replit AI Integrations (OpenAI/Gemini) returned `awaiting_account_upgrade` for this user's account — free tier didn't unlock it. Fell back to asking for the user's own API key when AI features are needed; user may not have one and may decline to create one.
