# Server Preview Bot

A Discord bot that copies one server's layout into another, so you can build a
"preview" server, see how a redesign looks, and only then touch the real one.

Two commands:

| Command | What it does |
| --- | --- |
| `/preview source target` | Reads both servers and shows the exact plan — every role, category, channel, emoji and setting that would be created or reused. Changes **nothing**. |
| `/clone source target [messages] [settings]` | Executes that plan in the target server: creates roles, categories, channels, permission overwrites, emojis, and optionally replays recent messages and copies server settings. |

Both commands take server IDs through autocomplete (the bot lists every server
it is in). You run them **inside the target server**, so the person using them is
someone with access to that server.

## How it works

1. The source and target servers are read into plain snapshots
   (`src/lib/snapshot.js`): roles with hierarchy and permissions, channels with
   parents, topics, slowmode, bitrate and permission overwrites, emojis and
   server settings.
2. `src/lib/planner.js` diffs them. Roles and channels that already exist in the
   target (matched by name, and by type for channels) are **reused and updated**
   instead of duplicated; everything else is marked for creation. Roles owned by
   bots/integrations can't be recreated, so their permission overwrites are
   dropped with a warning.
3. `src/lib/builder.js` applies the plan step by step, with per-step error
   handling, so one failed channel doesn't abort the run. Progress is streamed
   into the command reply.

Because the plan is a separate, pure step, `/preview` and `/clone` can never
disagree.

## Setup

1. **Create the application** at <https://discord.com/developers/applications> →
   *New Application* → *Bot* → *Reset Token*.
2. **Invite the bot to both servers** (source and target) with these permissions:
   *View Channels*, *Manage Channels*, *Manage Roles*, *Manage Expressions*
   (emojis), *Manage Webhooks* (only needed for message copying) and
   *Manage Server* (only needed if you copy settings).
   Give it *Administrator* if you just want it to work.
3. **Copy the config**:

   ```bash
   cp .env.example .env
   # paste DISCORD_TOKEN, and optionally GUILD_ID
   ```

4. **Install and start**:

   ```bash
   npm install
   npm start
   ```

   `npm start` registers the slash commands and then logs the bot in — there is
   no separate registration step, and no `CLIENT_ID` to copy. Global commands can
   take up to an hour to appear the first time; set `GUILD_ID` to one of your
   servers to register them there instantly while testing.

### Copying messages (optional)

Message content is a privileged intent:

1. Developer Portal → your app → *Bot* → *Privileged Gateway Intents* →
   enable **Message Content**.
2. Set `ENABLE_MESSAGE_CONTENT=true` in `.env` and restart.

Then `/clone ... messages:25` replays the last 25 messages of each text channel
through a temporary webhook, keeping each author's display name and avatar.
Mentions are sent inert (no pings), and messages with no text and no attachments
are skipped. Without the intent, `/clone` still copies the structure.

## What is and isn't copied

Copied:

- Roles: name, colour, hoist, mentionable, permissions, and hierarchy order
  (as far as the bot's own top role allows).
- Categories, text, announcement, voice, stage, forum and media channels:
  name, parent, position, topic, NSFW flag, slowmode, bitrate, user limit,
  auto-archive and forum tags.
- Permission overwrites for roles and for members who exist in the target.
- Emojis (up to the target's free slots, 256 KB max).
- Server name, icon, AFK channel/timeout, system channel, verification level,
  explicit content filter and default notifications (toggle with `settings`).
- Recent messages per text channel, if you ask for them.

Not copied: members themselves, invites, bans, webhooks, bots, integrations,
threads and their history, stickers, soundboard sounds, boosts, audit log,
auto-moderation rules, onboarding, scheduled events, or role/channel IDs
(nothing is linked between the two servers).

The bot never deletes anything in the target. Extra roles or channels that exist
there but not in the source are left alone.

## Re-running

Every run is idempotent-ish: roles and channels are matched by name and updated
in place, so running `/clone` again after changing the source converges the
target instead of duplicating it. Rename a channel in the source and the old one
stays in the target — the bot can't know it was meant to be the same channel.

## Development

```bash
npm test        # node:test suite for the snapshot reader, planner, executor and renderer
npm run dev     # restart on file changes
npm run register  # re-register the commands without starting the bot
```

Layout:

```
src/index.js           client, intents, command registration, interaction handling
src/commands.js        /preview and /clone definitions + handlers
src/lib/snapshot.js    live guild -> plain snapshot
src/lib/planner.js     snapshot diff -> plan (pure)
src/lib/builder.js     plan -> Discord API calls, with progress + error reporting
src/lib/messages.js    webhook message replay
src/lib/render.js      embeds for preview, progress and results
```

The bot needs Node.js 20.18 or newer.
