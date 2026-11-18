const { randomUUID } = require('node:crypto');
const { readdir, readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

const root = 'ahp-root://';
const status = { idle: 1, error: 2, running: 8, waiting: 16, read: 32, archived: 64 };
const tunnelProtocolVersions = ['1.0.0', '0.9.0'];
const tunnelKeepAliveMs = 10_000;

function genericTitle(title) {
    return typeof title !== 'string' || /^(?:session|new session|copilot)?$/i.test(title.trim());
}

function hasDraftContent(draft) {
    if (!draft) return false;
    if (typeof draft !== 'object') return true;
    // Model/origin alone are composer defaults, not an unsent message.
    return (typeof draft.text === 'string' ? !!draft.text.trim() : draft.text != null)
        || Object.entries(draft).some(([key, value]) =>
        !['text', 'origin', 'model'].includes(key) && value != null
        && (!Array.isArray(value) || value.length > 0));
}

function chatEvidence(state) {
    // Keep only metadata; never cache conversation text or attachments.
    return {
        title: state.title, status: state.status, modifiedAt: state.modifiedAt,
        hasDraft: hasDraftContent(state.draft),
        empty: sessionStatus(state) === 'Idle' && Array.isArray(state.turns) && state.turns.length === 0
            && !state.activeTurn && !hasDraftContent(state.draft)
            && (!state.canvases || (Array.isArray(state.canvases) && state.canvases.length === 0)),
    };
}

function hasChanges(changes) {
    return changes && Object.values(changes).some((value) => typeof value === 'number' && value > 0);
}

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
        && chat.interactivity !== 'hidden' && !(chat.status & status.archived) && !chat.deckEmpty)
        .map((chat) => ({ ...chat, title: !genericTitle(chat.title) ? chat.title
            : !genericTitle(session.title) ? session.title
                : chat.deckHasDraft ? 'Unsent draft' : 'Untitled conversation' }));
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

function followEndpoint(url, protocolVersions, publish, signal, throughTunnel = false, onConnected) {
    const socket = new WebSocket(url, {
        handshakeTimeout: throughTunnel ? 10_000 : 2000,
        maxPayload: 8 * 1024 * 1024,
        family: throughTunnel ? 4 : undefined,
    });
    const sessions = new Map();
    const pendingChanges = [];
    const sessionTiming = new WeakMap();
    const timingRequests = new Map();
    const evidence = new Map();
    const evidenceRequests = new Map();
    const catalogueEvents = new Set(['root/sessionAdded', 'root/sessionRemoved', 'root/sessionSummaryChanged']);
    let listRequestId = 2;
    let timingRequestId = 0;
    let ready = false;
    let selecting = throughTunnel;
    let selectedId;
    let keepAlive;
    let refreshEvidence;
    let published = false;
    let initialInspectionDeadline;
    let initialInspectionExpired = false;
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
        if (socket.readyState !== WebSocket.OPEN) return;
        const liveChats = new Set();
        const catalogue = copilotSessions(sessions).map((session) => {
            const chats = session.chats;
            if (!Array.isArray(chats) || !chats.length) return session;
            let timing = sessionTiming.get(session);
            if (!timing) {
                timing = { requested: new Set(), times: new Map() };
                sessionTiming.set(session, timing);
            }
            const missing = chats.filter((chat) => chat && !genericTitle(chat.title)
                && chat.interactivity !== 'hidden' && !(chat.status & status.archived)
                && (chat.status === undefined || (sessionStatus(chat) === 'Idle'
                    && !Number.isFinite(Date.parse(chat.modifiedAt)))) && !timing.requested.has(chat.resource));
            if (missing.length && timingRequests.size < 4 && !timing.pending) {
                missing.forEach((chat) => timing.requested.add(chat.resource));
                timing.pending = true;
                const id = listRequestId + ++timingRequestId;
                const timeout = setTimeout(() => finishTimingRequest(id), 8_000);
                timingRequests.set(id, { channel: session.resource, timing, timeout });
                request(id, 'subscribe', { channel: session.resource });
            }
            return { ...session, chats: chats.map((chat) => {
                if (!chat || typeof chat.resource !== 'string') return chat;
                liveChats.add(chat.resource);
                const idleModifiedAt = timing.times.get(chat?.resource);
                if (!genericTitle(chat.title) || chat.interactivity === 'hidden' || (chat.status & status.archived)) {
                    return { ...chat, status: chat.status ?? timing.details?.get(chat.resource)?.status,
                        idleModifiedAt };
                }
                const signature = JSON.stringify([session.modifiedAt, session.title, session.changes, chat]);
                let entry = evidence.get(chat.resource);
                if (!entry || entry.signature !== signature) {
                    entry = { signature };
                    evidence.set(chat.resource, entry);
                }
                if (!entry.pending && (!entry.checkedAt || Date.now() - entry.checkedAt > 60_000)
                    && evidenceRequests.size < 4
                    && !Array.from(evidenceRequests.values()).some(p => p.channel === chat.resource)) {
                    entry.pending = true;
                    const id = listRequestId + ++timingRequestId;
                    const timeout = setTimeout(() => finishEvidenceRequest(id), 20_000);
                    evidenceRequests.set(id, { channel: chat.resource, entry, timeout });
                    request(id, 'subscribe', { channel: chat.resource });
                }
                const details = entry.details;
                // A title alone is never evidence of emptiness. Active work and changes stay visible.
                const resolved = { ...chat, ...details, status: chat.status ?? details?.status,
                    idleModifiedAt: details?.modifiedAt ?? idleModifiedAt };
                return { ...resolved, deckHasDraft: details?.hasDraft,
                    deckEmpty: details?.empty === true && genericTitle(resolved.title)
                        && genericTitle(session.title) && sessionStatus(resolved) === 'Idle'
                        && !hasChanges(chat.changes) && !hasChanges(session.changes) };
            }) };
        });
        for (const resource of evidence.keys()) if (!liveChats.has(resource)) evidence.delete(resource);
        // Give fast inspections a chance to avoid placeholder flashes. Slow metadata must
        // never hold the connection or the entire board hostage; retain uncertain entries.
        if (!published && !initialInspectionExpired && (evidenceRequests.size || timingRequests.size)) return;
        published = true;
        clearTimeout(initialInspectionDeadline);
        publish(catalogue);
    }

    function finishEvidenceRequest(id, snapshot) {
        const pending = evidenceRequests.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        evidenceRequests.delete(id);
        pending.entry.pending = false;
        pending.entry.checkedAt = Date.now();
        if (snapshot?.resource === pending.channel && snapshot.state?.resource === pending.channel) {
            pending.entry.details = chatEvidence(snapshot.state);
        }
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'unsubscribe', params: { channel: pending.channel } }));
        publishCatalogue();
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
            timing.details ??= new Map();
            for (const chat of snapshot.state.chats) {
                timing.details.set(chat.resource, { status: chat.status });
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
        if (ready && evidenceRequests.has(message.id)) {
            finishEvidenceRequest(message.id, message.result?.snapshot);
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
            onConnected?.();
            initialInspectionDeadline = setTimeout(() => {
                initialInspectionExpired = true;
                publishCatalogue();
            }, 3000);
            refreshEvidence = setInterval(publishCatalogue, 30_000);
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
            clearTimeout(initialInspectionDeadline);
            clearInterval(keepAlive);
            clearInterval(refreshEvidence);
            for (const { timeout } of timingRequests.values()) clearTimeout(timeout);
            for (const { timeout } of evidenceRequests.values()) clearTimeout(timeout);
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

async function watchDevTunnelSessions(publish, signal, port = 31546, onConnected) {
    const url = `ws://localhost:${port}/agent-host/select`;
    while (!signal.aborted) {
        const connected = await followEndpoint(url, tunnelProtocolVersions, publish, signal, true, onConnected);
        if (connected && !signal.aborted) publish(null);
        await delay(5000, undefined, { signal }).catch(() => {});
    }
}

module.exports = { isUnreadChat, sessionChats, sessionStatus, watchCopilotSessions, watchDevTunnelSessions };
