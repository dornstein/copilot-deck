const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { WebSocketServer } = require('../com.davidorn.copilot-status.sdPlugin/node_modules/ws');
const { sessionChats, sessionStatus, watchDevTunnelSessions } = require('../com.davidorn.copilot-status.sdPlugin/agent-host.cjs');

test('Dev Tunnel reads per-chat idle timestamps and follows chat-only status updates', { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const monitor = new AbortController();
    t.after(() => {
        monitor.abort();
        for (const client of server.clients) client.terminate();
        server.close();
    });
    await once(server, 'listening');

    const updates = [];
    const times = [];
    let catalogueReady;
    const initialCatalogue = new Promise((resolve) => { catalogueReady = resolve; });
    const watcher = watchDevTunnelSessions((sessions) => {
        updates.push(sessions?.flatMap(sessionChats).map(sessionStatus) ?? null);
        if (sessions) times.push(sessions.flatMap(sessionChats).map((chat) => chat.idleModifiedAt));
        if (updates.length === 1) catalogueReady();
        if (updates.length === 3) client.close();
        if (!sessions) monitor.abort();
    }, monitor.signal, server.address().port);
    const [client, upgrade] = await once(server, 'connection', { signal: t.signal });
    const receive = async () => JSON.parse((await once(client, 'message', { signal: t.signal }))[0]);
    const send = (message) => client.send(JSON.stringify(message));

    assert.equal(upgrade.url, '/agent-host/select');
    assert.equal(upgrade.headers.host, `localhost:${server.address().port}`);
    send({
        delegatedInstanceId: 'editor-1',
        endpoints: [{ type: 'editor', instanceId: 'editor-1' }],
    });
    assert.deepEqual(await receive(), { instanceId: 'editor-1' });
    send({ ok: true, selected: { type: 'editor', instanceId: 'editor-1' } });
    const initialize = await receive();
    assert.equal(initialize.method, 'initialize');
    assert.deepEqual(initialize.params.initialSubscriptions, ['ahp-root://']);
    send({ id: initialize.id, result: { protocolVersion: '1.0.0' } });
    const list = await receive();
    assert.equal(list.method, 'listSessions');
    const main = { resource: 'ahp-chat:/main', title: 'Main chat', status: 33 };
    const nested = { resource: 'ahp-chat:/nested', title: 'Nested chat', status: 40 };
    send({ id: list.id, result: { items: [
        { resource: 'ahp-session:/one', provider: 'copilotcli', status: 40, defaultChat: main.resource, chats: [main, nested] },
        { resource: 'ahp-session:/archived', provider: 'copilotcli', status: 64 },
    ] } });
    await initialCatalogue;
    const timing = await receive();
    assert.equal(timing.method, 'subscribe');
    assert.equal(timing.params.channel, 'ahp-session:/one');
    const modifiedAt = '2026-11-12T23:30:00Z';
    send({ id: timing.id, result: { snapshot: {
        resource: timing.params.channel, state: { chats: [{ ...main, modifiedAt }, nested] },
    } } });
    const unsubscribe = await receive();
    assert.equal(unsubscribe.method, 'unsubscribe');
    assert.equal(unsubscribe.params.channel, timing.params.channel);
    const keepAlive = once(client, 'ping', { signal: t.signal });
    t.mock.timers.tick(10_000);
    await keepAlive;
    send({
        method: 'root/sessionSummaryChanged',
        params: { channel: 'ahp-root://', session: 'ahp-session:/one', changes: { chats: [main, { ...nested, status: 16 }] } },
    });
    await watcher;
    assert.deepEqual(updates, [['Idle', 'Running'], ['Idle', 'Running'], ['Idle', 'Needs input'], null]);
    assert.deepEqual(times, [[undefined, undefined], [modifiedAt, undefined], [modifiedAt, undefined]]);
});
