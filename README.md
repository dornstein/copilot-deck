# Copilot Status for Stream Deck

## Install

Download `com.davidorn.copilot-status.streamDeckPlugin` from [GitHub Releases](https://github.com/dornstein/copilot-deck/releases/latest) and double-click it to install. The plugin requires Windows 10 or later, Stream Deck 6.8 or later, and a version of VS Code with the Copilot Agent Host. Select **Copilot Sessions** in Stream Deck after installation.

## Use the profile

**Copilot Sessions** is a bundled profile for the standard 15-key Stream Deck. Select it in the profile picker or open `Copilot Sessions.streamDeckProfile` from the plugin folder to import it once. Thirteen keys show main and nested chats, one per key. The bottom-right **More** key cycles through chat banks, and the bottom-left **Manage** key switches to commands.

Tap a chat key to open that chat in VS Code's Agents window on this PC. For a remote chat, connect to the same tunnel once in the Agents window so VS Code can find the remote session when it opens.

Hold a chat key for about half a second, then release to flip it to its details. The details stay visible until you long-press again or the chat leaves the key. The back shows **This PC** or the remote tunnel's name, plus the workspace and chat type when available. If the tunnel name is unavailable, the back shows **Remote**.

Chat titles wrap and use smaller text as needed. A key pulses blue while its chat is running and red with a speech bubble while it needs input. The upper-left corner shows a warning triangle for an error, an hourglass for starting, a plug for offline, and a question mark for unknown status. An idle chat shows a blue dot when unread and its idle age along the top when available. The age starts at the observed transition to idle or uses the chat's last modification time for chats that were already idle.

Chats fill empty slots when they appear and keep the same key as their title, status, or activity changes. Archived or removed chats free their slots. Slot assignments stay in memory for the lifetime of the plugin.

Press **Manage**, then **Compact Chats** at the top left to close gaps, sort by most recent activity, and return to the first chat bank. When a chat has no timestamp, the sort uses its session’s last update. **Back to Chats** returns to your current bank.

When a remote tunnel requires sign-in, its chats are hidden and **Manage** becomes **Remote Sign in**. Press it and finish signing in through your browser. The key uses your last successful sign-in provider, with GitHub as the default for existing setups. The plugin reconnects to the saved tunnel and restores the chats and **Manage** when the remote Agent Host responds. You can cancel a pending sign-in in the **More** key's settings.

When a session has two or more chats on the profile, their keys share a colored triangle in the bottom-right corner, even across banks. The triangle disappears when only one chat from that session is on the profile.

Keep VS Code open and use the **Copilot** harness. The keys follow unarchived sessions from the connected local VS Code desktop Agent Host and reconnect when the host restarts. The separate **Copilot → Copilot Session Status** action continues to follow the most recently updated session.

## Remote sessions over Dev Tunnels

1. On the remote machine, open the Agents window in the VS Code instance that has your sessions. Choose **Remote Connections → Dev Tunnels**, sign in, and leave VS Code running.
2. On the home PC, choose **Dev Tunnels** from the Agents window's environment picker. Connect to the remote tunnel and open an existing session to confirm it shows the original conversation.
3. On the home PC, install Microsoft's Dev Tunnels CLI with `winget install Microsoft.devtunnel` if needed. In the **Stream Deck desktop app**, select **Copilot Sessions** and click the bottom-right **More** key to open its settings.
4. Choose **Sign in with Microsoft (Entra)** or **Sign in with GitHub** and use the same account that shared the tunnel. If sign-in stalls, choose **Cancel sign-in** to try again. If the CLI is already signed in, choose **Find tunnels**. Select the remote tunnel or enter its tunnel ID, then choose **Connect**.

The plugin saves the tunnel ID in Stream Deck's settings and starts the CLI in the background. The CLI keeps its own sign-in in the Windows credential store. The plugin selects the editor Agent Host shared by the remote machine and subscribes to its live session summaries. Remote chats appear alongside local chats with a small link icon in the upper-right corner. If the tunnel goes offline, their titles dim and the offline icon appears. The plugin retries the connection automatically. Use **More** to reach later banks, and **Disconnect** in its settings to forget the tunnel.

## Local development

The plugin targets Stream Deck 6.8 with its bundled Node.js 20 runtime. The JavaScript runs directly. From this folder, install its dependency and link the plugin with Elgato’s CLI if you need to recreate the local setup.

```powershell
npm.cmd ci --prefix .\com.davidorn.copilot-status.sdPlugin --omit=optional --ignore-scripts
streamdeck link .\com.davidorn.copilot-status.sdPlugin
streamdeck restart com.davidorn.copilot-status
```

With Stream Deck Developer Mode enabled, reload the plugin after an edit with `streamdeck restart com.davidorn.copilot-status` or `Start-Process 'streamdeck://plugins/restart/com.davidorn.copilot-status'`. With Developer Mode off, quit and reopen Stream Deck to reload the linked plugin.

Run `python scripts/build-profile.py` after changing the bundled layout or plugin version. The profile archive is included in the plugin directory.

GitHub Actions runs the tests and packages a downloadable Windows installer on pull requests and pushes to `main`. To publish a release, update the manifest version, rebuild and commit the profile, and push a matching tag such as `v0.2.0.0`. A successful tagged build attaches the installer to a GitHub Release.

`agent-host.cjs` discovers Stable and Insiders editor endpoints in their default Windows locations, reads session summaries, and listens for updates. `session-board.cjs` keeps track of which session belongs in each slot, and `plugin.cjs` registers with Stream Deck and renders the visible keys. **Offline** means the plugin is waiting for an accessible editor Agent Host. **No session** means the connected host has no unarchived Copilot session.
