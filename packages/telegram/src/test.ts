import { FakeTelegram } from "./fake.js";

/**
 * `tomrade-plugin test` scenario: the adapter against a Telegram made of fake
 * updates, through the real IM layer and Agent. The runtime's fetch stands in
 * for the Bot API before the connection opens.
 */
export default async function scenario(t: {
  projectId: string;
  check(name: string, ok: boolean, detail?: string): void;
  im: {
    configure(settings: unknown): void;
    engine(engine: unknown): void;
    threads(): { id: string }[];
    thread(id: string): { runs: unknown[] };
    connections(): { state: string; identity?: { name?: string } }[];
  };
}) {
  const tg = new FakeTelegram();
  Object.assign(globalThis, { fetch: tg.net().fetch });
  const ann = tg.ann;
  const outsider = { id: 1003, is_bot: false, first_name: "Eve" };
  const dm = ann.id;

  t.im.engine({ id: "fake", title: "Fake engine", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input: { input: { kind: string; text?: string; value?: unknown } }, io: { emit(e: unknown): void; tools: { execute(n: string, a: unknown): Promise<unknown> } }) {
      if (input.input.kind === "answer") io.emit({ type: "text", text: `chose ${JSON.stringify(input.input.value)}` });
      else if (input.input.text === "pick") await io.tools.execute("ask_user", { question: "Ship it?", options: ["Yes", "No"] });
      else io.emit({ type: "text", text: `echo: ${input.input.text}` });
      return { stop: "end" };
    } });
  const settings = (enabled: boolean) => ({
    connections: [{ id: "telegram", adapterId: "telegram", enabled, credentials: { botToken: tg.token } }],
    // Answers only, so Telegram's one message a second per chat keeps the scenario quick.
    routes: [{ id: "dm", connectionId: "telegram", tenantId: "telegram", conversationId: String(dm), projectId: t.projectId, engine: "fake", allowedActors: [String(ann.id)], output: "final" }]
  });
  t.im.configure(settings(true));

  const until = async (what: string, condition: () => boolean, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 25) { if (condition()) return true; await new Promise(r => setTimeout(r, 25)); }
    t.check(what, false, "timed out");
    return false;
  };
  const said = (text: string) => tg.posted(dm).filter(m => m.text?.includes(text)).length;
  const runs = () => t.im.threads().reduce((n, th) => n + t.im.thread(th.id).runs.length, 0);

  await until("connects", () => t.im.connections()[0]?.state === "connected");
  t.check("shows the bot it signed in as", t.im.connections()[0]?.identity?.name === "Tomrade Bot (@tomrade_bot)", t.im.connections()[0]?.identity?.name);
  t.check("registers the commands in the bot's menu", await until("registers the commands", () => !!tg.commands?.some(c => c.command === "status")));

  tg.message({ from: outsider, text: "outsider" });
  const hello = tg.message({ from: ann, text: "hello" });
  t.check("a direct message is answered", await until("a direct message is answered", () => said("echo: hello") === 1));
  t.check("someone not allowed starts nothing", tg.posted(outsider.id).length === 0);
  t.check("a message taken is reacted to", await until("a reaction", () => !!tg.reactions.get(`${dm}:${hello.id}`)));

  tg.message({ from: ann, text: "pick" });
  await until("a question is asked", () => said("Ship it?") === 1);
  const question = tg.posted(dm).find(m => m.text?.includes("Ship it?"))!;
  const press = tg.press({ chat: dm, messageId: question.message_id, from: ann, label: "Yes" });
  await until("the button is answered", () => tg.answers.get(press)?.at !== undefined);
  const answered = tg.answers.get(press)!;
  t.check("a button is answered at once", (answered.at ?? Infinity) - answered.pressed < 3000);
  t.check("a button answers the question", await until("a button answers the question", () => said('chose "Yes"') === 1));
  t.check("the question's buttons go once it is answered", await until("the buttons go", () => !tg.posted(dm).find(m => m.message_id === question.message_id)?.reply_markup));

  tg.message({ from: ann, text: "/status" });
  t.check("/status answers", await until("/status answers", () => said("No task is running") === 1));

  const polls = tg.where("getUpdates").length;
  tg.drop();
  await until("polls again after the drop", () => tg.where("getUpdates").length > polls && t.im.connections()[0]?.state === "connected");
  const again = tg.message({ from: ann, text: "after the drop" });
  t.check("reconnects after a drop", await until("reconnects after a drop", () => said("echo: after the drop") === 1));

  const before = runs();
  tg.redeliver(again.message);
  await new Promise(r => setTimeout(r, 600));
  t.check("a redelivered message runs once", runs() === before && said("echo: after the drop") === 1, `${runs() - before} extra runs`);

  // Closing and opening the connection is a restart for the adapter: offsets start over at Telegram's.
  const served = tg.served.length;
  t.im.configure(settings(false));
  await until("closes", () => t.im.connections()[0]?.state !== "connected");
  tg.message({ from: ann, text: "while closed" });
  t.im.configure(settings(true));
  await until("connects again", () => t.im.connections()[0]?.state === "connected");
  t.check("a message sent while closed is answered once", await until("caught up", () => said("echo: while closed") === 1) && said("echo: while closed") === 1);
  const handled = new Set(tg.served.slice(0, served));
  t.check("nothing handled before the restart is fetched again", !tg.served.slice(served).some(id => handled.has(id)));
  await new Promise(r => setTimeout(r, 300));
  t.check("earlier messages do not run again after the restart", said("echo: hello") === 1 && said("echo: after the drop") === 1);

  tg.failNext(c => c.method === "sendMessage", 429, "Too Many Requests: retry after 1", { retryAfter: 1 });
  tg.message({ from: ann, text: "limited" });
  t.check("waits out a rate limit", await until("waits out a rate limit", () => said("echo: limited") === 1, 12_000));
}
