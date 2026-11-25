import { EmbedBuilder } from "discord.js";
import { ageFromDateOfBirth } from "./users.js";

const COLOR = 0xeb459e;
const DELETED_COLOR = 0x95a5a6;
const MAX_THREAD_NAME = 100;
const REASON = "User database";

/** The record card, shared by /user-info and the forum post. */
export function userRecordEmbed(record, { authorName = null } = {}) {
  const age = ageFromDateOfBirth(record.dateOfBirth);
  const roles = Array.isArray(record.roles) ? record.roles : [];

  return new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: authorName ?? record.username })
    .setTitle("User record")
    .addFields(
      { name: "First name", value: record.firstName, inline: true },
      { name: "Last name", value: record.lastName, inline: true },
      { name: "Username", value: record.username, inline: true },
      { name: "Email", value: record.email, inline: true },
      {
        name: "Date of birth",
        value: age === null ? record.dateOfBirth : `${record.dateOfBirth} (age ${age})`,
        inline: true,
      },
      { name: "Class", value: record.class, inline: true },
      { name: "Gender", value: record.gender, inline: true },
      { name: "Discord", value: record.userId ? `<@${record.userId}>` : "Not assigned", inline: true },
      {
        name: "Roles",
        value: roles.length ? roles.map((role) => `\`${role}\``).join(", ") : "None",
      },
    )
    .setFooter({ text: `Last updated ${record.updatedAt?.slice(0, 10) ?? "unknown"}` });
}

/** Forum post titles stop at 100 characters, so long names are shortened. */
export function forumThreadName(record) {
  const name = `${record.firstName} ${record.lastName} (${record.username})`;
  return name.length > MAX_THREAD_NAME ? `${name.slice(0, MAX_THREAD_NAME - 1)}…` : name;
}

function deletedEmbed(record) {
  return new EmbedBuilder()
    .setColor(DELETED_COLOR)
    .setTitle("Record deleted")
    .setDescription(
      `**${record.firstName} ${record.lastName}** (\`${record.username}\`) is no longer in the database.`,
    )
    .setFooter({ text: `Deleted ${new Date().toISOString().slice(0, 10)}` });
}

/**
 * One forum channel holds one post per record. Creating a record opens the post;
 * editing the record renames it and rewrites the card; deleting the record turns
 * the card into a notice and archives the post, so nothing is lost.
 */
export function createUserForum({ channelId = null, reason = REASON } = {}) {
  const warned = new Set();

  async function channelFor(guild) {
    if (!channelId || !guild) return null;
    const cached = guild.channels?.cache?.get?.(channelId) ?? null;
    if (cached) return cached;
    if (typeof guild.channels?.fetch !== "function") return null;
    return (await guild.channels.fetch(channelId).catch(() => null)) ?? null;
  }

  async function threadFor(guild, threadId) {
    if (!threadId || !guild) return null;
    const cached = guild.channels?.cache?.get?.(threadId) ?? null;
    if (cached) return cached;
    if (typeof guild.channels?.fetch !== "function") return null;
    return (await guild.channels.fetch(threadId).catch(() => null)) ?? null;
  }

  async function starterMessage(thread) {
    if (typeof thread?.fetchStarterMessage === "function") {
      const message = await thread.fetchStarterMessage().catch(() => null);
      if (message) return message;
    }
    if (typeof thread?.messages?.fetch === "function") {
      return (await thread.messages.fetch(thread.id).catch(() => null)) ?? null;
    }
    return null;
  }

  return {
    channelId,

    /** Post or update the record's forum thread. Returns the thread id. */
    async sync(record, guild) {
      if (!record) return null;

      const forum = await channelFor(guild);
      if (!forum || typeof forum.threads?.create !== "function") {
        if (!warned.has(channelId)) {
          warned.add(channelId);
          console.warn(
            `The user forum (${channelId ?? "no channel set"}) was not found, or is not a forum ` +
              "channel the bot can post in — records are kept in the database only.",
          );
        }
        return null;
      }

      const existing = await threadFor(guild, record.forumThreadId);
      if (existing) {
        const wanted = forumThreadName(record);
        if (existing.name !== wanted && typeof existing.setName === "function") {
          await existing
            .setName(wanted, reason)
            .catch((error) => console.error("Could not rename a user forum post:", error.message));
        }

        const message = await starterMessage(existing);
        if (typeof message?.edit === "function") {
          await message
            .edit({ embeds: [userRecordEmbed(record)] })
            .catch((error) => console.error("Could not update a user forum post:", error.message));
        }
        return existing.id;
      }

      const thread = await forum.threads.create({
        name: forumThreadName(record),
        message: { embeds: [userRecordEmbed(record)] },
        reason,
      });
      return thread?.id ?? null;
    },

    /** Mark the post as deleted, then lock and archive it. */
    async retire(record, guild) {
      const thread = await threadFor(guild, record?.forumThreadId);
      if (!thread) return null;

      const message = await starterMessage(thread);
      if (typeof message?.edit === "function") {
        await message
          .edit({ embeds: [deletedEmbed(record)] })
          .catch((error) => console.error("Could not update a deleted user post:", error.message));
      }

      if (typeof thread.setLocked === "function") {
        await thread
          .setLocked(true, reason)
          .catch((error) => console.error("Could not lock a user forum post:", error.message));
      }
      if (typeof thread.setArchived === "function") {
        await thread
          .setArchived(true, reason)
          .catch((error) => console.error("Could not archive a user forum post:", error.message));
      }
      return thread.id;
    },
  };
}

/**
 * Keep the forum post of one record in step with the stored record, remembering
 * the thread id. Never throws: a forum problem must not fail the command.
 */
export async function syncUserPost({ forum, users, guild, record }) {
  if (!forum || !guild || !record) return null;

  let threadId = null;
  try {
    threadId = await forum.sync(record, guild);
  } catch (error) {
    console.error(`Could not post ${record.username} in the user forum:`, error.message);
    return null;
  }
  if (!threadId) return null;

  if (threadId !== record.forumThreadId && typeof users?.setMeta === "function") {
    users.setMeta({ guildId: guild.id, recordId: record.id, meta: { forumThreadId: threadId } });
  }
  return threadId;
}

/** Close the forum post of a deleted record. Never throws. */
export async function retireUserPost({ forum, guild, record }) {
  if (!forum || !guild || !record) return null;
  try {
    return await forum.retire(record, guild);
  } catch (error) {
    console.error(`Could not archive the user forum post of ${record.username}:`, error.message);
    return null;
  }
}

/** Post every stored record that has no forum post yet (runs once on startup). */
export async function syncExistingUserPosts({ forum, users, guild }) {
  if (!forum || !users || !guild) return 0;

  const waiting = users.all(guild.id).filter((record) => !record.forumThreadId);
  let posted = 0;
  for (const record of waiting) {
    if (await syncUserPost({ forum, users, guild, record })) posted += 1;
  }
  return posted;
}
