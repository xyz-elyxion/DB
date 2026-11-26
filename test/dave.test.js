import test from "node:test";
import assert from "node:assert/strict";
import {
  askDave,
  buildDaveContext,
  createDaveAgent,
  parseDaveMessage,
  selectRecords,
} from "../src/lib/dave.js";
import { KEY_PATTERN, createDaveKey, createDaveKeyStore } from "../src/lib/davekeys.js";
import { UserError } from "../src/lib/errors.js";
import { createUserStore } from "../src/lib/users.js";

const RECORDS = [
  {
    firstName: "Jackson",
    lastName: "Zhu",
    email: "jackson.zhu@example.com",
    username: "jackson.zhu",
    dateOfBirth: "2013-01-21",
    class: "10A",
    gender: "Male",
    roles: ["Student"],
    userId: null,
  },
  {
    firstName: "Evangeline",
    lastName: "Chan",
    email: "evangeline.chan@example.com",
    username: "evangeline.chan",
    dateOfBirth: "2013-05-10",
    class: "9B",
    gender: "Female",
    roles: ["Student", "Prefect"],
    userId: "u2",
  },
  {
    firstName: "Borna",
    lastName: "Raei",
    email: "borna.raei@example.com",
    username: "borna.raei",
    dateOfBirth: null,
    class: "11A",
    gender: "Male",
    roles: [],
    userId: null,
  },
];

function huggingFaceReply(text, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return { choices: [{ message: { role: "assistant", content: text } }] };
    },
    async text() {
      return "";
    },
  };
}

function messageFor({
  content,
  guildId = "main",
  guildName = "Main Server",
  userId = "u1",
  username = "Ada",
  bot = false,
} = {}) {
  const replies = [];
  let typing = 0;

  return {
    content,
    guildId,
    guild: guildId ? { id: guildId, name: guildName } : null,
    author: { id: userId, username, bot },
    member: { id: userId },
    channel: {
      async sendTyping() {
        typing += 1;
      },
      async send(payload) {
        replies.push(payload.content ?? payload);
      },
    },
    async reply(payload) {
      replies.push(payload.content ?? payload);
      return {};
    },
    replies,
    typingCount: () => typing,
  };
}

const store = () => {
  const users = createUserStore({ guildId: "main" });
  for (const record of RECORDS) users.create({ guildId: "main", ...record });
  return users;
};

test("Dave only starts when the message starts with the word", () => {
  assert.deepEqual(parseDaveMessage("Dave what class is Jackson Zhu in?"), {
    key: null,
    question: "what class is Jackson Zhu in?",
  });
  assert.deepEqual(parseDaveMessage("  dave, who is Jackson?"), {
    key: null,
    question: "who is Jackson?",
  });
  assert.deepEqual(parseDaveMessage("Dave K7QM-3H2P who is Jackson?"), {
    key: "K7QM-3H2P",
    question: "who is Jackson?",
  });
  assert.deepEqual(parseDaveMessage("Dave"), { key: null, question: "" });

  assert.equal(parseDaveMessage("Hey Dave, who is Jackson?"), null);
  assert.equal(parseDaveMessage("Daves are the best"), null);
  assert.equal(parseDaveMessage(""), null);
});

test("keys are readable, unique and single use", () => {
  const keys = createDaveKeyStore();
  const key = createDaveKey();

  assert.match(key, KEY_PATTERN);
  assert.equal(new Set(Array.from({ length: 50 }, createDaveKey)).size, 50);

  const record = keys.create({ userId: "u9", createdBy: "mod", note: "Outside server" });
  assert.equal(record.userId, "u9");
  assert.equal(keys.count(), 1);

  const lowercase = record.key.toLowerCase();
  assert.equal(keys.authorize(lowercase, "u9").ok, true, "case does not matter");
  assert.equal(keys.authorize(record.key, "u8").ok, false, "issued to someone else");
  assert.match(keys.authorize(record.key, "u8").message, /someone else/);

  assert.equal(keys.count(), 1, "checking a key never spends it");
  assert.ok(keys.consume(record.key, "u9"));
  assert.equal(keys.count(), 0);

  const reused = keys.authorize(record.key, "u9");
  assert.equal(reused.ok, false);
  assert.match(reused.message, /already been used/);

  assert.equal(keys.authorize("ZZZZ-ZZZZ", "u9").ok, false);
  assert.throws(() => keys.create({}), UserError);
});

test("only the records that match the question are sent", () => {
  assert.deepEqual(
    selectRecords(RECORDS, "who is Jackson Zhu?").map((record) => record.username),
    ["jackson.zhu"],
  );
  assert.deepEqual(
    selectRecords(RECORDS, "who is in 11A?").map((record) => record.username),
    ["borna.raei"],
  );
  assert.deepEqual(
    selectRecords(RECORDS, "what is the email for Evangeline?").map((record) => record.username),
    ["evangeline.chan"],
  );
  assert.deepEqual(selectRecords(RECORDS, "who is there?"), [], "nothing to look up");
  assert.equal(selectRecords(RECORDS, "10A students", { limit: 1 }).length, 1);

  const sameSurname = [
    ...RECORDS,
    {
      firstName: "Zara",
      lastName: "Zhu",
      email: "zara.zhu@example.com",
      username: "zara.zhu",
      dateOfBirth: null,
      class: "8C",
      gender: "Female",
      roles: [],
      userId: null,
    },
  ];
  assert.deepEqual(
    selectRecords(sameSurname, "what class is Jackson Zhu in?").map((record) => record.username),
    ["jackson.zhu"],
    "the student asked about comes alone",
  );
  assert.deepEqual(
    selectRecords(sameSurname, "who is Zhu?").map((record) => record.username).sort(),
    ["jackson.zhu", "zara.zhu"],
    "a surname on its own finds everyone with it",
  );
});

test("the prompt carries the matched records, the total and the question", () => {
  const { system, user } = buildDaveContext({
    question: "what class is Jackson Zhu in?",
    records: [RECORDS[0]],
    total: 395,
    classes: ["10A", "11A"],
    asker: "Ada",
    serverName: "Main Server",
  });

  assert.match(system, /Answer only from the RECORDS/);
  assert.match(user, /395 student record/);
  assert.match(user, /Classes: 10A, 11A/);
  assert.match(user, /jackson\.zhu@example\.com/);
  assert.match(user, /Question from Ada in Main Server: what class is Jackson Zhu in\?/);

  const empty = buildDaveContext({ question: "who?", records: [], total: 0 });
  assert.match(empty.user, /No record matched/);
});

test("askDave sends the question to Hugging Face and returns its answer", async () => {
  const calls = [];
  const text = await askDave({
    apiKey: "hf_test",
    model: "test/model",
    question: "what class is Jackson Zhu in?",
    records: [RECORDS[0]],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return huggingFaceReply("Jackson Zhu is in **10A**.");
    },
  });

  assert.equal(text, "Jackson Zhu is in **10A**.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://router.huggingface.co/v1/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer hf_test");

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "test/model");
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[1].content, /jackson\.zhu@example\.com/);
});

test("askDave explains a missing token, a rejected token and an empty answer", async () => {
  await assert.rejects(
    () => askDave({ question: "who is Jackson?", records: RECORDS }),
    (error) => error instanceof UserError && /HUGGINGFACE_API_KEY/.test(error.message),
  );

  await assert.rejects(
    () =>
      askDave({
        apiKey: "bad",
        question: "who is Jackson?",
        records: RECORDS,
        fetchImpl: async () => huggingFaceReply("", { ok: false, status: 401 }),
      }),
    (error) =>
      error instanceof UserError &&
      /router\.huggingface\.co rejected Dave's API key/.test(error.message),
  );

  await assert.rejects(
    () =>
      askDave({
        apiKey: "hf_test",
        question: "who is Jackson?",
        records: RECORDS,
        fetchImpl: async () => huggingFaceReply("   "),
      }),
    (error) => error instanceof UserError && /empty answer/.test(error.message),
  );

  await assert.rejects(
    () =>
      askDave({
        apiKey: "hf_test",
        question: "who is Jackson?",
        records: RECORDS,
        fetchImpl: async () => {
          throw new Error("network down");
        },
      }),
    (error) =>
      error instanceof UserError &&
      /Dave couldn't reach router\.huggingface\.co/.test(error.message),
  );
});

test("Dave can use any OpenAI-compatible provider, and says what 402 and 429 mean", async () => {
  const calls = [];
  const text = await askDave({
    apiKey: "gsk_test",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-20b",
    question: "who is Borna?",
    records: RECORDS,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return huggingFaceReply("Borna Raei is in 11A.");
    },
  });

  assert.equal(text, "Borna Raei is in 11A.");
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer gsk_test");

  // Hugging Face's Inference Providers answer 402 until credits are bought.
  await assert.rejects(
    () =>
      askDave({
        apiKey: "hf_test",
        question: "who is Borna?",
        records: RECORDS,
        fetchImpl: async () => huggingFaceReply("", { ok: false, status: 402 }),
      }),
    (error) =>
      error instanceof UserError &&
      /pre-paid credits/.test(error.message) &&
      /DAVE_API_URL/.test(error.message),
  );

  await assert.rejects(
    () =>
      askDave({
        apiKey: "gsk_test",
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        question: "who is Borna?",
        records: RECORDS,
        fetchImpl: async () => huggingFaceReply("", { ok: false, status: 429 }),
      }),
    (error) => error instanceof UserError && /rate-limiting/.test(error.message),
  );
});

test("a member of the main or preview server can just ask Dave", async () => {
  const users = store();
  const calls = [];
  const agent = createDaveAgent({
    apiKey: "hf_test",
    users,
    keys: createDaveKeyStore(),
    sourceId: "main",
    guildIds: ["main", "preview"],
    fetchImpl: async (url, init) => {
      calls.push(init);
      return huggingFaceReply("Jackson Zhu is in 10A.");
    },
  });

  const message = messageFor({ content: "Dave what class is Jackson Zhu in?" });
  assert.equal(await agent.handleMessage(message), true);
  assert.deepEqual(message.replies, ["Jackson Zhu is in 10A."]);
  assert.equal(message.typingCount(), 1);
  assert.equal(calls.length, 1);
  assert.match(JSON.parse(calls[0].body).messages[1].content, /jackson\.zhu@example\.com/);

  const preview = messageFor({ content: "Dave who is Borna?", guildId: "preview" });
  await agent.handleMessage(preview);
  assert.deepEqual(preview.replies, ["Jackson Zhu is in 10A."]);

  assert.equal(await agent.handleMessage(messageFor({ content: "hello there" })), false);
  assert.equal(await agent.handleMessage(messageFor({ content: "Dave who?", bot: true })), false);
});

test("someone outside the servers needs a one-time key that works once", async () => {
  const users = store();
  const keys = createDaveKeyStore();
  const agent = createDaveAgent({
    apiKey: "hf_test",
    users,
    keys,
    sourceId: "main",
    guildIds: ["main", "preview"],
    fetchImpl: async () => huggingFaceReply("Borna Raei is in 11A."),
  });

  const withoutKey = messageFor({
    content: "Dave who is Borna?",
    guildId: "other",
    guildName: "Other Server",
    userId: "u9",
    username: "Outsider",
  });
  await agent.handleMessage(withoutKey);
  assert.match(withoutKey.replies[0], /one-time key/);

  const wrongPerson = keys.create({ userId: "u7" });
  const stolen = messageFor({
    content: `Dave ${wrongPerson.key} who is Borna?`,
    guildId: "other",
    userId: "u9",
  });
  await agent.handleMessage(stolen);
  assert.match(stolen.replies[0], /someone else/);

  const record = keys.create({ userId: "u9", createdBy: "mod" });
  const allowed = messageFor({
    content: `Dave ${record.key} who is Borna?`,
    guildId: "other",
    userId: "u9",
  });
  await agent.handleMessage(allowed);
  assert.deepEqual(allowed.replies, ["Borna Raei is in 11A."]);
  assert.equal(keys.count(), 1, "the wrong-person key is still unused");

  const again = messageFor({
    content: `Dave ${record.key} who is Jackson?`,
    guildId: "other",
    userId: "u9",
  });
  await agent.handleMessage(again);
  assert.match(again.replies[0], /already been used/);
});

test("a direct message can ask with a key, and a failed answer keeps the key", async () => {
  const users = store();
  const keys = createDaveKeyStore();
  const record = keys.create({ userId: "u9" });

  let fail = true;
  const agent = createDaveAgent({
    apiKey: "hf_test",
    users,
    keys,
    sourceId: "main",
    guildIds: ["main"],
    fetchImpl: async () => {
      if (fail) throw new Error("network down");
      return huggingFaceReply("Jackson Zhu is in 10A.");
    },
  });

  const dm = messageFor({
    content: `Dave ${record.key} who is Jackson?`,
    guildId: null,
    userId: "u9",
  });
  await agent.handleMessage(dm);
  assert.match(dm.replies[0], /couldn't reach router\.huggingface\.co/);
  assert.equal(keys.count(), 1, "a failed answer does not spend the key");

  fail = false;
  await agent.handleMessage(dm);
  assert.deepEqual(dm.replies[1], "Jackson Zhu is in 10A.");
  assert.equal(keys.count(), 0);
});

test("Dave explains how to use him when the message has no question", async () => {
  const agent = createDaveAgent({
    apiKey: "hf_test",
    users: store(),
    keys: createDaveKeyStore(),
    sourceId: "main",
    guildIds: ["main"],
    fetchImpl: async () => huggingFaceReply("unused"),
  });

  const bare = messageFor({ content: "Dave" });
  await agent.handleMessage(bare);
  assert.match(bare.replies[0], /Ask me about anyone/);

  const keyOnly = messageFor({ content: "Dave K7QM-3H2P", guildId: "other", userId: "u9" });
  await agent.handleMessage(keyOnly);
  assert.match(keyOnly.replies[0], /one-time key doesn't exist|Add your question/);
});
