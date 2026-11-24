# Server Mirror Bot

A Discord bot that keeps a **preview server** in step with a **main server**.
It copies everything that exists when it starts, then mirrors every change as it
happens — channels, roles, permissions, emojis, server settings and messages.

The same bot is also a moderation bot and a levelling bot for the main server:
`/ban`, `/kick`, `/timeout`, `/warn`, `/purge`, `/lock` and friends, plus XP,
`/rank`, `/leaderboard`, level-up messages and role rewards. Mirroring needs no
commands — the two servers come from `.env` — but the rest is done with slash
commands, which the bot registers in the main server when it starts.

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
   ENABLE_MESSAGE_CONTENT=true          # mirroring messages (on by default)
   CLIENT_SECRET=                       # optional: enables #join-server
   PUBLIC_URLS=https://45tapl8dqb.apps.bot-hosting.cloud,https://limey-discord.apps.bot-hosting.cloud
   MOD_LOG_CHANNEL_ID=                  # optional: where moderation cases are posted
   CASES_FILE=data/moderation.json      # optional: where warnings are stored
   XP_MIN_PER_MESSAGE=15                # optional: levelling rates
   XP_MAX_PER_MESSAGE=25
   XP_COOLDOWN_SECONDS=60
   COUNTING_FILE=data/counting.json     # optional: counting channel state
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

Messages are mirrored by default. Message text is a privileged intent, so the
Portal side has to be on:

1. Developer Portal → your app → *Bot* → *Privileged Gateway Intents* → enable
   **Message Content**.
2. Restart. If you cannot enable that intent, set
   `ENABLE_MESSAGE_CONTENT=false` and the bot mirrors only the structure.

On startup the bot prints `Message mirroring: on/off (ENABLE_MESSAGE_CONTENT=…)`
with the raw value it actually read. If that says `off` while the Portal toggle is
on, the variable isn't reaching the process: set it in your host's environment
page as well as `.env` (the file is only read from the folder the bot starts in),
then restart. Quoted values like `ENABLE_MESSAGE_CONTENT="true"` are understood,
as are `on`, `yes`, `1` and `enabled`.

New messages are reposted in the matching target channel through a `Server
mirror` webhook, so they keep the author's name, avatar, attachments and embeds.
Messages from other bots and webhook posts are copied too (a bot's embed-only
post is forwarded as the embed); only Discord's own system notes are skipped.
Edits and deletions are replayed onto the mirrored copy. Mentions are sent inert (no
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

## Moderation

The bot registers these in the **main** server on startup (no separate script),
and they only work there — the preview is read-only and staff actions belong on
the real server:

| Command | What it does | Needs |
| --- | --- | --- |
| `/ban member [reason] [delete_days]` | Bans, optionally wiping up to 7 days of their messages | Ban Members |
| `/unban user_id [reason]` | Lifts a ban by user ID | Ban Members |
| `/kick member [reason]` | Kicks | Kick Members |
| `/timeout member duration [reason]` | Times someone out (`10m`, `2h`, `1d`, max 28d) | Moderate Members |
| `/untimeout member [reason]` | Ends a timeout early | Moderate Members |
| `/warn member reason` | Adds a warning to their record | Moderate Members |
| `/warnings member` | Lists their warnings | Moderate Members |
| `/clearwarnings member` | Deletes their warnings | Moderate Members |
| `/case id` | Shows one case | Moderate Members |
| `/purge amount [member]` | Deletes up to 100 recent messages (not older than 14 days) | Manage Messages |
| `/slowmode seconds [channel]` | Sets slowmode, `0` turns it off | Manage Channels |
| `/lock [channel] [reason]` | Stops `@everyone` talking in a channel | Manage Channels |
| `/unlock [channel] [reason]` | Undoes a lock | Manage Channels |
| `/create-invite [user_id]` | Creates a single-use invite to the **preview** server, optionally for one person only | Create Invite |
| `/remove-invite code` | Deletes an invite to the **preview** server (code or full link) | Create Invite |
| `/block-join user_id reason` | Stops someone using the preview's join button, with a reason they're shown | Moderate Members |
| `/unblock-join user_id` | Lifts that block | Moderate Members |
| `/blocked-joins` | Lists who is blocked and why | Moderate Members |

Replies are private to the moderator. Ban, kick, timeout, warn and the rest are
stored as numbered cases in `CASES_FILE` (`data/moderation.json` by default), so
warnings and case numbers survive restarts. Each case is also posted as an embed
to `MOD_LOG_CHANNEL_ID`, or to a channel named `#mod-logs` if that exists — no
log channel is required.

### `/create-invite`

Creates an invite to the **preview** server (never the main one) that stops
working after the first join, expires after 7 days, and lands people in
`#join-server` (or `#rules`/`#welcome`/the first text channel).

With `user_id`, the invite is tied to that person: if they join, it works and is
spent. If anyone else joins with it, the bot kicks them and deletes the invite.
Discord doesn't say which invite a member used, so the bot compares invite use
counts before and after each join — which is why the preview's invites have to
be readable by the bot (*Manage Server* there). Pending personal invites are
kept in `INVITES_FILE` (`data/invites.json`), so they still work after a restart.

This needs the privileged **Server Members** intent, or the bot never hears
about joins:

1. Developer Portal → your app → *Bot* → *Privileged Gateway Intents* → enable
   **Server Members**.
2. Keep `ENABLE_MEMBER_INTENTS=true` (the default) and restart.

The bot also needs **Kick Members** in the preview for the wrong-person case.

Removing an invite by hand in Discord leaves the bot's record behind, which can
turn the next unrelated join into a false kick. Use `/remove-invite <code>`
instead: it deletes the invite in the preview *and* forgets the record, so a
pending personal invite is cleaned up without that risk.

### Blocking someone from joining

`/block-join` keeps a person in the preview but stops them moving to the real
server with the `#join-server` button. The block is checked **before** the bot
adds anyone to the main server, and the person sees the reason on the page after
they approve the Discord prompt:

> You're blocked from joining Main from the preview. Reason: raiding the preview

`/unblock-join` lets them in again, and `/blocked-joins` lists every block with
its reason. Blocks are stored in `JOIN_BLOCKS_FILE` (`data/join-blocks.json`), so
restarting the bot doesn't clear them, and each block is logged as a case like
any other moderation action.

The bot checks rank before acting: it won't let you moderate yourself, the server
owner, or someone whose top role is equal to or above yours, and it says so when
its own role is too low to act.

Two permissions in the Developer Portal matter here: the invite link needs the
`applications.commands` scope (the default bot invite includes it), and the bot
needs *Moderate Members* in addition to the mirroring permissions above.

## Levels

Members earn XP for chatting in the **main** server. Every message is worth
15–25 XP at most once every 60 seconds per member; both are configurable with
`XP_MIN_PER_MESSAGE`, `XP_MAX_PER_MESSAGE` and `XP_COOLDOWN_SECONDS`. Bots,
webhook posts and DMs never earn XP, and the preview server never does either.

Level `n` needs `5n² + 50n + 100` more XP than level `n − 1`, so level 1 is 155
XP, level 2 is 375 total, level 3 is 660 total, and so on. XP, message counts,
role rewards and channel settings are stored in `LEVELS_FILE`
(`data/levels.json`), so ranks and cooldowns survive restarts.

| Command | What it does | Needs |
| --- | --- | --- |
| `/rank [member] [public]` | Level, total XP, messages and server rank — private unless `public` is set | — |
| `/leaderboard [page]` | The top 10 members by XP, 10 per page | — |
| `/level-settings` | The rates, no-XP channels, announce channel and role rewards | Manage Server |
| `/level-toggle [enabled]` | Turns XP gain on or off; levels are kept | Manage Server |
| `/level-announce [channel]` | Where level-up messages go — leave the channel empty to turn them off | Manage Server |
| `/no-xp-channel channel` | Toggles a channel between giving and not giving XP | Manage Server |
| `/level-role level [role]` | Hands out a role at that level — leave the role empty to remove the reward | Manage Server |
| `/level-rewards` | Lists every role reward | Manage Server |
| `/level-xp member amount` | Adds XP, or takes it away with a negative amount | Manage Server |
| `/set-level member level` | Puts someone at an exact level | Manage Server |
| `/reset-xp member` | Wipes someone's XP and message count | Manage Server |

When someone levels up the bot posts `🎉 @member reached **level N**!` in the
channel they were talking in — or in the announce channel, if one is set — and
pings only that member. Role rewards are additive: reaching a level gives the
role, and lower-level rewards stay put. Staff XP changes apply role rewards
immediately and are logged as cases like any other staff action. The bot needs
*Send Messages* where it announces and *Manage Roles* (with its role above the
reward roles) to hand them out.

## Counting

`/counting-setup channel:#counting` turns one channel into a group counting
game. People take turns posting the next number: after **7** comes **8**, and
nobody may post twice in a row. Every correct number gets a ✅ reaction.

A wrong number — or the same person twice in a row — gets a ❌ and a short
notice saying what the next number was, then the chain starts again at **1**.
The best number ever reached is kept, so neither a reset nor a restart loses it.
Messages that aren't a plain number are left alone, and bots and webhooks never
count.

| Command | What it does | Needs |
| --- | --- | --- |
| `/counting-setup channel` | Picks the channel and starts at 1 (switching channels starts over) | Manage Server |
| `/counting-disable` | Stops the game and keeps the record | Manage Server |
| `/counting-reset` | Starts again at 1, keeping the record | Manage Server |
| `/counting-stats` | Current number, next number, best and the last counter | — |

State lives in `COUNTING_FILE` (`data/counting.json`), so the chain survives a
restart. The bot needs *Add Reactions* and *Send Messages* in that channel, and
counting reads message text, so it only works while message mirroring is on.

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
| Message sent, edited, deleted (people, bots, webhooks) | Reposted with text, files and embeds, then edited and deleted through the webhook |

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
npm test      # node:test suite for mirroring, moderation, invites, join flow and levelling
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
src/lib/moderation.js  moderation commands, rank checks and case logging
src/lib/levels.js      XP curve, per-member XP and level settings store
src/lib/levelcommands.js  /rank, /leaderboard and the level settings commands
src/lib/invites.js     single-use preview invites and the wrong-person kick
src/lib/joinblocks.js  people blocked from the preview -> main join flow
src/lib/cases.js       JSON-backed case/warning store
src/lib/duration.js    timeout duration parsing and formatting
src/lib/messages.js    message splitting and webhook helpers
src/lib/errors.js      user-facing errors and helpers
```

The bot needs Node.js 20.18 or newer.
