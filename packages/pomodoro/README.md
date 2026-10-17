# Pomodoro

A focus and break timer for Tomrade. Tomrade installs it once on every machine, so it is there from the start; it can be switched off or uninstalled in Settings → Plugins like any other plugin.

- **Status bar.** The tomato at the right end of the status bar shows the phase and the time left. Clicking it opens start / pause / resume, skip, reset, the desktop widget and the full settings. The same actions are in the command palette ("Pomodoro: …").
- **Desktop widget.** A clock without a card that floats above other windows, readable on any wallpaper. Its buttons fade in on hover and clicks elsewhere pass through to the window below. It first sits just above the sidebar's Project settings; drag it anywhere on the screen. Hidden, it stays hidden.
- **Rules.** 25 minutes of focus, 5 minutes of short break and, after every fourth focus, a 15-minute long break, all adjustable. The next phase starts by hand unless auto-start is on. A change of rules applies from the next phase.
- **Alerts.** When a phase runs out (skipping does not count), a system notification and a sound: none, one of this machine's system sounds, or an audio file you pick. Picking a sound or changing the volume plays it once. Tomrade plays the sound and shows the notification; the plugin never reads the file itself.
- **Assistant.** `pomodoro_status` and `pomodoro_control` sit in a `pomodoro` kit: a conversation loads them when you ask about the timer, and carries nothing otherwise.
- **Language.** Everything follows Tomrade's language, English or Chinese, and switches at once.

After sleep, at most one phase that was really running is counted. Quitting Tomrade starts the next run from a focus phase that has not started; the rules are kept on this machine.

There is nothing to set up. The plugin asks for no network, file or program access.

`static/timer.html` is the widget's document; the build copies it to `dist/static/`, which is what ships. `tests/fake.ts` is an in-memory plugin host used by the tests; `src/test.ts` runs the timer through Tomrade's sandbox (`tomrade-plugin test`).
