import { EmbedBuilder } from "discord.js";

const CHANNEL_ICONS = {
  text: "#",
  announcement: "📣",
  voice: "🔊",
  stage: "🎙️",
  forum: "💬",
  media: "🖼️",
};

const COLORS = {
  preview: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  error: 0xed4245,
};

export function truncate(text, max = 1024) {
  const value = String(text ?? "");
  if (value.length <= max) return value || "—";
  return `${value.slice(0, max - 1)}…`;
}

function clean(name) {
  return name.replace(/`/g, "'");
}

/** A compact tree of what will exist in the target server after replication. */
export function buildChannelTree(plan, { maxLines = 38 } = {}) {
  const childrenOf = new Map();
  for (const channel of plan.channels) {
    const key = channel.parentSourceId ?? "__root__";
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(channel);
  }

  const rootChannels = childrenOf.get("__root__") ?? [];
  const total =
    plan.categories.length +
    plan.channels.length +
    (plan.categories.length && rootChannels.length ? 1 : 0);
  const lines = [];
  const push = (line) => {
    if (lines.length < maxLines) lines.push(line);
  };

  for (const category of plan.categories) {
    push(`${category.action === "create" ? "+" : "="} ${clean(category.name)}`);
    for (const channel of childrenOf.get(category.sourceId) ?? []) {
      push(`   ${CHANNEL_ICONS[channel.type] ?? "•"} ${clean(channel.name)}${channel.action === "reuse" ? " (exists)" : ""}`);
    }
  }

  if (rootChannels.length) {
    if (plan.categories.length) push("— no category —");
    for (const channel of rootChannels) {
      push(`${CHANNEL_ICONS[channel.type] ?? "•"} ${clean(channel.name)}${channel.action === "reuse" ? " (exists)" : ""}`);
    }
  }

  if (total > maxLines) lines.push(`… and ${total - maxLines} more`);

  return lines.join("\n") || "No channels to copy.";
}

function warningsField(plan) {
  if (!plan.warnings.length) return [];
  return [
    {
      name: `⚠️ Notes (${plan.warnings.length})`,
      value: truncate(plan.warnings.map((warning) => `• ${warning}`).join("\n")),
    },
  ];
}

export function renderPreview(plan) {
  const { stats } = plan;
  const embed = new EmbedBuilder()
    .setColor(COLORS.preview)
    .setTitle(`Preview: ${truncate(plan.source.name, 60)} → ${truncate(plan.target.name, 60)}`)
    .setDescription(`\`\`\`\n${buildChannelTree(plan)}\n\`\`\``)
    .setFooter({ text: "Preview only — nothing was changed. Run /clone to apply it." });

  embed.addFields(
    {
      name: "Roles",
      value: truncate(
        `${stats.roles.create} to create · ${stats.roles.reuse} matching · ${stats.roles.skip} can't be copied`,
        1024,
      ),
      inline: true,
    },
    {
      name: "Channels",
      value: truncate(
        `${stats.categories.create + stats.channels.create} to create · ${
          stats.categories.reuse + stats.channels.reuse
        } matching`,
        1024,
      ),
      inline: true,
    },
    {
      name: "Emojis",
      value: truncate(`${stats.emojis.create} to create · ${stats.emojis.skip} already there`, 1024),
      inline: true,
    },
  );

  if (plan.settings.length) {
    const lines = plan.settings.map((setting) => {
      if (setting.from !== undefined && setting.from !== null) {
        return `• ${setting.label}: ${truncate(setting.from, 40)} → ${truncate(setting.value, 40)}`;
      }
      return `• ${setting.label}: ${truncate(setting.value, 40)}`;
    });
    embed.addFields({ name: `Server settings (${plan.settings.length})`, value: truncate(lines.join("\n")) });
  }

  if (stats.messages > 0) {
    embed.addFields({
      name: "Messages",
      value: truncate(`Up to ${stats.messages} recent message(s) will be replayed.`),
    });
  }

  embed.addFields(...warningsField(plan));
  return embed;
}

function renderList(title, items, max = 6) {
  if (!items.length) return null;
  const shown = items.slice(0, max).map((item) => `• ${item}`);
  if (items.length > max) shown.push(`… and ${items.length - max} more`);
  return { name: title, value: truncate(shown.join("\n")) };
}

export function renderResult(plan, report, { durationMs = 0 } = {}) {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const failed = report.errors.length > 0;

  const embed = new EmbedBuilder()
    .setColor(failed ? COLORS.warning : COLORS.success)
    .setTitle(`${failed ? "Replicated with errors" : "Replication complete"}: ${truncate(plan.source.name, 60)} → ${truncate(plan.target.name, 60)}`)
    .setURL(`https://discord.com/channels/${plan.target.id}`)
    .setFooter({ text: `${seconds}s · ${report.errors.length} error(s) · ${report.warnings.length} note(s)` });

  const created = [
    `${report.rolesCreated} role(s)`,
    `${report.channelsCreated} channel(s)`,
    report.emojisCreated ? `${report.emojisCreated} emoji(s)` : null,
    report.messagesCopied ? `${report.messagesCopied} message(s)` : null,
    report.settingsApplied ? `${report.settingsApplied} setting(s)` : null,
  ].filter(Boolean);

  const updated = [
    report.rolesUpdated ? `${report.rolesUpdated} role(s)` : null,
    report.channelsUpdated ? `${report.channelsUpdated} channel(s)` : null,
    report.rolesReused ? `${report.rolesReused} role(s) already matched` : null,
  ].filter(Boolean);

  if (created.length) embed.addFields({ name: "Created", value: truncate(created.join("\n")), inline: true });
  if (updated.length) embed.addFields({ name: "Updated", value: truncate(updated.join("\n")), inline: true });

  const skipped = renderList(`Skipped (${report.skipped.length})`, report.skipped);
  if (skipped) embed.addFields(skipped);

  const errors = renderList(`❌ Errors (${report.errors.length})`, report.errors);
  if (errors) embed.addFields({ ...errors, value: truncate(errors.value) });

  const warnings = renderList(`⚠️ Notes (${report.warnings.length})`, report.warnings, 8);
  if (warnings) embed.addFields(warnings);

  return embed;
}

export function renderProgress(done, total, label) {
  const size = 16;
  const filled = Math.round((done / Math.max(total, 1)) * size);
  const bar = `${"▰".repeat(filled)}${"▱".repeat(size - filled)}`;

  return new EmbedBuilder()
    .setColor(COLORS.preview)
    .setTitle("Replicating…")
    .setDescription(`\`${bar}\` ${done}/${total}\n${truncate(label, 180)}`);
}
