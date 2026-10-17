import type { AlertSound, Locale, PluginContext, SettingsSectionSpec, SurfaceSpec } from "@tomradex/plugin-sdk";
import pomodoro from "../src/index.js";

type Def = { id: string; [key: string]: any };
type Words = string | Partial<Record<Locale, string>>;

/**
 * An in-memory plugin host with what Pomodoro reaches for: settings, the
 * status bar and palette, tools, alerts and a desktop surface. Commands and
 * tools run the plugin's own handlers; surfaces and alerts only remember.
 */
export async function fakeHost(opts: { sounds?: AlertSound[]; saved?: Record<string, unknown>; surfaces?: boolean } = {}) {
  let locale: Locale = "en";
  let section: SettingsSectionSpec<any> | null = null;
  let saved: unknown = opts.saved;
  const listeners = new Map<string, ((...args: any[]) => unknown)[]>();
  const cleanups: (() => unknown)[] = [];
  const commands = new Map<string, Def>();
  const statusItems = new Map<string, Def>();
  const tools = new Map<string, Def>();
  const kits = new Map<string, string>();
  const surfaces = new Map<string, { spec: SurfaceSpec; state: any; bounds: { x: number; y: number; width: number; height: number } }>();
  const played: { sound: string; volume?: number }[] = [];
  const notices: { title: string; body?: string }[] = [];
  const shown: string[] = [];
  const emit = (event: string) => listeners.get(event)?.forEach((fn) => fn());
  const keep = <T extends Def>(map: Map<string, T>, def: T) => {
    map.set(def.id, def);
    return async () => void map.delete(def.id);
  };

  const ctx = {
    id: "tomrade/pomodoro",
    namespace: "pomodoro",
    dataDir: null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {
      register: async (spec: SettingsSectionSpec<any>) => void (section = spec),
      get: async () => saved ?? section!.defaults,
      set: async (value: unknown) => {
        saved = value;
        emit("settings.changed");
      },
      show: async (id?: string) => void shown.push(id ?? "pomodoro"),
      locale: async () => locale
    },
    contributions: {
      command: async (def: Def) => keep(commands, def),
      statusItem: async (def: Def) => keep(statusItems, def),
      refresh: async () => {}
    },
    tools: {
      register: async (def: Def & { name: string }) => keep(tools, { ...def, id: def.name }),
      kit: async (id: string, purpose: string) => {
        kits.set(id, purpose);
        return async () => void kits.delete(id);
      }
    },
    alerts: {
      sounds: async () => opts.sounds ?? [{ id: "system:Glass", title: "Glass" }, { id: "system:Ping", title: "Ping" }],
      play: async (sound: string, o?: { volume?: number }) => void played.push({ sound, volume: o?.volume }),
      notify: async (notice: { title: string; body?: string }) => void notices.push(notice)
    },
    surfaces: {
      open: async (spec: SurfaceSpec) => {
        const record = { spec, state: spec.initialState, bounds: { x: 100, y: 100, width: spec.width, height: spec.height } };
        surfaces.set(spec.id, record);
        return {
          id: spec.id,
          bounds: async () => record.bounds,
          workArea: async () => ({ x: 0, y: 0, width: 1200, height: 800 }),
          setPosition: async (x: number, y: number) => void (record.bounds = { ...record.bounds, x, y }),
          setState: async (state: unknown) => void (record.state = state),
          close: async () => void surfaces.delete(spec.id)
        };
      }
    },
    on(event: string, fn: (...args: any[]) => unknown) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => {};
    },
    when(name: string, fn: () => unknown) {
      if (name === "surfaces" && opts.surfaces !== false) {
        const undo = fn();
        if (typeof undo === "function") cleanups.push(undo as () => unknown);
      }
      return () => {};
    },
    has: (name: string) => name !== "surfaces" || opts.surfaces !== false,
    effect(fn: () => unknown) {
      const undo = fn();
      if (typeof undo === "function") cleanups.push(undo as () => unknown);
    },
    interval(fn: () => unknown, ms: number) {
      const timer = setInterval(fn, ms);
      cleanups.push(() => clearInterval(timer));
      return () => clearInterval(timer);
    }
  };

  await pomodoro.apply(ctx as unknown as PluginContext, undefined);
  const say = (w: Words | undefined) => (typeof w === "string" || w === undefined ? w : (w[locale] ?? w.en));

  return {
    surfaces,
    played,
    notices,
    shown,
    kits,
    section: () => section!,
    tools: () => [...tools.values()],
    status: () => tools.get("pomodoro_status")!.execute({}, { author: "human" }) as Promise<any>,
    run: async (id: string) => commands.get(id)!.run({}),
    command: (id: string) => {
      const c = commands.get(id);
      return c && { title: say(c.title), group: say(c.group) };
    },
    statusItems: async () =>
      Promise.all([...statusItems.values()].map(async (s) => ({ id: s.id, text: await s.text({}), title: say(s.title), icon: s.icon, until: await s.until?.({}) }))),
    menu: async () => ((await [...statusItems.values()][0]!.menu({})) as { title: string }[]).map((m) => m.title),
    configure: (patch: Record<string, unknown>) => ctx.settings.set({ ...(saved as object), ...patch }),
    setLocale(next: Locale) {
      locale = next;
      emit("settings.changed");
    },
    async dispose() {
      for (const undo of cleanups.reverse()) await undo();
      statusItems.clear();
      commands.clear();
      tools.clear();
    }
  };
}
