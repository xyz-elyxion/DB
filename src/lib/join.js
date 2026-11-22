import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  REST,
  Routes,
} from "discord.js";

import { UserError } from "./errors.js";

const API = "https://discord.com/api/v10";
export const JOIN_CHANNEL_NAME = "join-server";
const MAX_BUTTONS = 5;

/** The bot's own application ID, needed for the OAuth2 link. */
export async function resolveApplicationId(token) {
  const rest = new REST().setToken(token);
  const application = await rest.get(Routes.oauth2CurrentApplication());
  return application.id;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

function page(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#1e1f22;color:#f2f3f5;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:32rem;padding:2rem;background:#2b2d31;border-radius:12px;text-align:center}h1{font-size:1.4rem}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`;
}

function hostOf(redirectUri) {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

/**
 * OAuth2 "join the real server" flow:
 * authorise -> identify the user -> add them to the source guild with the
 * `guilds.join` scope -> hand them to `onJoined` (which removes them from the
 * preview server).
 *
 * Every redirect URI gets its own link and its own `state`, because Discord
 * requires the same `redirect_uri` on the authorize step and the token
 * exchange. That is what lets several public domains serve the same bot.
 */
export function createJoinFlow({
  applicationId,
  clientSecret,
  token,
  sourceId,
  redirectUris,
  onJoined,
  checkJoin = null,
}) {
  const uris = [...new Set(redirectUris ?? [])].filter(Boolean);
  if (uris.length === 0) throw new Error("no redirect URI configured");

  const redirectByState = new Map(); // state -> redirect URI

  function authorizeUrlFor(redirectUri) {
    const state = randomBytes(16).toString("hex");
    redirectByState.set(state, redirectUri);

    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", applicationId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "identify guilds.join");
    url.searchParams.set("state", state);
    return url.toString();
  }

  const authorizeUrls = uris.map((redirectUri) => ({
    redirectUri,
    host: hostOf(redirectUri),
    url: authorizeUrlFor(redirectUri),
  }));

  async function exchangeCode(code, redirectUri) {
    const body = new URLSearchParams({
      client_id: applicationId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetch(`${API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`token exchange failed (HTTP ${response.status})`);
    return response.json();
  }

  async function identify(accessToken) {
    const response = await fetch(`${API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`couldn't read the Discord profile (HTTP ${response.status})`);
    return response.json();
  }

  async function addToSource(userId, accessToken) {
    const response = await fetch(`${API}/guilds/${sourceId}/members/${userId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    // 201 means added, 204 means they were already there.
    if (response.status !== 204 && response.status !== 201) {
      throw new Error(`couldn't add the member to the server (HTTP ${response.status})`);
    }
  }

  async function complete({ code, state: received }) {
    const redirectUri = redirectByState.get(received);
    if (!redirectUri) throw new Error("the authorisation state didn't match any known link");

    const tokens = await exchangeCode(code, redirectUri);
    const user = await identify(tokens.access_token);

    // Blocks are checked before the bot adds anyone, so a blocked person never
    // gets into the real server at all.
    if (checkJoin) await checkJoin(user);

    await addToSource(user.id, tokens.access_token);
    await onJoined(user);
    return user;
  }

  return { authorizeUrls, complete };
}

/** Listen for the OAuth2 redirect. */
export function startJoinServer({ flow, port, path = "/join/callback" }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    const send = (status, html) => {
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    };

    if (url.pathname !== path) {
      send(404, page("Not found", "This address only handles the join redirect."));
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      send(400, page("Join cancelled", "Nothing changed. You can close this tab."));
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      send(400, page("Missing code", "Discord didn't send an authorisation code."));
      return;
    }

    try {
      const user = await flow.complete({ code, state: url.searchParams.get("state") });
      send(
        200,
        page(
          "You're in!",
          `Welcome to the real server, <strong>${escapeHtml(user.global_name ?? user.username)}</strong>. ` +
            "You can close this tab.",
        ),
      );
    } catch (failure) {
      if (failure instanceof UserError) {
        send(403, page("You can't join", escapeHtml(failure.message)));
        return;
      }

      console.error("Join flow failed:", failure.message);
      send(
        500,
        page(
          "That didn't work",
          "Something went wrong while joining. Ask a server admin to check the bot's console.",
        ),
      );
    }
  });

  server.listen(port, () => {
    console.log(`Join redirect listening on http://localhost:${port}${path}`);
  });

  return server;
}

/** Create (or update) the read-only #join-server channel with the buttons. */
export async function ensureJoinChannel({ guild, client, sourceName, links }) {
  const existing = [...guild.channels.cache.values()].find(
    (channel) => channel.name === JOIN_CHANNEL_NAME && channel.type === ChannelType.GuildText,
  );

  const channel =
    existing ??
    (await guild.channels.create({
      name: JOIN_CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: `Read-only preview of ${sourceName} — use the button to join the real server.`,
      reason: "Preview join channel",
    }));

  await channel.permissionOverwrites
    ?.edit?.(guild.roles?.everyone ?? guild.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      AddReactions: false,
      Speak: false,
    })
    .catch(() => {});

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Join ${sourceName}`)
    .setDescription(
      `This server is a read-only preview of **${sourceName}**.\n\n` +
        "Click the button below and approve the Discord prompt. " +
        "I'll add you to the real server and remove you from this preview automatically.",
    )
    .setFooter({ text: "You only need to do this once" });

  const buttons = links.slice(0, MAX_BUTTONS).map((link, index) =>
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(
        (index === 0 ? `Join ${sourceName}` : `Join via ${link.host ?? hostOf(link.redirectUri)}`)
          .slice(0, 80),
      )
      .setURL(link.url),
  );

  const payload = {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(...buttons)],
  };

  const messages = await channel.messages?.fetch?.({ limit: 50 }).catch(() => null);
  const posted = messages?.find?.(
    (message) => message.author?.id === client.user?.id && message.embeds.length > 0,
  );

  if (posted) await posted.edit(payload);
  else await channel.send(payload);

  return channel;
}
