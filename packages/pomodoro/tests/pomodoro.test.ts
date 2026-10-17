import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { fakeHost } from "./fake.js";

afterEach(() => {
  vi.useRealTimers();
});

it("opens its desktop widget from the start, lives in the status bar with a quick menu, opens its Settings pane, clamps dragging and cleans up", async () => {
  const host = await fakeHost();
  try {
    // The widget is out from the first start, just above the sidebar's Project settings.
    await vi.waitFor(() => expect(host.surfaces.has("pomodoro.desktop")).toBe(true));
    const desktop = host.surfaces.get("pomodoro.desktop")!;
    expect(desktop.spec).toMatchObject({ document: "dist/static/timer.html", transparent: true, clickThrough: true, anchor: "sidebar-foot" });
    expect((await host.status()).config).toMatchObject({ desktop: true, notify: true, sound: "system:Glass", volume: 70 });
    // Few conversations need the timer, so its tools wait in a kit until the model loads it.
    expect(host.tools().map((t) => [t.name, t.kit])).toEqual([["pomodoro_status", "pomodoro"], ["pomodoro_control", "pomodoro"]]);
    expect(host.kits.get("pomodoro")).toMatch(/Pomodoro/);

    // It speaks the app's language, English until the person picks another.
    expect(await host.statusItems()).toMatchObject([{ id: "pomodoro.status", text: "Focus 25:00", icon: "i-tomato", title: "Pomodoro" }]);
    expect(await host.menu()).toEqual(["Start", "Skip", "Reset", "Hide desktop widget", "All settings…"]);
    expect(host.command("pomodoro.skip")).toEqual({ title: "Pomodoro: Skip", group: "Pomodoro" });
    host.setLocale("zh");
    await vi.waitFor(async () => expect(await host.statusItems()).toMatchObject([{ text: "专注 25:00", title: "番茄钟" }]));
    expect(await host.menu()).toEqual(["开始", "跳过", "重置", "收起桌面浮窗", "完整设置…"]);
    expect(host.command("pomodoro.skip")).toEqual({ title: "番茄钟：跳过", group: "番茄钟" });
    const section = host.section();
    expect(section.words?.zh).toMatchObject({ title: "番茄钟", fields: { soundFile: { title: "音频文件" }, sound: { options: { none: "无", "system:Glass": "Glass", file: "下方选择的音频文件" } } } });
    expect((z.toJSONSchema(section.schema, { io: "input" }) as any).properties.sound.enum).toEqual(["none", "system:Glass", "system:Ping", "file"]);

    await host.run("pomodoro.toggle");
    const first = await host.status();
    expect(await host.statusItems()).toMatchObject([{ text: "专注", until: first.deadline }]);
    expect((await host.menu())[0]).toBe("暂停");
    await vi.waitFor(() => expect(desktop.state).toMatchObject({ deadline: first.deadline, round: "第 1/4 轮" }));
    await desktop.spec.onMessage?.({ type: "move", x: 3000, y: -3000 });
    await vi.waitFor(() => expect(desktop.bounds).toMatchObject({ x: 960, y: 0 }));
    // Some time has to run before a pause shows as one.
    await new Promise((r) => setTimeout(r, 5));
    await desktop.spec.onMessage?.({ type: "action", action: "toggle" });
    await vi.waitFor(() => expect(desktop.state.running).toBe(false));
    expect((await host.statusItems())[0]!.text).toMatch(/^专注 \d\d:\d\d · 已暂停$/);
    expect((await host.menu())[0]).toBe("继续");

    await desktop.spec.onMessage?.({ type: "action", action: "settings" });
    await vi.waitFor(() => expect(host.shown).toEqual(["pomodoro"]));

    // Hidden, it stays hidden; reopened, it comes back where it was left rather than at the anchor.
    await desktop.spec.onMessage?.({ type: "action", action: "desktop" });
    await vi.waitFor(() => expect(host.surfaces.has("pomodoro.desktop")).toBe(false));
    expect((await host.status()).config.desktop).toBe(false);
    expect((await host.menu())[3]).toBe("打开桌面浮窗");
    await host.run("pomodoro.desktop");
    await vi.waitFor(() => expect(host.surfaces.get("pomodoro.desktop")?.bounds).toMatchObject({ x: 960, y: 0 }));
    expect(host.surfaces.get("pomodoro.desktop")!.spec.anchor).toBeUndefined();
  } finally {
    await host.dispose();
  }
  await vi.waitFor(() => expect(host.surfaces.size).toBe(0));
});

it("announces the end of a phase with a notification and the chosen sound, and previews a sound when it is picked", async () => {
  const host = await fakeHost();
  try {
    await vi.waitFor(() => expect(host.surfaces.has("pomodoro.desktop")).toBe(true));
    vi.useFakeTimers({ toFake: ["Date"] });
    await host.run("pomodoro.toggle");
    vi.setSystemTime(Date.now() + 25 * 60_000 + 1);
    // The next one-second tick sees the focus run out.
    await vi.waitFor(() => expect(host.notices).toHaveLength(1), { timeout: 3_000 });
    expect(host.notices[0]).toEqual({ title: "Time for a short break", body: "Focus session done · Start it when you are ready." });
    expect(host.played).toEqual([{ sound: "system:Glass", volume: 0.7 }]);
    expect(await host.status()).toMatchObject({ phase: "shortBreak", running: false, completed: 1 });

    host.played.length = 0;
    await host.configure({ sound: "system:Ping", volume: 40 });
    await vi.waitFor(() => expect(host.played).toEqual([{ sound: "system:Ping", volume: 0.4 }]));
    // Choosing a file switches the sound to it, and plays it once.
    host.played.length = 0;
    await host.configure({ soundFile: "/Users/me/Music/bell.mp3" });
    await vi.waitFor(async () => expect((await host.status()).config.sound).toBe("file"));
    await vi.waitFor(() => expect(host.played).toEqual([{ sound: "/Users/me/Music/bell.mp3", volume: 0.4 }]));

    // No sound, no notification: the phase still ends quietly.
    host.played.length = 0;
    await host.configure({ sound: "none", notify: false });
    await host.run("pomodoro.toggle");
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await vi.waitFor(async () => expect((await host.status()).phase).toBe("focus"), { timeout: 3_000 });
    expect(host.notices).toHaveLength(1);
    expect(host.played).toEqual([]);
  } finally {
    await host.dispose();
  }
});

it("falls back to the first system sound when the saved one is not on this machine, and keeps what the built-in saved", async () => {
  const host = await fakeHost({ sounds: [{ id: "system:Glass", title: "Glass" }], saved: { sound: "system:Windows Notify", focusMinutes: 50 }, surfaces: false });
  try {
    expect((await host.status()).config).toMatchObject({ sound: "system:Glass", focusMinutes: 50 });
    expect(await host.statusItems()).toMatchObject([{ text: "Focus 50:00" }]);
  } finally {
    await host.dispose();
  }
});
