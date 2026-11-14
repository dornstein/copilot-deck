# Copilot Status for Stream Deck

See which VS Code Copilot chats are running or waiting for you, and press a Stream Deck key to open the chat. The **Copilot Sessions** profile shows chats from this PC and from one remote machine connected through a Dev Tunnel.

## Install and get started

You need Windows 10 or later, Stream Deck 6.8 or later, and a version of VS Code or VS Code Insiders with the Agents window and Copilot harness.

1. Download `com.davidorn.copilot-status.streamDeckPlugin` and double-click it to install. [GitHub Releases](https://github.com/dornstein/copilot-deck/releases/latest)
2. In the Stream Deck desktop app, select **Copilot Sessions** from the profile picker. The bundled profile fits a 15-key layout. If it doesn’t appear, import `Copilot Sessions.streamDeckProfile` from `%APPDATA%\Elgato\StreamDeck\Plugins\com.davidorn.copilot-status.sdPlugin`.
3. Open the **Agents** window in VS Code and start or resume a chat using the **Copilot** harness. Leave VS Code running. The chat should appear on a key.

For a single status key on your own profile, add **Copilot → Copilot Session Status**. It follows the most recently updated local Copilot session.

## Use the keys

- **Tap a chat** to open it in VS Code’s Agents window. A blue pulse means the chat is running. A red pulse with a speech bubble means it needs input. On an idle chat, a blue dot means unread and the time shows how long the chat has been idle, when available.
- **Hold a chat key for about half a second and release** to see which machine it’s on, plus its workspace and chat type when available. Repeat to return to the title.
- **Press More** in the bottom-right corner to see the next page of chats. Each page has room for 13 chats. Matching colored triangles mark chats that belong to the same session.
- **Press Manage → Compact Chats** to close empty slots and bring the most recent chats to the first page. Otherwise, chats keep their keys as their status changes. Archiving a chat frees its key.

## Connect another machine

Remote chats use Dev Tunnels. Connect to the same tunnel in Stream Deck to see live status and in VS Code to open chats when you press a key.

1. **On the remote machine**, open the Agents window in the VS Code instance that owns your chats. Open the antenna menu, choose **Dev Tunnels**, and sign in. Leave the machine awake and VS Code running. [VS Code remote session guide](https://code.visualstudio.com/docs/agents/run/remote-agent-sessions#_make-a-host-available-for-remote-access)
2. **On the Stream Deck PC**, open the VS Code Agents window and choose the tunnel under **Dev Tunnels** in the environment picker. Open an existing chat to check that you can see the conversation.
3. **On the Stream Deck PC**, install Microsoft’s Dev Tunnels CLI if needed. Run `winget install Microsoft.devtunnel` in PowerShell.
4. **In the Stream Deck desktop app**, click the bottom-right **More** key on the **Copilot Sessions** profile to open its settings. Choose **Sign in with Microsoft (Entra)** or **Sign in with GitHub**, using the account that shared the tunnel. If you’re already signed in to the CLI, choose **Find tunnels**.
5. Select the tunnel or enter its ID, then choose **Connect**. Remote chats appear alongside local chats with a link icon. To forget the saved tunnel, choose **Disconnect** in the same settings.

## If something isn’t working

| What you see | What to check |
| --- | --- |
| **Offline** | The plugin can’t reach VS Code. Check that VS Code is open. For remote chats, check that the remote machine is awake and still sharing the tunnel. The plugin retries automatically. |
| **No session** | VS Code is connected. Start a Copilot chat or restore one from the archive. |
| **Remote Sign in** | Press the key and finish signing in through your browser. If sign-in stalls, use **Cancel sign-in** in the **More** key’s settings and try again. |
| A remote key shows the title, but tapping it doesn’t open the chat | Connect to the same tunnel in the VS Code Agents window on the Stream Deck PC. |

## Appendix for developers

### Run from a checkout

The plugin runs on Stream Deck’s bundled Node.js 20 runtime. From the repository root, use Elgato’s `streamdeck` CLI to link the plugin.

```powershell
npm.cmd ci --prefix .\com.davidorn.copilot-status.sdPlugin --omit=optional --ignore-scripts
streamdeck link .\com.davidorn.copilot-status.sdPlugin
```

With Developer Mode on, run `streamdeck restart com.davidorn.copilot-status` after an edit. With Developer Mode off, quit and reopen Stream Deck. To run the tests in PowerShell, use `node --test (Get-ChildItem tests -Filter '*.test.cjs').FullName`.

### How it works

`agent-host.cjs` finds the local Agent Host in the default VS Code and Insiders locations and subscribes to session updates. `tunnel-client.cjs` runs Microsoft’s Dev Tunnels CLI in the background for remote sessions. Stream Deck saves the tunnel ID and sign-in provider. The CLI manages its own credentials.

`session-board.cjs` assigns chats to keys for as long as the plugin is running. `plugin.cjs` draws the keys and handles presses. `chat-link.cjs` builds the VS Code link for the selected chat.

### Build and release

Run `python scripts/build-profile.py` after changing the bundled layout or the plugin version. Commit the updated profile with the change.

GitHub Actions runs the tests and packages the Windows installer on pull requests and pushes to `main`. To publish a release, update the manifest version, rebuild and commit the profile, and push a matching tag such as `v0.2.0.0`. The tagged build attaches the installer to a GitHub Release.
