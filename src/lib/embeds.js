import { EmbedBuilder } from "discord.js";
import { normalizeReputation } from "./reputation.js";
import { ageFromDateOfBirth } from "./users.js";

/**
 * Every embed the bot posts carries this tag in its footer. That is what tells a
 * new-style embed from an old one, so /migrate-embeds can rewrite the old ones
 * once and leave the new ones alone on every later run.
 */
export const STYLE_TAG = "Mirror Bot v2";
export const STYLE_VERSION = 2;

export const COLORS = {
  record: 0xeb459e,
  rank: 0x5865f2,
  counting: 0x57f287,
  case: 0x5865f2,
  neutral: 0x95a5a6,
  join: 0x5865f2,
};

/** "Last updated 2026-11-28 • Mirror Bot v2" — blank details keep just the tag. */
export function styleFooter(text = "") {
  const details = String(text ?? "")
    .replace(/\s*\|\s*/g, " — ")
    .trim();
  if (!details) return STYLE_TAG;
  return details.includes(STYLE_TAG) ? details : `${details} • ${STYLE_TAG}`;
}

export function isStyledEmbed(embed) {
  const data = embed?.data ?? embed ?? {};
  const footer = String(data.footer?.text ?? "");
  return footer.endsWith(STYLE_TAG);
}

/**
 * The shared look: the kind's accent colour, a footer tagged with the style
 * version, and a timestamp when the data has one.
 */
export function styledEmbed({
  colour = COLORS.rank,
  title = null,
  description = null,
  fields = [],
  author = null,
  footer = "",
  timestamp = null,
} = {}) {
  const embed = new EmbedBuilder().setColor(colour).setFooter({ text: styleFooter(footer) });

  if (title) embed.setTitle(String(title).slice(0, 256));
  if (description) embed.setDescription(String(description).slice(0, 4096));
  if (fields.length > 0) embed.setFields(fields);
  if (author) embed.setAuthor({ name: String(author).slice(0, 256) });

  if (timestamp) {
    const date = timestamp === true ? new Date() : new Date(timestamp);
    if (!Number.isNaN(date.getTime())) embed.setTimestamp(date);
  }

  return embed;
}

const inline = (name, value) => ({ name, value: value || "—", inline: true });
const block = (name, value) => ({ name, value: value || "—", inline: false });

/** A member's database record, shown by /user-info and in their forum post. */
export function userRecordCard(record, { authorName = null } = {}) {
  const birthday = record.dateOfBirth || null;
  const age = birthday ? ageFromDateOfBirth(birthday) : null;
  const roles = Array.isArray(record.roles) ? record.roles : [];
  // Reputation is stored on the record, next to the rest of it.
  const score = normalizeReputation(record.reputation);

  const name = `${record.firstName ?? ""} ${record.lastName ?? ""}`.trim() || "Unnamed record";

  return styledEmbed({
    colour: COLORS.record,
    author: authorName ?? record.username,
    title: `👤 ${name}`,
    description: `\`${record.username ?? "unknown"}\``,
    fields: [
      inline("Email", record.email),
      inline(
        "Date of birth",
        birthday ? (age === null ? birthday : `${birthday} (age ${age})`) : "Not set",
      ),
      inline("Discord", record.userId ? `<@${record.userId}>` : "Not assigned"),
      inline("Class", record.class),
      inline("Gender", record.gender),
      inline("Reputation", `${score} ⭐`),
      block("Roles", roles.length ? roles.map((role) => `\`${role}\``).join(", ") : "None"),
    ],
    footer: `Last updated ${record.updatedAt?.slice?.(0, 10) ?? "unknown"}`,
    timestamp: record.updatedAt ?? null,
  });
}

export function deletedRecordCard(record) {
  return styledEmbed({
    colour: COLORS.neutral,
    title: "🗑️ Record deleted",
    description:
      `**${record?.firstName ?? "Someone"} ${record?.lastName ?? ""}** ` +
      `(\`${record?.username ?? "unknown"}\`) is no longer in the database.`.replace(/\s+/g, " "),
    footer: `Deleted ${new Date().toISOString().slice(0, 10)}`,
    timestamp: true,
  });
}

/** /rank */
export function rankCard({ name, level, rank, xp, messages, progress, footer = "" }) {
  return styledEmbed({
    colour: COLORS.rank,
    author: name,
    title: `📈 Level ${level}`,
    description: progress || null,
    fields: [
      inline("Rank", rank),
      inline("Total XP", xp),
      inline("Messages", messages),
    ],
    footer,
  });
}

/** /leaderboard */
export function leaderboardCard({ page, pages, lines, footer = "" }) {
  return styledEmbed({
    colour: COLORS.rank,
    title: `🏆 Leaderboard — page ${page}/${pages}`,
    description: lines,
    footer,
  });
}

/** /level-settings, /counting-stats and anything else built from fields. */
export function panelCard({ title, colour = COLORS.rank, description = null, fields = [], footer = "" }) {
  return styledEmbed({ colour, title, description, fields, footer });
}

/** One moderation case in #mod-logs. */
export function caseCard({ record, colour = COLORS.case }) {
  const target = record.targetId
    ? `<@${record.targetId}>`
    : record.channelId
      ? `<#${record.channelId}>`
      : "—";

  return styledEmbed({
    colour,
    title: `🛡️ Case #${record.id} — ${record.type}`,
    fields: [
      inline("Target", target),
      inline("Moderator", record.moderatorId ? `<@${record.moderatorId}>` : "—"),
      block("Reason", record.reason || "No reason given"),
    ],
    footer: `Case #${record.id}`,
    timestamp: record.at ?? true,
  });
}

/** The pinned card in #join-server. */
export function joinCard({ sourceName }) {
  return styledEmbed({
    colour: COLORS.join,
    title: `🚪 Join ${sourceName}`,
    description:
      `This server is a read-only preview of **${sourceName}**.\n\n` +
      "Click the button below and approve the Discord prompt. " +
      "I'll add you to the real server and remove you from this preview automatically.",
    footer: "You only need to do this once",
  });
}

/* ------------------------------------------------------------------ *
 * Migration: rewrite the embeds posted before the style above existed.
 * Every converter reads the old embed's own data, so nothing is guessed
 * from a stored message body.
 * ------------------------------------------------------------------ */

const lower = (value) => String(value ?? "").trim().toLowerCase();
const fieldMap = (data) =>
  new Map(
    (data.fields ?? [])
      .filter((field) => field && field.name != null)
      .map((field) => [lower(field.name), String(field.value ?? "")]),
  );

function oldUserRecord(data) {
  const fields = fieldMap(data);
  const roles = (fields.get("roles") ?? "").replace(/`/g, "").trim();
  const birthday = /^\d{4}-\d{2}-\d{2}/.exec(fields.get("date of birth") ?? "")?.[0] ?? null;
  const discord = /<@!?(\d+)>/.exec(fields.get("discord") ?? "")?.[1] ?? null;

  return userRecordCard(
    {
      firstName: fields.get("first name") ?? "Unknown",
      lastName: fields.get("last name") ?? "",
      username: fields.get("username") ?? data.author?.name ?? "unknown",
      email: fields.get("email") ?? "—",
      dateOfBirth: birthday,
      class: fields.get("class") ?? "—",
      gender: fields.get("gender") ?? "—",
      userId: discord,
      roles: roles && lower(roles) !== "none" ? roles.split(/\s*,\s*/).filter(Boolean) : [],
      updatedAt: null,
    },
    { authorName: data.author?.name ?? null },
  );
}

function oldRank(data) {
  const fields = fieldMap(data);
  const level = /level\s+(\d+)/i.exec(data.title ?? "")?.[1] ?? "0";
  const progress =
    [...(data.fields ?? [])].find((field) => lower(field.name).startsWith("progress"))?.value ?? null;

  return rankCard({
    name: data.author?.name ?? null,
    level,
    rank: fields.get("rank") ?? "Unranked",
    xp: fields.get("total xp") ?? "0",
    messages: fields.get("messages") ?? "0",
    progress,
    footer: data.footer?.text ?? "",
  });
}

function oldLeaderboard(data) {
  const [, page, pages] = /page\s+(\d+)\s*\/\s*(\d+)/i.exec(data.title ?? "") ?? [];
  return leaderboardCard({
    page: page ?? "1",
    pages: pages ?? "1",
    lines: data.description ?? "Nobody is ranked yet.",
    footer: data.footer?.text ?? "",
  });
}

function oldPanel(data, { title, colour }) {
  return panelCard({
    title,
    colour,
    description: data.description ?? null,
    fields: data.fields ?? [],
    footer: data.footer?.text ?? "",
  });
}

/**
 * The old embeds the bot itself posted, and how each becomes a new one. Anything
 * that matches none of these (another bot's embeds, or a mirrored message from a
 * person) is left exactly as it is.
 */
export const EMBED_CONVERTERS = [
  {
    kind: "user-record",
    detect: (data) => lower(data.title) === "user record",
    build: oldUserRecord,
  },
  {
    kind: "deleted-record",
    detect: (data) => lower(data.title) === "record deleted",
    build: (data) =>
      styledEmbed({
        colour: COLORS.neutral,
        title: "🗑️ Record deleted",
        description: data.description ?? null,
        footer: data.footer?.text ?? "",
      }),
  },
  {
    kind: "case",
    detect: (data) => /^case #\d+\s*—/i.test(data.title ?? ""),
    build: (data) =>
      styledEmbed({
        colour: data.color ?? COLORS.case,
        title: `🛡️ ${data.title}`,
        fields: data.fields ?? [],
        footer: data.footer?.text ?? "",
        timestamp: data.timestamp ?? null,
      }),
  },
  {
    kind: "leaderboard",
    detect: (data) => /^leaderboard\s*—\s*page/i.test(data.title ?? ""),
    build: oldLeaderboard,
  },
  {
    kind: "rank",
    detect: (data) => /^level \d+$/i.test(data.title ?? "") && fieldMap(data).has("total xp"),
    build: oldRank,
  },
  {
    kind: "level-settings",
    detect: (data) => lower(data.title) === "level settings",
    build: (data) => oldPanel(data, { title: "⚙️ Level settings", colour: COLORS.rank }),
  },
  {
    kind: "counting",
    detect: (data) => lower(data.title) === "counting",
    build: (data) => oldPanel(data, { title: "🔢 Counting", colour: COLORS.counting }),
  },
  {
    kind: "join",
    detect: (data) =>
      /^join\s+/i.test(data.title ?? "") && /read-only preview/i.test(data.description ?? ""),
    build: (data) =>
      styledEmbed({
        colour: COLORS.join,
        title: `🚪 ${data.title}`,
        description: data.description ?? null,
        footer: data.footer?.text ?? "",
      }),
  },
];

/** One embed -> its new-style replacement, or null when it isn't one of ours. */
export function restyleEmbed(embed) {
  const data = embed?.data ?? embed ?? {};
  if (!data || typeof data !== "object") return { embed: null, kind: null };
  if (isStyledEmbed(data)) return { embed: null, kind: "current" };

  const converter = EMBED_CONVERTERS.find((candidate) => candidate.detect(data));
  if (!converter) return { embed: null, kind: null };

  return { embed: converter.build(data), kind: converter.kind };
}

/** A message's whole embed list -> the new list, plus what changed. */
export function restyleEmbeds(embeds = []) {
  const next = [];
  const kinds = [];
  let converted = 0;
  let current = 0;
  let unknown = 0;

  for (const embed of embeds) {
    const result = restyleEmbed(embed);
    if (result.kind === "current") {
      current += 1;
      next.push(embed);
    } else if (result.embed) {
      converted += 1;
      kinds.push(result.kind);
      next.push(result.embed);
    } else {
      unknown += 1;
      next.push(embed);
    }
  }

  return { embeds: next, converted, current, unknown, kinds, changed: converted > 0 };
}
