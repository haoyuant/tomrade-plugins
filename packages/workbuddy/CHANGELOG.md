# Changelog

## 0.2.2

- The CodeBuddy edition picked in Tomrade (international or China) is written into CodeBuddy's own settings as well as the session, so its sign-in and a later run in a terminal use the same edition. A settings file that cannot be read is left alone. Reads Tomrade's settings for that pick.

## 0.2.1

- Set up installs the CodeBuddy CLI in one click: Tomrade runs the npm install itself (the system's npm, or its own when there is none), then opens a terminal for the `/login` and watches it. Needs Tomrade with plugin SDK 0.2.26.

## 0.2.0

- Ready only with the CodeBuddy CLI itself. The copy inside the WorkBuddy app gets no models when started on its own, so Tomrade no longer uses it: with only the app installed, the agent shows as not ready ("only the desktop app is installed") and says to install the CLI with `npm install -g @tencent-ai/codebuddy-code` and sign in with `/login`, instead of a session failing with "model not found".
- Named "CodeBuddy (WorkBuddy)" in Settings, setup and the model pick, so it is clear that it runs on the CodeBuddy CLI. Settings, the connection and past sessions keep the id `workbuddy`.
- Setup names the CodeBuddy CLI's installation page as its official download and says the WorkBuddy app does not include the CLI (SDK 0.2.25 `setup.download` and `setup.desktop`; an older Tomrade ignores them).

## 0.1.0

- WorkBuddy as a local agent, moved out of the Tomrade app: conversations and tickets over `codebuddy --acp` with Tomrade's tools (also the CLI inside the WorkBuddy app, on macOS and Windows), mid-turn messages through `session/steer`, a ticket handed to `codebuddy` in a terminal, its own sessions connected with `codebuddy mcp add --scope user`, and `codebuddy -p` answering Tomrade's background calls. Settings, connection and sessions carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
