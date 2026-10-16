import { THINKING } from "./card.js";
import { FakeWecom } from "./fake.js";

/**
 * `tomrade-plugin test` scenario: the adapter against a WeCom made of fake
 * callbacks, through the real IM layer and Agent. The runtime's fetch and
 * WebSocket stand in for WeCom before the connection opens.
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
  const wecom = new FakeWecom();
  const net = wecom.net();
  Object.assign(globalThis, { fetch: net.fetch, WebSocket: net.WebSocket });

  t.im.engine({ id: "fake", title: "Fake engine", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input: { input: { kind: string; text?: string; value?: unknown } }, io: { emit(e: unknown): void; delta?(text: string): void; tools: { execute(n: string, a: unknown): Promise<unknown> } }) {
      if (input.input.kind === "answer") io.emit({ type: "text", text: `chose ${JSON.stringify(input.input.value)}` });
      else if (input.input.text === "pick") await io.tools.execute("ask_user", { question: "Ship it?", options: ["Yes", "No"] });
      else {
        io.delta?.("echo: ");
        io.delta?.(input.input.text ?? "");
        io.emit({ type: "text", text: `echo: ${input.input.text}` });
      }
      return { stop: "end" };
    } });
  t.im.configure({ connections: [{ id: "wecom", adapterId: "wecom", credentials: { botId: wecom.botId, secret: wecom.secret } }],
    routes: [{ id: "dm", connectionId: "wecom", tenantId: wecom.botId, conversationId: "ann", projectId: t.projectId, engine: "fake", allowedActors: ["ann"] }] });

  const until = async (what: string, condition: () => boolean, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 25) { if (condition()) return true; await new Promise(r => setTimeout(r, 25)); }
    t.check(what, false, "timed out");
    return false;
  };
  const said = (text: string) => wecom.said("ann", text);

  await until("connects", () => t.im.connections()[0]?.state === "connected");
  t.check("shows the bot it signed in as", t.im.connections()[0]?.identity?.id === wecom.botId);

  wecom.message({ from: "out", text: "outsider" });
  wecom.message({ from: "ann", text: "hello" });
  t.check("a direct message is answered", await until("a direct message is answered", () => said("echo: hello")));
  t.check("someone not allowed starts nothing", !wecom.said("out", "echo"));
  const answer = wecom.chat("ann").find(s => s.text.includes("echo: hello"));
  t.check("a thinking placeholder is the receipt, and the answer takes it over", answer?.kind === "stream" && answer.first === THINKING && answer.finished, `${answer?.frames ?? 0} frames, the first ${answer?.first}`);

  wecom.message({ from: "ann", text: "pick" });
  await until("a question is asked", () => wecom.cards("ann").some(c => JSON.stringify(c).includes("Ship it?")));
  const card = wecom.cards("ann").find(c => JSON.stringify(c).includes("Ship it?")) as { task_id: string; button_list: { text: string; key: string }[] } | undefined;
  const yes = card?.button_list.find(b => b.text === "Yes");
  const press = wecom.press({ from: "ann", taskId: card?.task_id ?? "", key: yes?.key ?? "" });
  await until("the card is answered", () => wecom.updates.some(u => u.eventId === press));
  const update = wecom.updates.find(u => u.eventId === press);
  t.check("a button press updates the card within five seconds", !!update && update.at - wecom.sentAt.get(press)! < 5000);
  t.check("a button answers the question", await until("a button answers the question", () => said('chose "Yes"')));

  wecom.message({ from: "ann", text: "/status" });
  t.check("/status answers", await until("/status answers", () => said("No task is running")));

  wecom.drop();
  await until("reconnects", () => wecom.sockets.length === 2 && !!wecom.live && t.im.connections()[0]?.state === "connected");
  const again = wecom.message({ from: "ann", text: "after the drop" });
  t.check("reconnects after a drop", await until("reconnects after a drop", () => said("echo: after the drop")));
  wecom.callback(again.body, false);
  await new Promise(r => setTimeout(r, 500));
  const runs = t.im.threads().reduce((n, th) => n + t.im.thread(th.id).runs.length, 0);
  t.check("a redelivered message runs once", runs === 4, `${runs} runs`);

  wecom.failNext((cmd, body) => cmd === "aibot_respond_msg" && (body.stream as { finish?: boolean } | undefined)?.finish === true, 846607);
  wecom.message({ from: "ann", text: "limited" });
  t.check("waits out a rate limit", await until("waits out a rate limit", () => wecom.chat("ann").some(s => s.text.includes("echo: limited") && s.finished), 12_000));
  t.check("keeps to 30 messages a minute", wecom.busiest("ann") <= 30, `${wecom.busiest("ann")} in a minute`);
}
