import { PermissionFlagsBits } from "discord.js";

/** What a member of the preview keeps: they can look, not talk. */
export const READ_ONLY_ALLOW = PermissionFlagsBits.ViewChannel;
export const READ_ONLY_DENY =
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.CreatePublicThreads |
  PermissionFlagsBits.CreatePrivateThreads |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.Speak |
  PermissionFlagsBits.RequestToSpeak;

/** "My Server" -> "My Server Preview" (and never "… Preview Preview"). */
export function previewName(name) {
  const clean = (name ?? "").trim() || "Server";
  return /preview$/i.test(clean) ? clean : `${clean} Preview`;
}

/**
 * Add or extend the @everyone overwrite so nobody can post, react or talk.
 * The source's own @everyone overwrite is kept, just with the send bits denied.
 */
export function readOnlyOverwrites(overwrites, everyoneId) {
  let seen = false;

  const result = (overwrites ?? []).map((overwrite) => {
    if (overwrite.id !== everyoneId) return overwrite;
    seen = true;
    return {
      ...overwrite,
      allow: BigInt(overwrite.allow ?? 0n) | READ_ONLY_ALLOW,
      deny: BigInt(overwrite.deny ?? 0n) | READ_ONLY_DENY,
    };
  });

  if (!seen) {
    result.push({ id: everyoneId, allow: READ_ONLY_ALLOW, deny: READ_ONLY_DENY });
  }

  return result;
}
