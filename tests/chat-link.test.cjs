const assert = require('node:assert/strict');
const test = require('node:test');
const { chatLink } = require('../com.davidorn.copilot-status.sdPlugin/chat-link.cjs');

const sessionId = '33d49000-df61-4c35-853f-5b22b300d460';
const main = 'ahp-chat:/a8302ca8-5b78-4d11-8b62-20a1ecfddaff';
const nested = '16b10095-5308-4700-85c4-1dec713d7499';
const sessionResource = `ahp-session:/${sessionId}`;
const base = `agents/agent-host-session/ahp-session/${sessionId}`;

test('opens the main chat for local Stable and Insiders catalogs', () => {
    const chat = { sessionResource, defaultChat: main, resource: main };
    assert.equal(chatLink(chat), `vscode://${base}?connectionAuthority=local`);
    assert.equal(chatLink(chat, { urlProtocol: 'vscode-insiders' }), `vscode-insiders://${base}?connectionAuthority=local`);
});

test('routes a remote nested chat to the saved tunnel with its own ID', () => {
    const chat = { sessionResource, defaultChat: main, resource: `ahp-chat:/${nested}` };
    assert.equal(chatLink(chat, { tunnelId: 'example-tunnel.usw2' }),
        `vscode://${base}/chat/${nested}?connectionAuthority=tunnel__example-tunnel`);
});

test('preserves legacy session and chat IDs and rejects unsupported routes', () => {
    const sessionResource = `copilotcli:/${sessionId}`;
    const chat = { sessionResource, resource: 'ahp-chat://subagent/YWJj/call%2F1' };
    const base = `vscode://agents/agent-host-session/copilotcli/${sessionId}`;
    assert.equal(chatLink({ ...chat, resource: sessionResource }), `${base}?connectionAuthority=local`);
    assert.equal(chatLink({ ...chat, resource: 'ahp-chat://default/YWJj' }), `${base}?connectionAuthority=local`);
    assert.equal(chatLink(chat), `${base}/chat/subagent%252Fcall%252F1?connectionAuthority=local`);
    assert.equal(chatLink(chat, { tunnelId: 'remote?x' }), undefined);
    assert.equal(chatLink(chat, { urlProtocol: 'https' }), undefined);
    assert.equal(chatLink({ ...chat, sessionResource: 'file:/session' }), undefined);
});
