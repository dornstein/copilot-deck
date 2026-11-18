// Session provenance, not the agent provider or the app currently viewing it.
// Keep this allowlist exact: an unrecognized origin must not acquire an icon.
const applications = new Map([
    ['vscode', 'vscode'],
    ['vscode-editor-window', 'vscode'],
    ['github/autopilot', 'copilot'],
]);

function applicationForChat(session, chat) {
    const origin = chat?._meta?.['vscode.session.initiator']
        ?? session?._meta?.['vscode.session.initiator'];
    return applications.get(origin?.name);
}

module.exports = { applicationForChat };
