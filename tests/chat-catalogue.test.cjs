const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { WebSocketServer } = require('../com.davidorn.copilot-status.sdPlugin/node_modules/ws');
const { sessionChats, watchDevTunnelSessions } = require('../com.davidorn.copilot-status.sdPlugin/agent-host.cjs');

async function fixture(t, rows, respond) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const monitor = new AbortController();
    const updates = [];
    const waiters = [];
    t.after(() => {
        monitor.abort();
        for (const client of server.clients) client.terminate();
        server.close();
    });
    await once(server, 'listening');
    let client;
    server.on('connection', socket => {
        client = socket;
        const send = message => socket.send(JSON.stringify(message));
        socket.on('message', frame => {
            const message = JSON.parse(frame);
            if (message.instanceId) send({ ok: true, selected: { type: 'editor', instanceId: 'test' } });
            if (message.method === 'initialize') send({ id: message.id, result: {} });
            if (message.method === 'listSessions') send({ id: message.id, result: { items: rows } });
            if (message.method === 'subscribe') respond(message, send);
        });
        send({ delegatedInstanceId: 'test', endpoints: [{ type: 'editor', instanceId: 'test' }] });
    });
    const watcher = watchDevTunnelSessions(sessions => {
        if (sessions) {
            updates.push(sessions.flatMap(sessionChats));
            for (const wake of waiters.splice(0)) wake();
        }
    }, monitor.signal, server.address().port);
    t.after(() => watcher);
    return {
        async until(predicate) {
            while (!updates.some(predicate)) await new Promise(resolve => waiters.push(resolve));
            return updates.find(predicate);
        },
        change(resource, changes) {
            client.send(JSON.stringify({ method: 'root/sessionSummaryChanged', params: {
                channel: 'ahp-root://', session: resource, changes,
            } }));
        },
        updates,
    };
}

function row(id, title = 'Session', chat = {}) {
    return { resource: `ahp-session:/${id}`, provider: 'copilotcli', title, status: 33,
        defaultChat: `ahp-chat:/${id}`, chats: [{ resource: `ahp-chat:/${id}`, title: '', ...chat }] };
}

function reply(message, send, state) {
    send({ id: message.id, result: { snapshot: { resource: message.params.channel,
        state: { resource: message.params.channel, title: '', status: 33,
            modifiedAt: '2026-11-17T15:00:00Z', turns: [], ...state } } } });
}

test('inspect every generic chat; preserve turns, drafts, canvases, changes, active work and failed lookups', { timeout: 5000 }, async t => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`empty-${i}`));
    rows.push(row('real', 'Indra sign-in spike canvas', { title: 'New session' }),
        row('unnamed-real'), row('draft'), row('attachment'), row('canvas'), row('running'),
        row('changes', 'Session', { changes: { files: 1 } }), row('failed'), row('partial'), row('mismatch'));
    const inspected = [];
    const f = await fixture(t, rows, (message, send) => {
        const id = message.params.channel.split('/').at(-1);
        inspected.push(id);
        if (id === 'failed') return send({ id: message.id, error: { code: -1, message: 'Unavailable' } });
        const states = {
            real: { title: 'New session', turns: [{}] },
            'unnamed-real': { turns: [{}] }, draft: { draft: { text: 'Unsent work' } },
            attachment: { draft: { text: '', attachments: [{}] } }, canvas: { canvases: [{}] },
            running: { status: 8 }, partial: { turns: undefined },
            mismatch: { resource: 'ahp-chat:/different' },
        };
        reply(message, send, states[id] ?? { draft: { text: '', origin: { kind: 'user' }, model: { id: 'model' } } });
    });
    const chats = await f.until(() => true);
    assert.equal(inspected.length, 22);
    assert.equal(chats.length, 10);
    assert.equal(f.updates.length, 1, 'no unverified placeholder keys on startup');
    assert.equal(chats.find(c => c.resource === 'ahp-chat:/real').title, 'Indra sign-in spike canvas');
    assert.equal(chats.find(c => c.resource === 'ahp-chat:/real').status, 33);
    assert.equal(chats.find(c => c.resource === 'ahp-chat:/draft').title, 'Unsent draft');
    assert.equal(chats.find(c => c.resource === 'ahp-chat:/unnamed-real').title, 'Untitled conversation');
    assert.equal(chats.find(c => c.resource === 'ahp-chat:/running').status, 8);
    assert.ok(chats.every(c => !('turns' in c) && !('draft' in c)), 'do not retain transcripts');
});

test('empty records reappear on activity and an old snapshot cannot hide newer work', { timeout: 5000 }, async t => {
    let reads = 0;
    let delayed;
    let secondRead;
    const waiting = new Promise(resolve => { secondRead = resolve; });
    const f = await fixture(t, [row('one')], (message, send) => {
        reads++;
        if (reads === 2) { delayed = () => reply(message, send, {}); secondRead(); }
        else reply(message, send, reads === 1 ? {} : { turns: [{}] });
    });
    await f.until(chats => chats.length === 0);
    f.change('ahp-session:/one', { modifiedAt: '2026-11-17T15:01:00Z' });
    await f.until(chats => chats.length === 1);
    await waiting;
    assert.ok(delayed);
    f.change('ahp-session:/one', { modifiedAt: '2026-11-17T15:02:00Z', chats: [
        { resource: 'ahp-chat:/one', title: '', status: 8 },
    ] });
    await f.until(chats => chats[0]?.status === 8);
    delayed();
    await f.until(chats => chats[0]?.status === 8 && reads === 3);
    assert.equal(f.updates.at(-1)[0].status, 8);
});

test('named chat missing status uses session snapshot metadata without reading its transcript', { timeout: 5000 }, async t => {
    const f = await fixture(t, [row('named', 'Parent', {
        title: 'Real chat', modifiedAt: '2026-11-17T15:00:00Z',
    })], (message, send) => {
        assert.equal(message.params.channel, 'ahp-session:/named');
        send({ id: message.id, result: { snapshot: { resource: message.params.channel,
            state: { chats: [{ resource: 'ahp-chat:/named', title: 'Real chat', status: 16 }] } } } });
    });
    assert.equal((await f.until(() => true))[0].status, 16);
});

test('slow chat inspection cannot block the initial catalogue indefinitely', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let subscribed;
    const requestReceived = new Promise(resolve => { subscribed = resolve; });
    let finish;
    const f = await fixture(t, [row('slow')], (message, send) => {
        finish = () => reply(message, send, {});
        subscribed();
    });
    await requestReceived;
    assert.equal(f.updates.length, 0);
    t.mock.timers.tick(3000);
    assert.equal((await f.until(chats => chats.length === 1))[0].title, 'Untitled conversation');
    finish();
    await f.until(chats => chats.length === 0);
});
