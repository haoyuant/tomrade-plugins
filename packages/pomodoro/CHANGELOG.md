# Changelog

## 0.1.2

- Loads again in Tomrade 0.12.0: 0.1.1 used the SDK's new `wordsFor`, which only a newer Tomrade has. It still reads Simplified Chinese when the app does, and English in any other language.

## 0.1.1

- Follows the app's language to the closest one it has words for, as Tomrade does, and reads English in any other language (Traditional Chinese, Japanese, a language pack…), where it used to show nothing.

## 0.1.0

- Pomodoro leaves the app and ships as one of Tomrade's own plugins: the status bar timer and its quick menu, the desktop widget, the notification and sound at the end of each phase, the Settings page, and the `pomodoro_status` / `pomodoro_control` tools, which now wait in a `pomodoro` kit until the assistant needs them. Settings saved by the built-in version carry over.
