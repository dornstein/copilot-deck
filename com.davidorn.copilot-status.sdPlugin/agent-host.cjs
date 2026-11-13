const { randomUUID } = require('node:crypto');
const { readdir, readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

const root = 'ahp-root://';
const status = { idle: 1, error: 2, running: 8, waiting: 16, read: 32, archived: 64 };
const tunnelProtocolVersions = ['1.0.0', '0.9.0'];
const tunnelKeepAliveMs = 10_000;

async function discoverEndpoints() {
    const endpoints = [];
    for (const product of ['Code', 'Code - Insiders']) {
        const directory = join(process.env.APPDATA, product, 'agent-host', 'local-endpoint', 'entries');
        const files = await readdir(directory).catch(() => []);
        for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
            try {
                const entry = JSON.parse(await readFile(join(directory, file), 'utf8'));
                if (entry.schemaVersion === 2 && entry.type === 'editor' && entry.endpoint?.type === 'socket'
                    && /^\\\\\.\\pipe\\vscode-agent-host-[\w.-]+$/.test(entry.endpoint.path)
                    && typeof entry.connectionToken === 'string'
                    && /^[\w-]+$/.test(entry.connectionToken) && /^\d+\.\d+\.\d+$/.test(entry.protocolVersion)) {
                    endpoints.push({ ...entry, urlProtocol: product === 'Code' ? 'vscode' : 'vscode-insiders' });
                }
            } catch {
                // A host can replace or remove its entry during discovery.
            }
        }
    }
    return endpoints;
}

function copilotSessions(sessions) {
    return Array.from(sessions.values())
        .filter((session) => /^copilot(?:cli)?$/.test(session.provider) && !(session.status & status.archived))
        .sort((left, right) => Number(new Date(right.modifiedAt)) - Number(new Date(left.modifiedAt)));
}

function sessionChats(session) {
    // Older hosts only send the session summary.
    if (!Array.isArray(session.chats)) return [session];
    return session.chats.filter((chat) => typeof chat?.resource === 'string'
        && chat.interactivity !== 'hidden' && !(chat.status & status.archived));
}

function sessionStatus(session) {
    if (!session) return 'No session';
    if (session.status === undefined) return 'Unknown';
    if (session.status & status.waiting) return 'Needs input';
    if (session.status & status.error) return 'Error';
    if (session.status & status.running) return 'Running';
    if (session.status & status.idle) return 'Idle';
    return 'Starting';
}

function isUnreadChat(chat) {
    return Number.isInteger(chat?.status) && (chat.status & status.read) === 0;
}

function followEndpoint(url, protocolVersions, publish, signal, throughTunnel = false) {
    const socket = new WebSocket(url, {
        handshakeTimeout: throughTunnel ? 10_000 : 2000,
        maxPayload: 8 * 1024 * 1024,
        family: throughTunnel ? 4 : undefined,
    });
    const sessions = new Map();
    const pendingChanges = [];
    const sessionTiming = new WeakMap();
    const timingRequests = new Map();
    const catalogueEvents = new Set(['root/sessionAdded', 'root/sessionRemoved', 'root/sessionSummaryChanged']);
    let listRequestId = 2;
    let timingRequestId = 0;
    let ready = false;
    let selecting = throughTunnel;
    let selectedId;
    let keepAlive;
    const deadline = setTimeout(() => socket.terminate(), throughTunnel ? 15_000 : 5000);
    const abort = () => socket.terminate();
    signal.addEventListener('abort', abort, { once: true });

    function request(id, method, parameters = {}) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { channel: root, ...parameters } }));
    }

    function initialize() {
        request(1, 'initialize', {
            clientId: randomUUID(),
            protocolVersions,
            initialSubscriptions: [root],
        });
    }

    function selectEditor(message) {
        if (selectedId) {
            if (message?.ok !== true || message.selected?.type !== 'editor'
                || message.selected.instanceId !== selectedId) {
                socket.terminate();
                return;
            }
            selecting = false;
            initialize();
            return;
        }

        // An editor-shared tunnel identifies the already-running host in its inventory.
        const instanceId = message?.delegatedInstanceId;
        if (typeof instanceId !== 'string' || !instanceId || !Array.isArray(message.endpoints)
            || !message.endpoints.some((entry) => entry?.type === 'editor' && entry.instanceId === instanceId)) {
            socket.terminate();
            return;
        }
        selectedId = instanceId;
        socket.send(JSON.stringify({ instanceId }));
    }

    function applyCatalogueEvent({ method, params }) {
        const { session, summary, changes } = params;
        switch (method) {
            case 'root/sessionAdded':
                if (summary?.resource) sessions.set(summary.resource, summary);
                break;
            case 'root/sessionRemoved':
                sessions.delete(session);
                break;
            case 'root/sessionSummaryChanged':
                if (sessions.has(session)) Object.assign(sessions.get(session), changes);
                break;
        }
    }

    function publishCatalogue() {
        const catalogue = copilotSessions(sessions).map((session) => {
            const chats = session.chats;
            if (!Array.isArray(chats) || !chats.length) return session;
            let timing = sessionTiming.get(session);
            if (!timing) {
                timing = { requested: new Set(), times: new Map() };
                sessionTiming.set(session, timing);
            }
            const missing = sessionChats(session).filter((chat) => sessionStatus(chat) === 'Idle'
                && !Number.isFinite(Date.parse(chat.modifiedAt)) && !timing.requested.has(chat.resource));
            if (missing.length && timingRequests.size < 4 && !timing.pending) {
                missing.forEach((chat) => timing.requested.add(chat.resource));
                timing.pending = true;
                const id = listRequestId + ++timingRequestId;
                const timeout = setTimeout(() => finishTimingRequest(id), 8_000);
                timingRequests.set(id, { channel: session.resource, timing, timeout });
                request(id, 'subscribe', { channel: session.resource });
            }
            return { ...session, chats: chats.map((chat) => {
                const idleModifiedAt = timing.times.get(chat?.resource);
                return idleModifiedAt ? { ...chat, idleModifiedAt } : chat;
            }) };
        });
        publish(catalogue);
    }

    function finishTimingRequest(id, snapshot) {
        const pending = timingRequests.get(id);
        if (!pending) return;
        const { channel, timing, timeout } = pending;
        clearTimeout(timeout);
        timingRequests.delete(id);
        timing.pending = false;
        if (socket.readyState !== WebSocket.OPEN) return;
        // Only session metadata is needed. Drop the subscription after its snapshot.
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'unsubscribe', params: { channel } }));
        if (snapshot?.resource === channel && Array.isArray(snapshot.state?.chats)) {
            for (const chat of snapshot.state.chats) {
                if (typeof chat?.resource === 'string' && Number.isFinite(Date.parse(chat.modifiedAt))) {
                    timing.times.set(chat.resource, chat.modifiedAt);
                }
            }
        }
        publishCatalogue();
    }

    if (!throughTunnel) socket.on('open', initialize);
    socket.on('error', () => {}); // The close event drives reconnection.
    socket.on('message', (frame) => {
        let message;
        try {
            message = JSON.parse(frame.toString());
        } catch {
            return;
        }

        if (selecting) {
            selectEditor(message);
            return;
        }
        if (!message || typeof message !== 'object') return;

        if (message.id === 1) {
            if (message.result) request(listRequestId, 'listSessions');
            else socket.terminate();
            return;
        }
        if (ready && timingRequests.has(message.id)) {
            finishTimingRequest(message.id, message.result?.snapshot);
            return;
        }
        if (!ready && message.id === listRequestId) {
            const catalogue = message.result?.items ?? message.result?.sessions;
            if (!Array.isArray(catalogue)) {
                socket.terminate();
                return;
            }
            for (const session of catalogue) {
                if (typeof session?.resource === 'string') sessions.set(session.resource, session);
            }
            if (message.result.nextCursor) {
                request(++listRequestId, 'listSessions', { cursor: message.result.nextCursor });
                return;
            }
            pendingChanges.forEach(applyCatalogueEvent);
            pendingChanges.length = 0;
            ready = true;
            clearTimeout(deadline);
            if (throughTunnel) {
                // Keep the relay open even when there are no catalogue updates.
                keepAlive = setInterval(() => {
                    if (socket.readyState === WebSocket.OPEN) socket.ping();
                }, tunnelKeepAliveMs);
            }
        } else {
            if (message.params?.channel !== root || !catalogueEvents.has(message.method)) return;
            if (!ready) {
                pendingChanges.push(message);
                return;
            }
            applyCatalogueEvent(message);
        }
        publishCatalogue();
    });

    return new Promise((resolve) => {
        socket.once('close', () => {
            clearTimeout(deadline);
            clearInterval(keepAlive);
            for (const { timeout } of timingRequests.values()) clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            resolve(ready);
        });
    });
}

async function watchCopilotSessions(publish, signal) {
    publish(null);
    while (!signal.aborted) {
        for (const entry of await discoverEndpoints()) {
            if (signal.aborted) return;
            const url = `ws+unix:${entry.endpoint.path}:/?tkn=${encodeURIComponent(entry.connectionToken)}`;
            if (await followEndpoint(url, [entry.protocolVersion], (catalogue) => publish(catalogue, entry.urlProtocol), signal)) {
                if (!signal.aborted) publish(null);
                break;
            }
        }
        await delay(2000, undefined, { signal }).catch(() => {});
    }
}

async function watchDevTunnelSessions(publish, signal, port = 31546) {
    const url = `ws://localhost:${port}/agent-host/select`;
    while (!signal.aborted) {
        const connected = await followEndpoint(url, tunnelProtocolVersions, publish, signal, true);
        if (connected && !signal.aborted) publish(null);
        await delay(5000, undefined, { signal }).catch(() => {});
    }
}

module.exports = { isUnreadChat, sessionChats, sessionStatus, watchCopilotSessions, watchDevTunnelSessions };
