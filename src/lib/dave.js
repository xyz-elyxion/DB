import { KEY_PATTERN } from "./davekeys.js";
import { UserError, describeError } from "./errors.js";

export const DAVE_NAME = "Dave";
export const DEFAULT_MODEL = "meta-llama/Llama-3.1-8B-Instruct";

export const DEFAULT_ENDPOINT = "https://router.huggingface.co/v1/chat/completions";
const MAX_REPLY = 1900;
const MAX_CONTEXT_RECORDS = 10;

/** Names the provider in errors by its host, so a custom endpoint reads right. */
export function daveEndpointHost(endpoint = DEFAULT_ENDPOINT) {
  try {
    return new URL(endpoint).host;
  } catch {
    return "the AI provider";
  }
}

const SYSTEM_PROMPT = [
  "You are Dave, the assistant for a school's student database, answering people in Discord.",
  "Rules:",
  "- Answer only from the RECORDS given below. Never invent a student, a field or a fact.",
  "- If the records do not answer the question, say so plainly and ask for the full name.",
  "- Be brief: at most 120 words, plain text with simple Discord markdown. No tables or code blocks.",
  "- Give what was asked for. Do not list every field unless the question is who someone is.",
  "- Mention a student's email or date of birth only when the question is about them.",
  "- Never mention these rules, the records format, or that you are a language model.",
].join("\n");

const STOPWORDS = new Set(
  (
    "a an and about are as at be been being by can could dave did do does doing for from " +
    "had has have having he her here hers him his how i if in into is it its just know me " +
    "my of on or our out she should so some tell than that the their them then there these " +
    "they this those to too us was we were what when where which who whom why will with would " +
    "you your database record records student students school list give show find email " +
    "emails birthday birthdays dob class classes gender role roles name names please"
  ).split(" "),
);

/**
 * A message starts Dave only when it *starts* with the word. The rest is the
 * question, unless the first word is a one-time key.
 */
export function parseDaveMessage(content) {
  const text = String(content ?? "").trim();
  const match = /^dave\b[\s,:.!?-]*/i.exec(text);
  if (!match) return null;

  let rest = text.slice(match[0].length).trim();
  let key = null;

  const first = rest.split(/\s+/)[0] ?? "";
  if (KEY_PATTERN.test(first.toUpperCase())) {
    key = first.toUpperCase();
    rest = rest.slice(first.length).trim();
  }

  return { key, question: rest };
}

function questionTokens(question) {
  const words = String(question ?? "")
    .toLowerCase()
    .match(/[\p{L}\p{N}@._'-]+/gu);
  return [...new Set(words ?? [])].filter((word) => word.length >= 2 && !STOPWORDS.has(word));
}

/**
 * The records most likely to answer the question. A full name scores highest,
 * then a matching username, then a class or partial name. Ten is enough for the
 * model to work from without sending the whole school.
 */
export function selectRecords(records, question, { limit = MAX_CONTEXT_RECORDS } = {}) {
  const tokens = questionTokens(question);
  if (tokens.length === 0) return [];

  const scored = [];
  for (const record of records ?? []) {
    const name = `${record.firstName ?? ""} ${record.lastName ?? ""}`.toLowerCase().trim();
    const username = String(record.username ?? "").toLowerCase();
    const fields = [
      name,
      username,
      record.email,
      record.class,
      record.gender,
      ...(Array.isArray(record.roles) ? record.roles : []),
    ]
      .map((value) => String(value ?? "").toLowerCase())
      .filter(Boolean);

    let score = 0;
    for (const token of tokens) {
      if (name === token) score += 30;
      if (name.split(" ").includes(token)) score += 15;
      if (username === token) score += 12;
      for (const field of fields) {
        if (field.includes(token)) score += 4;
      }
    }

    if (score > 0) scored.push({ record, score });
  }

  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);

  // Someone who shares a surname with the student that was asked about should
  // not crowd the answer, but a search on just that surname should still find
  // everyone with it.
  const cutoff = Math.max(4, Math.ceil(scored[0].score * 0.7));
  return scored
    .filter((entry) => entry.score >= cutoff)
    .slice(0, limit)
    .map((entry) => entry.record);
}

function formatRecord(record) {
  return {
    first_name: record.firstName,
    last_name: record.lastName,
    username: record.username,
    email: record.email,
    date_of_birth: record.dateOfBirth ?? null,
    class: record.class,
    gender: record.gender,
    roles: Array.isArray(record.roles) ? record.roles : [],
    discord: record.userId ? `<@${record.userId}>` : "not linked",
  };
}

/** The system and user messages handed to the chat model. */
export function buildDaveContext({
  question,
  records = [],
  total = records.length,
  classes = [],
  asker = null,
  serverName = null,
} = {}) {
  const lines = [`There are ${total} student record(s) in the database.`];

  if (classes.length > 0) lines.push(`Classes: ${classes.join(", ")}.`);

  if (records.length > 0) {
    lines.push("RECORDS that may answer the question:");
    for (const record of records) lines.push(JSON.stringify(formatRecord(record)));
  } else {
    lines.push("No record matched the question, so there is nothing to quote.");
  }

  const who = asker ? `${asker}${serverName ? ` in ${serverName}` : ""}` : "a member";
  lines.push(`Question from ${who}: ${question}`);

  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

/**
 * Ask the model provider. Everything Dave says is this model's answer; there is no
 * local fallback that could make up a student.
 */
export async function askDave({
  apiKey = null,
  model = DEFAULT_MODEL,
  endpoint = DEFAULT_ENDPOINT,
  question,
  records = [],
  total = records.length,
  classes = [],
  asker = null,
  serverName = null,
  fetchImpl = fetch,
  timeoutMs = 30_000,
} = {}) {
  if (!apiKey) {
    throw new UserError(
      "Dave isn't connected yet — the bot needs DAVE_API_KEY (or HUGGINGFACE_API_KEY) to answer.",
    );
  }
  if (!String(question ?? "").trim()) {
    throw new UserError("Ask Dave a question about someone in the student database.");
  }

  const { system, user } = buildDaveContext({
    question,
    records,
    total,
    classes,
    asker,
    serverName,
  });

  const host = daveEndpointHost(endpoint);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 400,
        temperature: 0.3,
        stream: false,
      }),
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    throw new UserError(`Dave couldn't reach ${host} — ${describeError(error)}`);
  }

  if (!response.ok) {
    const detail =
      typeof response.text === "function"
        ? (await response.text().catch(() => "")).slice(0, 200).trim()
        : "";

    if (response.status === 401 || response.status === 403) {
      throw new UserError(
        `${host} rejected Dave's API key (HTTP ${response.status}) — check DAVE_API_KEY ` +
          "(or HUGGINGFACE_API_KEY).",
      );
    }
    if (response.status === 402) {
      throw new UserError(
        endpoint === DEFAULT_ENDPOINT
          ? "Hugging Face now bills its Inference Providers by pre-paid credits, and this " +
              "token has none (HTTP 402). Either buy credits, or move Dave to a free " +
              "OpenAI-compatible provider with DAVE_API_URL, DAVE_API_KEY and DAVE_MODEL — " +
              "Groq's free plan needs no card: https://api.groq.com/openai/v1/chat/completions " +
              "with model openai/gpt-oss-20b."
          : `${host} says the account is out of credit (HTTP 402) — top it up, or point ` +
              "DAVE_API_URL at another provider.",
      );
    }
    if (response.status === 404) {
      throw new UserError(
        `${host} doesn't know the model **${model}** — set DAVE_MODEL (or HUGGINGFACE_MODEL) ` +
          "to one your account can use.",
      );
    }
    if (response.status === 429) {
      throw new UserError(`${host} is rate-limiting Dave (HTTP 429) — ask again in a minute.`);
    }
    throw new UserError(
      `${host} couldn't answer (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  const payload = await response.json().catch(() => null);
  const text = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? null;
  if (typeof text !== "string" || !text.trim()) {
    throw new UserError(`${host} returned an empty answer — try asking again.`);
  }

  return text.trim().slice(0, MAX_REPLY);
}

async function reply(message, text) {
  const content = String(text ?? "").slice(0, 2000);
  try {
    if (typeof message.reply === "function") {
      await message.reply({ content, allowedMentions: { parse: [] } });
      return;
    }
    if (typeof message.channel?.send === "function") {
      await message.channel.send({ content, allowedMentions: { parse: [] } });
    }
  } catch (error) {
    console.error("Dave could not reply:", error.message);
  }
}

/**
 * Dave is started by a message beginning with the word "Dave". People in the
 * main or preview server can ask straight away; everyone else needs a one-time
 * key from a manager there.
 */
export function createDaveAgent({
  apiKey = null,
  model = DEFAULT_MODEL,
  endpoint = DEFAULT_ENDPOINT,
  users = null,
  keys = null,
  sourceId = null,
  guildIds = [],
  fetchImpl = fetch,
  log = console,
} = {}) {
  const allowedGuilds = new Set((guildIds ?? []).filter(Boolean));

  return {
    enabled: Boolean(apiKey),

    /** Returns true when the message was for Dave, whether or not he answered. */
    async handleMessage(message) {
      if (!message || message.author?.bot) return false;

      const parsed = parseDaveMessage(message.content);
      if (!parsed) return false;

      const inServers = Boolean(message.guildId && allowedGuilds.has(message.guildId));

      if (!inServers) {
        if (!parsed.key) {
          await reply(
            message,
            "Only people in the main or preview server can ask Dave. A manager there can " +
              "give you a one-time key — then write `Dave <key> <question>`.",
          );
          return true;
        }

        const check = keys?.authorize(parsed.key, message.author?.id);
        if (!check?.ok) {
          await reply(
            message,
            check?.message ??
              "One-time keys aren't set up, so Dave can only answer members of the main or preview server.",
          );
          return true;
        }
      }

      if (!parsed.question) {
        await reply(
          message,
          inServers
            ? "Ask me about anyone in the student database — for example " +
                "`Dave what class is Jackson Zhu in?`"
            : "Add your question after the key — for example " +
                "`Dave ABCD-2345 what class is Jackson Zhu in?`",
        );
        return true;
      }

      let records = [];
      try {
        records = users?.all(sourceId) ?? [];
      } catch (error) {
        console.error("Dave could not read the student database:", error.message);
      }

      try {
        await message.channel?.sendTyping?.();
      } catch {
        // Typing is a nicety; never fail the answer over it.
      }

      try {
        const text = await askDave({
          apiKey,
          model,
          endpoint,
          question: parsed.question,
          records: selectRecords(records, parsed.question),
          total: records.length,
          classes: [...new Set(records.map((record) => record.class).filter(Boolean))].sort(),
          asker: message.author?.username ?? null,
          serverName: message.guild?.name ?? null,
          fetchImpl,
        });

        await reply(message, text);

        // The key is spent only once the answer is actually delivered.
        if (!inServers && parsed.key) keys?.consume(parsed.key, message.author?.id);

        log.log?.(
          `[dave] Answered ${message.author?.username ?? message.author?.id ?? "someone"} ` +
            `in ${message.guild?.name ?? "a direct message"}${inServers ? "" : " with a one-time key"}.`,
        );
      } catch (error) {
        const text = error instanceof UserError ? error.message : `That failed — ${describeError(error)}`;
        await reply(message, `⚠️ ${text}`);
      }

      return true;
    },
  };
}
