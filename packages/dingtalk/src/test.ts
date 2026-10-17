import { FakeDingTalk } from "./fake.js";

/**
 * `tomrade-plugin test` scenario: the adapter against a DingTalk made of fake
 * frames, through the real IM layer and Agent. The runtime's fetch and
 * WebSocket stand in for DingTalk before the connection opens.
 */
export default async function scenario(t: {
  projectId: string;
  check(name: string, ok: boolean, detail?: string): void;
  im: {
    configure(settings: unknown): void;
    engine(engine: unknown): void;
    threads(): { id: string }[];
    thread(id: string): { runs: unknown[] };
    connections(): { state: string; identity?: { id: string; name?: string } }[];
  };
}) {
  const dingtalk = new FakeDingTalk();
  const net = dingtalk.net();
  Object.assign(globalThis, { fetch: net.fetch, WebSocket: net.WebSocket });

  t.im.engine({ id: "fake", title: "Fake engine", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input: { input: { kind: string; text?: string; value?: unknown } }, io: { emit(e: unknown): void; tools: { execute(n: string, a: unknown): Promise<unknown> } }) {
      if (input.input.kind === "answer") io.emit({ type: "text", text: `chose ${JSON.stringify(input.input.value)}` });
      else if (input.input.text === "pick") await io.tools.execute("ask_user", { question: "Ship it?", options: ["Yes", "No"] });
      else io.emit({ type: "text", text: `echo: ${input.input.text}` });
      return { stop: "end" };
    } });
  t.im.configure({ connections: [{ id: "dingtalk", adapterId: "dingtalk", credentials: { clientId: dingtalk.clientId, clientSecret: dingtalk.clientSecret } }],
    routes: [{ id: "dm", connectionId: "dingtalk", tenantId: dingtalk.corpId, conversationId: "user:ann", projectId: t.projectId, engine: "fake", allowedActors: ["ann"] }] });

  const until = async (what: string, condition: () => boolean, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 25) { if (condition()) return true; await new Promise(r => setTimeout(r, 25)); }
    t.check(what, false, "timed out");
    return false;
  };
  const said = (text: string) => dingtalk.posted("user:ann").some(p => dingtalk.textOf(p).includes(text));

  await until("connects", () => t.im.connections()[0]?.state === "connected");
  t.check("shows the robot it signed in as", t.im.connections()[0]?.identity?.id === dingtalk.clientId);

  dingtalk.message({ sender: "out", text: "outsider" });
  const hello = dingtalk.message({ sender: "ann", text: "hello" });
  t.check("a direct message is answered", await until("a direct message is answered", () => said("echo: hello")));
  t.check("someone not allowed starts nothing", !dingtalk.posts.some(p => p.conversation === "user:out"));
  t.check("a message taken shows the thinking emotion", dingtalk.emotions.some(e => e.msgId === hello.msgId && e.text === "🤔思考中"));
  t.check("the emotion goes when the turn ends", await until("the emotion goes when the turn ends", () => dingtalk.emotions.every(e => e.recalled)));
  t.check("replies are AI cards", dingtalk.posted("user:ann").every(p => p.via === "card"));

  dingtalk.message({ sender: "ann", text: "pick" });
  await until("a question is asked", () => said("Ship it?"));
  const question = dingtalk.posted("user:ann").find(p => dingtalk.textOf(p).includes("Ship it?"))!;
  const yes = dingtalk.buttonsOf(question.id).find(b => b.text === "Yes");
  t.check("the question has a button per option", !!yes?.request && dingtalk.buttonsOf(question.id).length === 2);
  const press = dingtalk.press({ card: question.id, user: "ann", action: yes?.id ?? "" });
  await until("the button is acknowledged", () => dingtalk.answers.has(press));
  t.check("a button is acknowledged within three seconds", (dingtalk.answers.get(press)?.at ?? Infinity) - dingtalk.sentAt.get(press)! < 3000);
  t.check("a button answers the question", await until("a button answers the question", () => said('chose "Yes"')));
  t.check("the answered question loses its buttons", await until("the answered question loses its buttons", () => dingtalk.buttonsOf(question.id).length === 0));

  dingtalk.message({ sender: "ann", text: "/status" });
  t.check("/status answers", await until("/status answers", () => said("No task is running")));

  dingtalk.drop();
  await until("reconnects", () => dingtalk.sockets.length === 2 && t.im.connections()[0]?.state === "connected");
  const again = dingtalk.message({ sender: "ann", text: "after the drop" });
  t.check("reconnects after a drop", await until("reconnects after a drop", () => said("echo: after the drop")));
  dingtalk.push("CALLBACK", "/v1.0/im/bot/messages/get", again.data);
  await new Promise(r => setTimeout(r, 500));
  const runs = t.im.threads().reduce((n, th) => n + t.im.thread(th.id).runs.length, 0);
  t.check("a redelivered message runs once", runs === 4, `${runs} runs`);

  dingtalk.failNext(c => c.path === "/v1.0/card/instances/createAndDeliver", 403, { code: "Forbidden.AccessDenied.QpsLimitForAppkeyAndApi", message: "QPS" });
  dingtalk.message({ sender: "ann", text: "limited" });
  t.check("waits out a rate limit", await until("waits out a rate limit", () => said("echo: limited"), 12_000));

  // Without the card permission replies are Markdown; with the session webhook lapsed, the robot's own API still reaches the chat.
  dingtalk.noCards = true;
  dingtalk.message({ sender: "ann", text: "plain", webhookTtlMs: -1000 });
  t.check("replies after the session webhook expired", await until("replies after the session webhook expired",
    () => dingtalk.posted("user:ann").some(p => p.via === "api" && p.text.includes("echo: plain")), 12_000));
  t.check("without cards no webhook is used once it lapsed", !dingtalk.calls.some(c => c.path === "/robot/sendBySession"));
}
