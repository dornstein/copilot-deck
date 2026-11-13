const { validTunnelId } = require('./tunnel-client.cjs');

function chatId(resource) {
    const opaque = /^ahp-chat:\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.exec(resource);
    if (opaque) return opaque[1];

    // Older Agent Hosts put the client chat ID in the URI authority.
    const shaped = /^ahp-chat:\/\/([\w-]+)\/([\w-]+)(?:\/([^?#]+))?$/.exec(resource);
    if (shaped) {
        const [, id, , toolCall] = shaped;
        if (id !== 'subagent' && id !== 'default' && !toolCall) return id;
        if (id === 'subagent' && toolCall) return `subagent/${decodeURIComponent(toolCall)}`;
    }
    return resource;
}

function chatLink(chat, { urlProtocol = 'vscode', tunnelId } = {}) {
    const session = /^(ahp-session|copilotcli|copilot):\/([\w-]+)$/.exec(chat.sessionResource);
    if (!session || !['vscode', 'vscode-insiders'].includes(urlProtocol)) return;
    if (tunnelId !== undefined && !validTunnelId(tunnelId)) return;

    const [, provider, sessionId] = session;
    let path = `/agent-host-session/${provider}/${sessionId}`;
    const defaultChat = chat.defaultChat === undefined
        ? chat.resource.startsWith('ahp-chat://default/')
        : chat.resource === chat.defaultChat;
    if (chat.resource !== chat.sessionResource && !defaultChat) {
        if (!chat.resource.startsWith('ahp-chat:')) return;
        try {
            path += `/chat/${encodeURIComponent(encodeURIComponent(chatId(chat.resource)))}`;
        } catch {
            return;
        }
    }

    // The CLI may qualify a tunnel ID with its cluster. VS Code uses the ID alone.
    const authority = tunnelId ? `tunnel__${tunnelId.split('.')[0]}` : 'local';
    return `${urlProtocol}://agents${path}?connectionAuthority=${encodeURIComponent(authority)}`;
}

module.exports = { chatLink };
