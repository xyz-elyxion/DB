# Server Mirror Bot

A Discord bot that keeps a **preview server** in step with a **main server**.
It copies everything that exists when it starts, then mirrors every change as it
happens — channels, roles, permissions, emojis, server settings and messages.

There are no commands: the two servers are set in `.env`, and the bot runs
continuously.

## Setup

1. **Create the application** at <https://discord.com/developers/applications> →
   *New Application* → *Bot* → *Reset Token*.
2. **Invite the bot to both servers** (source and target) with *View Channels*,
   *Manage Channels*, *Manage Roles*, *Manage Expressions* (emojis),
   *Manage Webhooks* (messages) and *Manage Server* (settings) — or just give it
   *Administrator*.
3. **Configure it**:

   ```bash
   cp .env.example .env
   ```

   ```bash
   DISCORD_TOKEN=your-bot-token
   SOURCE_GUILD_ID=123456789012345678   # the "main" server
   TARGET_GUILD_ID=987654321098765432   # the preview server
   ENABLE_MESSAGE_CONTENT=false         # true to mirror messages too
   CLIENT_SECRET=                       # optional: enables #join-server
   PUBLIC_URLS=https://45tapl8dqb.apps.bot-hosting.cloud,https://limey-discord.apps.bot-hosting.cloud
   ```

4. **Run it**:

   ```bash
   npm install
   npm start
   ```

On startup it reconciles the two servers (creating anything missing and
updating anything that differs), prints a summary, and then mirrors changes
live. Server IDs are right-click → *Copy Server ID* with Developer Mode on.

### Mirroring messages

Message text is a privileged intent:

1. Developer Portal → your app → *Bot* → *Privileged Gateway Intents* → enable
   **Message Content**.
2. Set `ENABLE_MESSAGE_CONTENT=true` in `.env` and restart.

New messages are reposted in the matching target channel through a `Server
mirror` webhook, so they keep the author's name, avatar and attachments. Edits
and deletions are replayed onto the mirrored copy. Mentions are sent inert (no
pings) and messages are split at Discord's 2000-character limit. Without the
intent, the bot mirrors the server structure only.

## The preview server

The target is renamed **`<source name> Preview`** on startup, and again whenever
the source server is renamed, so nobody mistakes it for the real one.

Every channel and category there is **read-only**. The bot adds an `@everyone`
overwrite that keeps *View Channel* (and message history) but denies sending
messages, creating threads, adding reactions, speaking and requesting to speak.
The main server's own permissions are kept — only talking is taken away.
Webhook posts still work, so mirrored messages keep flowing.

### `#join-server`

The bot creates a read-only `#join-server` channel with an embed and a **Join
<source name>** button. Clicking it opens Discord's OAuth2 screen; once the
person approves, the bot adds them to the main server, kicks them out of the
preview, and shows them a "you're in" page.

To enable it:

1. Developer Portal → your app → *OAuth2* → **Redirects** → add one entry per
   domain, each ending in `/join/callback`:

   ```
   https://45tapl8dqb.apps.bot-hosting.cloud/join/callback
   https://limey-discord.apps.bot-hosting.cloud/join/callback
   ```

2. List the same domains in `.env`:

   ```bash
   PUBLIC_URLS=https://45tapl8dqb.apps.bot-hosting.cloud,https://limey-discord.apps.bot-hosting.cloud
   ```

   Each domain gets its own button in `#join-server` and its own OAuth `state`,
   so either one works for anyone. Separate them with commas or spaces — up to
   five. A single domain can also be given as `PUBLIC_URL`.
3. Developer Portal → *OAuth2* → copy the **Client Secret** into `.env` as
   `CLIENT_SECRET`.
4. Give the bot **Kick Members** in the preview server and **Create Instant
   Invite** in the main server.
5. Restart. Without `CLIENT_SECRET` the channel is not created and the bot says
   why in the console.

Every domain has to reach the bot's `SERVER_PORT` (default `3000`; plain `PORT`
is used as a fallback): the redirect listener runs inside the same process and
answers all of them. Point both
DNS/proxy hostnames at it rather than running two bots.

## What is mirrored

When it starts:

- Roles (name, colour, hoist, mentionable, permissions, order), categories,
  text/announcement/voice/stage/forum/media channels, permission overwrites,
  emojis, and server name, icon, AFK channel/timeout, system channel,
  verification level, content filter and default notifications.

While it runs:

| In the main server | In the preview server |
| --- | --- |
| Channel created, renamed, re-topic'd, re-ordered, moved between categories, permissions changed | Same channel created/updated in place |
| Channel deleted | The mirrored channel is deleted (categories take their children) |
| Role created, renamed, recoloured, permissions or position changed | Same role created/updated |
| Role deleted | The mirrored role is deleted |
| Emoji added, renamed, removed | Same emoji added/renamed/removed |
| Server name, icon, AFK/system channel, verification level, filter, notifications | Applied to the preview server |
| Message sent, edited, deleted | Reposted, edited and deleted through the webhook |

Matching is by name (and type for channels), so re-running and restarting are
safe: existing objects are updated rather than duplicated.

## What is not mirrored

Members and their roles, bans, invites, webhooks you created, bots and
integrations, threads and their history, stickers, soundboard sounds, boosts,
audit log, auto-moderation rules, onboarding and scheduled events. The
`#join-server` channel is the bot's own and is not copied from the source. Role and
channel IDs are never linked, so a rename in the main server is followed only
because the bot saw the event — renaming while the bot is offline leaves a
stale channel behind.

## Good to know

- The bot only ever changes the target server; it never deletes anything there
  that it did not create, except mirrored deletions (delete a channel in the
  main server and the mirrored one goes too).
- Channel and role matching is by name. If you have two channels with the same
  name in the same server, the one in the matching category is preferred.
- Deleting the `Server mirror` webhook is fine — the bot creates a new one.
- If the bot is in neither server (or the IDs are wrong) it says so on startup
  and exits.

## Development

```bash
npm test      # node:test suite for the snapshot reader, planner, executor, mirror and live sync
npm run dev   # restart on file changes
```

Layout:

```
src/index.js           startup reconcile + event wiring
src/config.js          .env parsing and validation
src/lib/snapshot.js    live guild -> plain snapshot
src/lib/planner.js     snapshot diff -> plan (pure)
src/lib/builder.js     plan -> Discord API calls (startup reconcile)
src/lib/live.js        change events -> target guild
src/lib/mirror.js      message mirroring through webhooks
src/lib/preview.js     preview name and read-only overwrites
src/lib/join.js        OAuth2 join flow, #join-server channel and embed
src/lib/messages.js    message splitting and webhook helpers
src/lib/errors.js      user-facing errors and helpers
```

The bot needs Node.js 20.18 or newer.
