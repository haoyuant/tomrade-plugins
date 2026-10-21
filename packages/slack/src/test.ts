import { FakeSlack } from "./fake.js";

/**
 * `tomrade-plugin test` scenario: the adapter against a Slack made of fake
 * events, through the real IM layer and Agent. The runtime's fetch and
 * WebSocket stand in for Slack before the connection opens.
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
  const slack = new FakeSlack();
  slack.users.set("U0ANN", "Ann");
  const net = slack.net();
  Object.assign(globalThis, { fetch: net.fetch, WebSocket: net.WebSocket });

  t.im.engine({ id: "fake", title: "Fake engine", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input: { input: { kind: string; text?: string; value?: unknown } }, io: { emit(e: unknown): void; delta(text: string): void; tools: { execute(n: string, a: unknown): Promise<unknown> } }) {
      if (input.input.kind === "answer") io.emit({ type: "text", text: `chose ${JSON.stringify(input.input.value)}` });
      else if (input.input.text === "pick") await io.tools.execute("ask_user", { question: "Ship it?", options: ["Yes", "No"] });
      else {
        io.delta("echo: ");
        await new Promise(r => setTimeout(r, 50));
        io.emit({ type: "text", text: `echo: ${input.input.text}` });
      }
      return { stop: "end" };
    } });
  t.im.configure({ connections: [{ id: "slack", adapterId: "slack", credentials: { appToken: slack.appToken, botToken: slack.botToken } }],
    routes: [{ id: "dm", connectionId: "slack", tenantId: slack.team, conversationId: "D0ANN", projectId: t.projectId, engine: "fake", allowedActors: ["U0ANN"] },
      { id: "dev", connectionId: "slack", tenantId: slack.team, conversationId: "C0DEV", projectId: t.projectId, engine: "fake", allowedActors: ["U0ANN"], allowGroups: true }] });

  const until = async (what: string, condition: () => boolean, ms = 6000) => {
    for (let waited = 0; waited < ms; waited += 25) { if (condition()) return true; await new Promise(r => setTimeout(r, 25)); }
    t.check(what, false, "timed out");
    return false;
  };
  const said = (text: string, channel = "D0ANN") => slack.posted(channel).some(m => slack.textOf(m).includes(text));

  await until("connects", () => t.im.connections()[0]?.state === "connected");
  t.check("shows the bot it signed in as", t.im.connections()[0]?.identity?.name === "Tomrade");

  slack.message({ channel: "D0ANN", user: "U0OUT", text: "outsider" });
  const hello = slack.message({ channel: "D0ANN", user: "U0ANN", text: "hello" });
  t.check("a direct message is answered in its thread", await until("a direct message is answered", () => said("echo: hello"))
    && slack.posted("D0ANN").every(m => m.thread === hello.ts));
  t.check("someone not allowed starts nothing", !said("echo: outsider"));
  t.check("a message taken is reacted to", slack.reactions.some(r => r.ts === hello.ts));
  t.check("shows it is thinking in the thread", slack.statuses.some(s => s.thread === hello.ts && s.status));
  t.check("the reply streams, then settles", slack.where("chat.startStream").length > 0 && slack.where("chat.stopStream").length > 0);
  t.check("every event is acknowledged", [...slack.sentAt.keys()].every(id => slack.acks.has(id)));

  const pick = slack.message({ channel: "D0ANN", user: "U0ANN", text: "pick" });
  await until("a question is asked", () => said("Ship it?"));
  const question = slack.posted("D0ANN").find(m => slack.textOf(m).includes("Ship it?"))!;
  const button = (question.blocks ?? []).flatMap(b => (b.elements ?? []) as { action_id?: string; value?: string }[]).find(e => e.action_id?.startsWith("tomrade:b"));
  const press = slack.press({ channel: "D0ANN", ts: question.ts, user: "U0ANN", action: { type: "button", block_id: "b", ...button } });
  await until("the button is acknowledged", () => slack.acks.has(press));
  t.check("a button is acknowledged within three seconds", (slack.acks.get(press)?.at ?? Infinity) - slack.sentAt.get(press)! < 3000);
  t.check("a button answers the question", await until("a button answers the question", () => said('chose "Yes"')));
  t.check("the answered question loses its buttons", await until("the buttons go", () => !slack.find("D0ANN", question.ts)!.blocks!.some(b => b.type === "actions")));
  t.check("the question was asked in its thread", question.thread === pick.ts);

  slack.command({ channel: "D0ANN", user: "U0ANN", text: "status" });
  t.check("/tomrade status answers", await until("/tomrade status answers", () => said("No task is running")));

  slack.drop();
  await until("reconnects", () => slack.sockets.length === 2 && slack.live !== null && t.im.connections()[0]?.state === "connected");
  const again = slack.message({ channel: "D0ANN", user: "U0ANN", text: "after the drop" });
  t.check("reconnects after a drop", await until("reconnects after a drop", () => said("echo: after the drop")));
  slack.event(again.event, { eventId: again.eventId, retry: 1 });
  await new Promise(r => setTimeout(r, 500));
  const runs = t.im.threads().reduce((n, th) => n + t.im.thread(th.id).runs.length, 0);
  t.check("a redelivered event runs once", runs === 4, `${runs} runs`);

  const asked = slack.message({ channel: "C0DEV", user: "U0ANN", text: "in the channel", mention: true });
  t.check("a channel mention is answered in its thread", await until("a channel mention is answered", () => said("echo: in the channel", "C0DEV")));
  slack.message({ channel: "C0DEV", user: "U0ANN", text: "follow up", thread: asked.ts });
  t.check("a follow-up in that thread needs no @", await until("a follow-up is answered", () => said("echo: follow up", "C0DEV")));
  // A ticket already being worked has its own thread in the channel from before the mention.
  t.check("the channel's answers stay in the thread", slack.posted("C0DEV").filter(m => m.ts > asked.ts).every(m => m.thread === asked.ts));

  slack.failNext(c => c.method === "chat.startStream" || c.method === "chat.postMessage", 429, "ratelimited", { retryAfter: 0.2 });
  slack.message({ channel: "D0ANN", user: "U0ANN", text: "limited" });
  t.check("waits out a rate limit", await until("waits out a rate limit", () => said("echo: limited"), 8000) && slack.failing === 0);
}
