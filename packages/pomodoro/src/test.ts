/**
 * `tomrade-plugin test` scenario: the timer through Tomrade's own tools,
 * contributions, settings and a sandbox alerts service that only remembers
 * what it was asked to play and show. There is no desktop here, so no widget.
 */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  tool(name: string, args?: unknown): Promise<unknown>;
  command(id: string): Promise<unknown>;
  statusItems(): Promise<{ id: string; text: string | null; until?: number | null }[]>;
  alerts: { played(): { sound: string; volume?: number }[]; notices(): { title: string; body?: string }[] };
}) {
  type State = { phase: string; running: boolean; deadline: number | null; round: string; config: { sound: string } };
  const status = () => t.tool("pomodoro_status") as Promise<State>;

  const first = await status();
  t.check("starts at a focus phase that waits to be started", first.phase === "focus" && !first.running, `${first.phase}, running: ${first.running}`);
  t.check("picks this machine's system sound", first.config.sound === "system:Glass", first.config.sound);
  const [item] = await t.statusItems();
  t.check("shows the time left in the status bar", item?.id === "pomodoro.status" && item.text === "Focus 25:00", item?.text ?? "none");

  await t.command("pomodoro.toggle");
  const running = await status();
  t.check("starts from the palette", running.running && running.deadline !== null);
  const [counting] = await t.statusItems();
  t.check("counts down to the deadline", counting?.text === "Focus" && counting.until === running.deadline, counting?.text ?? "none");

  const skipped = (await t.tool("pomodoro_control", { action: "skip" })) as State;
  t.check("skips to a short break, still running", skipped.phase === "shortBreak" && skipped.running, skipped.phase);
  t.check("announces nothing for a skip", t.alerts.notices().length === 0 && t.alerts.played().length === 0);

  const reset = (await t.tool("pomodoro_control", { action: "reset" })) as State;
  t.check("resets to the first round's focus", reset.phase === "focus" && !reset.running && reset.round === "Round 1/4", reset.round);
}
