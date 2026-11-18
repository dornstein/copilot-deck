$ErrorActionPreference = 'Stop'
# Same plugin-only URL used by Elgato's official CLI restart command:
# https://github.com/elgatosf/cli/blob/main/src/commands/restart.ts
if ((Get-ItemPropertyValue 'HKCU:/Software/Elgato Systems GmbH/StreamDeck' 'developer_mode' -ErrorAction SilentlyContinue) -ne 1) {
    throw 'Stream Deck developer mode must be enabled for plugin-only reloads.'
}
$deckBefore = @(Get-Process StreamDeck -ErrorAction Stop).Id
function Get-DeckPlugin {
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '^node' -and $_.CommandLine -like '*com.davidorn.copilot-status.sdPlugin*'
    }
}
$previousPluginIds = @(Get-DeckPlugin).ProcessId
Start-Process 'streamdeck://plugins/restart/com.davidorn.copilot-status' -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(20)
do {
    Start-Sleep -Milliseconds 500
    $replacement = @(Get-DeckPlugin | Where-Object { $_.ProcessId -notin $previousPluginIds })
    if ($replacement.Count) {
        if (@(Get-Process StreamDeck).Id | Where-Object { $_ -in $deckBefore }) {
            Write-Output "Reloaded Copilot Deck plugin (PID $($replacement[0].ProcessId)); Stream Deck stayed open."
            return
        }
        throw 'Plugin restarted, but the original Stream Deck process is no longer running.'
    }
} while ((Get-Date) -lt $deadline)
throw 'Stream Deck did not restart the plugin within 20 seconds.'
