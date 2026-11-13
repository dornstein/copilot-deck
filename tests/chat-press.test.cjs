const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const childProcess = require('node:child_process');

const pluginPath = '../com.davidorn.copilot-status.sdPlugin';
const agentHost = require(pluginPath + '/agent-host.cjs');
const tunnelClient = require(pluginPath + '/tunnel-client.cjs');
const actionPrefix = 'com.davidorn.copilot-status';

test('chat keys toggle details, open on tap, and show age while idle on the front', async (t) => {
    let clock = 0;
    t.mock.method(performance, 'now', () => clock);
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-11-13T18:12:00Z') });
    const open = t.mock.method(childProcess, 'execFile', (_file, _args, _options, callback) => callback());
    const output = [];
    class DeckSocket extends EventEmitter {
        static OPEN = 1;
        readyState = DeckSocket.OPEN;
        send(frame) { output.push(JSON.parse(frame)); }
    }
    const socket = new DeckSocket();
    const wsPath = require.resolve(pluginPath + '/node_modules/ws');
    const originalWs = require.cache[wsPath].exports;
    require.cache[wsPath].exports = class extends DeckSocket { constructor() { super(); return socket; } };
    const originalArgv = process.argv;
    process.argv = [...originalArgv, '-port', '12345', '-pluginUUID', 'plugin', '-registerEvent', 'registerPlugin'];
    const plugin = require.resolve(pluginPath + '/plugin.cjs');
    t.after(() => {
        socket.emit('close');
        require.cache[wsPath].exports = originalWs;
        process.argv = originalArgv;
        delete require.cache[plugin];
    });

    let updateLocal;
    let updateRemote;
    t.mock.method(agentHost, 'watchCopilotSessions', async (publish) => { updateLocal = publish; });
    t.mock.method(tunnelClient, 'watchManagedTunnel', async (_id, publish) => { updateRemote = publish; });
    t.mock.method(tunnelClient, 'listTunnels', async () => [{ id: 'deck-host', name: 'Work PC' }]);
    require(plugin);
    socket.emit('open');

    const send = (event, data) => socket.emit('message', JSON.stringify({ event, ...data }));
    const key = (event, context, slot, device = 'deck') => send(event, {
        context, action: actionPrefix + '.slot', device, payload: { settings: { slot } },
    });
    const image = (context) => decodeURIComponent(output.findLast((message) =>
        message.context === context && message.event === 'setImage').payload.image);
    const labels = (context) => Array.from(image(context).matchAll(/<text[^>]*>(.*?)<\/text>/g), ([, label]) => label).join(' ');

    const local = { resource: 'ahp-session:/local', title: 'Local title', status: 33 };
    const main = {
        resource: 'ahp-chat://default/remote', title: 'Remote main', status: 1,
        idleModifiedAt: '2026-11-13T18:00:00Z',
    };
    const nested = {
        resource: 'ahp-chat://nested/remote', title: 'Remote nested', status: 40,
        origin: { kind: 'sideChat' }, changes: { additions: 12, deletions: 3 },
    };
    const remote = {
        resource: 'ahp-session:/remote', project: { displayName: 'App & repo' },
        modifiedAt: '2026-11-13T18:00:00Z', defaultChat: main.resource, chats: [main, nested],
    };
    updateLocal([local], 'vscode-insiders');
    send('didReceiveGlobalSettings', { payload: { settings: { tunnelId: 'deck-host' } } });
    await Promise.resolve();
    updateRemote([remote]);
    key('willAppear', 'local', 0);
    key('willAppear', 'main', 1);
    key('willAppear', 'nested', 2);
    key('willAppear', 'manage', 10);

    assert.equal(labels('main'), '12m Remote main');
    assert.match(image('main'), /<circle cx="8" cy="7"/);
    assert.match(image('main'), /<path d="M9 7H7/);
    t.mock.timers.tick(60_000);
    assert.equal(labels('main'), '13m Remote main');

    key('keyDown', 'local', 0);
    assert.equal(open.mock.callCount(), 0);
    clock += 549;
    key('keyUp', 'local', 0);
    assert.match(open.mock.calls[0].arguments[2].env.COPILOT_DECK_CHAT_URL, /^vscode-insiders:.*\/local\?/);

    key('keyDown', 'nested', 2);
    clock += 550;
    assert.equal(labels('nested'), 'Remote nested');
    assert.match(image('nested'), /<path d="M9 7H7/);
    key('keyUp', 'nested', 2);
    assert.equal(labels('nested'), 'Work PC App &amp; repo Side chat');
    assert.doesNotMatch(image('nested'), /<path/);
    assert.equal(labels('local'), 'Local title');
    assert.equal(open.mock.callCount(), 1);
    updateRemote([{ ...remote, chats: [main, { ...nested, status: 16 }] }]);
    assert.equal(labels('nested'), 'Work PC App &amp; repo Side chat');

    key('keyDown', 'nested', 2);
    key('keyUp', 'nested', 2);
    assert.match(open.mock.calls[1].arguments[2].env.COPILOT_DECK_CHAT_URL, /\/remote\/chat\/nested\?/);
    assert.equal(labels('nested'), 'Work PC App &amp; repo Side chat');

    key('keyDown', 'nested', 2);
    clock += 550;
    key('keyUp', 'nested', 2);
    assert.equal(labels('nested'), 'Remote nested');
    assert.match(image('nested'), /<path d="M21 11\.5/);
    assert.equal(open.mock.callCount(), 2);

    key('keyDown', 'nested', 2);
    key('keyDown', 'manage', 10);
    key('keyDown', 'manage', 10);
    clock += 550;
    key('keyUp', 'nested', 2);
    assert.equal(labels('nested'), 'Remote nested');

    key('keyDown', 'local', 0);
    clock += 550;
    key('keyUp', 'local', 0);
    assert.equal(labels('local'), 'This PC Main chat');
    updateLocal([{ ...local, resource: 'ahp-session:/replacement', title: 'New chat' }], 'vscode-insiders');
    assert.equal(labels('local'), 'New chat');

    key('keyDown', 'local', 0);
    send('deviceDidDisconnect', { device: 'deck' });
    key('willAppear', 'local', 0);
    key('keyUp', 'local', 0);
    assert.equal(open.mock.callCount(), 2);

    updateRemote([{ ...remote, chats: [main, { ...nested, status: 33 }] }]);
    key('willAppear', 'nested', 2);
    assert.equal(labels('nested'), '&lt;1m Remote nested');
    t.mock.timers.tick(60_000);
    assert.equal(labels('nested'), '1m Remote nested');
    t.mock.timers.setTime(Date.parse('2026-11-14T03:00:00Z'));
    key('willAppear', 'main', 1);
    assert.equal(labels('main'), '9h Remote main');
    t.mock.timers.setTime(Date.parse('2026-11-19T18:00:00Z'));
    key('willAppear', 'main', 1);
    assert.equal(labels('main'), '6d Remote main');
});
