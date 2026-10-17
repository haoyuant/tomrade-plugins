import { FakeFeishu } from "./fake.js";

/**
 * `tomrade-plugin test` scenario: the adapter against a Feishu made of fake
 * events, through the real IM layer and Agent. The runtime's fetch and
 * WebSocket stand in for Feishu before the connection opens.
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
  const feishu = new FakeFeishu();
  const net = feishu.net();
  Object.assign(globalThis, { fetch: net.fetch, WebSocket: net.WebSocket });

  t.im.engine({ id: "fake", title: "Fake engine", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input: { input: { kind: string; text?: string; value?: unknown } }, io: { emit(e: unknown): void; tools: { execute(n: string, a: unknown): Promise<unknown> } }) {
      if (input.input.kind === "answer") io.emit({ type: "text", text: `chose ${JSON.stringify(input.input.value)}` });
      else if (input.input.text === "pick") await io.tools.execute("ask_user", { question: "Ship it?", options: ["Yes", "No"] });
      else io.emit({ type: "text", text: `echo: ${input.input.text}` });
      return { stop: "end" };
    } });
  t.im.configure({ connections: [{ id: "feishu", adapterId: "feishu", credentials: { appId: feishu.appId, appSecret: feishu.appSecret } }],
    routes: [{ id: "dm", connectionId: "feishu", tenantId: feishu.tenant, conversationId: "oc_dm", projectId: t.projectId, engine: "fake", allowedActors: ["ou_ann"] }] });

  const until = async (what: string, condition: () => boolean, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 25) { if (condition()) return true; await new Promise(r => setTimeout(r, 25)); }
    t.check(what, false, "timed out");
    return false;
  };
  const said = (text: string) => feishu.posted("oc_dm").some(m => feishu.textOf(m.card).includes(text));

  await until("connects", () => t.im.connections()[0]?.state === "connected");
  t.check("shows the bot it signed in as", t.im.connections()[0]?.identity?.name === "Tomrade Bot");

  feishu.message({ chat: "oc_dm", sender: "ou_out", text: "outsider" });
  feishu.message({ chat: "oc_dm", sender: "ou_ann", text: "hello" });
  t.check("a direct message is answered", await until("a direct message is answered", () => said("echo: hello")));
  t.check("someone not allowed starts nothing", !said("echo: outsider"));
  t.check("a message taken is reacted to", feishu.reactions.length > 0);

  feishu.message({ chat: "oc_dm", sender: "ou_ann", text: "pick" });
  await until("a question is asked", () => said("Ship it?"));
  const question = feishu.posted("oc_dm").find(m => feishu.textOf(m.card).includes("Ship it?"))!;
  const card = question.card as { body: { elements: { tag: string; columns?: { elements: { behaviors?: { type: string; value?: unknown }[] }[] }[] }[] } };
  const value = card.body.elements.find(e => e.tag === "column_set")?.columns?.[0]?.elements[0]?.behaviors?.find(b => b.type === "callback")?.value;
  const press = feishu.press({ messageId: question.id, operator: "ou_ann", value });
  await until("the button is acknowledged", () => feishu.answers.has(press));
  t.check("a button is acknowledged within three seconds", (feishu.answers.get(press)?.at ?? Infinity) - feishu.sentAt.get(press)! < 3000);
  t.check("a button answers the question", await until("a button answers the question", () => said('chose "Yes"')));

  feishu.message({ chat: "oc_dm", sender: "ou_ann", text: "/status" });
  t.check("/status answers", await until("/status answers", () => said("No task is running")));

  feishu.drop();
  await until("reconnects", () => feishu.sockets.length === 2 && t.im.connections()[0]?.state === "connected");
  const again = feishu.message({ chat: "oc_dm", sender: "ou_ann", text: "after the drop" });
  t.check("reconnects after a drop", await until("reconnects after a drop", () => said("echo: after the drop")));
  feishu.event("im.message.receive_v1", again.event, { eventId: again.eventId });
  await new Promise(r => setTimeout(r, 500));
  const runs = t.im.threads().reduce((n, th) => n + t.im.thread(th.id).runs.length, 0);
  t.check("a redelivered event runs once", runs === 4, `${runs} runs`);

  feishu.failNext(c => c.method === "POST" && c.path === "/open-apis/im/v1/messages", 429, 99991400, { retryAfter: 0.2 });
  feishu.message({ chat: "oc_dm", sender: "ou_ann", text: "limited" });
  t.check("waits out a rate limit", await until("waits out a rate limit", () => said("echo: limited"), 12_000));
}
