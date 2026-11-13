const { execFile } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const WebSocket = require('ws');
const { isUnreadChat, sessionChats, sessionStatus, watchCopilotSessions } = require('./agent-host.cjs');
const { chatLink } = require('./chat-link.cjs');
const { SessionBoard, slotsPerBank } = require('./session-board.cjs');
const { chatDetailsImage, isPulsingStatus, sessionKeyImage } = require('./session-key.cjs');
const { listTunnels, signIn, validTunnelId, watchManagedTunnel } = require('./tunnel-client.cjs');

const pluginId = 'com.davidorn.copilot-status';
const actions = { latest: `${pluginId}.session`, slot: `${pluginId}.slot`, more: `${pluginId}.more` };
const actionIds = new Set(Object.values(actions));
// The existing profile numbers its fourteen slot actions left to right.
const modeSlot = 10;
const compactSlot = 0;
const chatHoldMs = 550;
const idleAgeRefreshMs = 15_000;
const signInProviders = new Set(['github', 'microsoft']);
const arguments_ = process.argv.slice(2);
function argument(name) {
    const index = arguments_.indexOf(name);
    return index < 0 ? undefined : arguments_[index + 1];
}

const port = Number(argument('-port'));
const uuid = argument('-pluginUUID');
const registration = argument('-registerEvent');
if (!Number.isInteger(port) || port < 1 || port > 65535 || !uuid || !registration) {
    throw new Error('Launch this plugin from the Stream Deck desktop app.');
}

const labels = {
    Idle: 'Idle',
    Running: 'Running',
    'Needs input': 'Needs\ninput',
    Error: 'Error',
    Starting: 'Starting',
    Unknown: 'Unknown',
    'No session': 'No\nsession',
    Offline: 'Offline',
};
const images = {
    Idle: 'idle', Running: 'running', Error: 'error',
    Starting: 'running', Unknown: 'offline', 'No session': 'offline', Offline: 'offline',
};
const keyImages = Object.fromEntries(Array.from(new Set(['empty', ...Object.values(images)]), (name) => [
    name,
    `data:image/png;base64,${readFileSync(join(__dirname, 'images', `${name}.png`)).toString('base64')}`,
]));
const visibleKeys = new Map();
const pulsingKeys = new Map();
const board = new SessionBoard();
const deviceBanks = new Map();
const devicesInManagementMode = new Set();
const monitor = new AbortController();
const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 5000 });
const local = { source: 'local', connected: false, chats: [], latestSession: undefined };
const remoteHost = { source: 'remote', connected: false, chats: [] };
let pulseTimer;
let idleAgeTimer;
let tunnelId = '';
let tunnelProvider = 'github';
let tunnelMonitor;
let tunnelTask = Promise.resolve();
let tunnelStatus = 'Choose a remote tunnel.';
let tunnelRecovery;
let inspectorContext;
let inspectorOperation;
let inspectorNotice = '';
let tunnels = [];

function displayFor(key, chat) {
    if (key.action === actions.latest) {
        const status = local.connected ? sessionStatus(local.latestSession) : 'Offline';
        return {
            title: labels[status],
            image: images[status],
            status: status === 'Needs input' ? status : undefined,
            log: `Copilot Status key updated to ${status}`,
        };
    }

    const managing = devicesInManagementMode.has(key.device);
    if (key.action === actions.slot && key.slot === modeSlot) {
        if (tunnelRecovery === 'sign-in-required') {
            const signingIn = Boolean(inspectorOperation?.provider);
            return { title: '', chatTitle: signingIn ? 'Finish in browser' : 'Remote Sign in', status: 'Sign in' };
        }
        if (tunnelRecovery === 'connecting') {
            return { title: '', chatTitle: 'Remote connecting', status: 'Starting' };
        }
        if (tunnelRecovery === 'offline') {
            return { title: '', chatTitle: 'Remote offline', status: 'Offline' };
        }
        return { title: managing ? 'Back to\nChats' : 'Manage', image: 'empty' };
    }
    if (managing) {
        const title = key.action === actions.slot && key.slot === compactSlot ? 'Compact\nChats' : '';
        return { title, image: 'empty' };
    }

    const bank = deviceBanks.get(key.device) ?? 0;
    if (key.action === actions.more) {
        const title = board.bankCount > 1 ? `More\n${bank + 1}/${board.bankCount}` : 'More';
        return { title, image: 'empty' };
    }

    if (chat) {
        const remote = chat.source === remoteHost.source;
        if (key.detailsChat) {
            return { title: '', image: chatDetailsImage(chat, { remote, tunnelName: remoteHost.name }) };
        }
        const status = (remote ? remoteHost : local).connected ? sessionStatus(chat) : 'Offline';
        return {
            title: '',
            image: images[status],
            chatTitle: typeof chat.title === 'string' ? chat.title : 'Copilot',
            remote,
            status,
            unread: status === 'Idle' && isUnreadChat(chat),
            idleSince: status === 'Idle' ? chat.idleSince : undefined,
            groupColor: board.groupColorFor(chat),
            log: `Copilot Sessions bank ${bank + 1} slot ${key.slot + 1} updated to ${status}`,
        };
    }

    if (!tunnelRecovery && bank === 0 && key.slot === 0 && !local.chats.length && !remoteHost.chats.length) {
        const status = local.connected || remoteHost.connected ? 'No session' : 'Offline';
        return { title: labels[status], image: images[status] };
    }
    return { title: '', image: 'empty' };
}

function sendImage(key, context) {
    const { image, chatTitle, status, pulseStart, remote, unread, groupColor, idleAge } = key;
    const elapsed = pulseStart === undefined ? 0 : performance.now() - pulseStart;
    const renderedImage = chatTitle !== undefined || pulseStart !== undefined
        ? sessionKeyImage(chatTitle, status, elapsed, { remote, unread, groupColor, idleAge })
        : keyImages[image] ?? image;
    socket.send(JSON.stringify({
        event: 'setImage', context, payload: { image: renderedImage, target: 0 },
    }));
}

function formatIdleAge(since, now) {
    if (!Number.isFinite(since)) return;
    const minutes = Math.max(0, Math.floor((now - since) / 60_000));
    if (minutes === 0) return '<1m';
    if (minutes < 60) return minutes + 'm';
    if (minutes < 1440) return Math.floor(minutes / 60) + 'h';
    return Math.floor(minutes / 1440) + 'd';
}

function refreshIdleAges() {
    if (socket.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    for (const [context, key] of visibleKeys) {
        const age = formatIdleAge(key.idleSince, now);
        if (key.idleAge === age) continue;
        key.idleAge = age;
        sendImage(key, context);
    }
}

function pulseNextKey() {
    if (socket.readyState !== WebSocket.OPEN) return;
    const [context, key] = pulsingKeys.entries().next().value;
    pulsingKeys.delete(context);
    pulsingKeys.set(context, key);
    sendImage(key, context);
}

function stopPulsing(context) {
    pulsingKeys.delete(context);
    if (pulsingKeys.size === 0) {
        clearInterval(pulseTimer);
        pulseTimer = undefined;
    }
}

function render(key, context) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const chat = chatAtKey(key);
    if (key.press && !sameChat(key.press.chat, chat)) key.press = undefined;
    if (key.detailsChat && !sameChat(key.detailsChat, chat)) key.detailsChat = undefined;
    const { title, image, chatTitle, status, remote, unread, groupColor, idleSince, log } = displayFor(key, chat);
    key.idleSince = idleSince;
    const idleAge = formatIdleAge(idleSince, Date.now());
    if (title === key.title && image === key.image && chatTitle === key.chatTitle
        && status === key.status && remote === key.remote && unread === key.unread
        && groupColor === key.groupColor && idleAge === key.idleAge) return;
    key.title = title;
    key.image = image;
    key.chatTitle = chatTitle;
    key.status = status;
    key.remote = remote;
    key.unread = unread;
    key.groupColor = groupColor;
    key.idleAge = idleAge;
    if (isPulsingStatus(status)) {
        key.pulseStart ??= performance.now();
        pulsingKeys.set(context, key);
        // Share the frame budget across all visible pulsing keys.
        pulseTimer ??= setInterval(pulseNextKey, 125);
    } else {
        key.pulseStart = undefined;
        stopPulsing(context);
    }
    sendImage(key, context);
    socket.send(JSON.stringify({
        event: 'setTitle', context, payload: { title, target: 0 },
    }));
    if (log) socket.send(JSON.stringify({ event: 'logMessage', payload: { message: log } }));
}

function updateSource(source, catalogue, urlProtocol) {
    const previousChats = new Map(source.connected ? source.chats.map((chat) => [chat.resource, chat]) : []);
    source.connected = catalogue !== null;
    if (catalogue) {
        if (source === local) local.latestSession = catalogue[0];
        if (source === remoteHost) tunnelRecovery = undefined;
        const now = Date.now();
        source.chats = catalogue.flatMap((session) => sessionChats(session).map((chat) => ({
            ...chat,
            source: source.source,
            urlProtocol,
            sessionResource: session.resource,
            defaultChat: session.defaultChat,
            sessionModifiedAt: session.modifiedAt,
            projectName: session.project?.displayName,
            sessionWorkingDirectory: session.workingDirectories?.[0] ?? session.workingDirectory,
            idleSince: chatIdleSince(chat, previousChats.get(chat.resource), now),
        })));
    }
    board.update(tunnelRecovery ? local.chats : [...local.chats, ...remoteHost.chats]);
    renderBoard();
}

function chatIdleSince(chat, previous, now) {
    if (sessionStatus(chat) !== 'Idle') return;
    const previousStatus = previous && sessionStatus(previous);
    if (previousStatus === 'Idle' && Number.isFinite(previous.idleSince)) return previous.idleSince;
    if (previousStatus && previousStatus !== 'Unknown' && previousStatus !== 'Idle') return now;
    const modifiedAt = Date.parse(chat.modifiedAt);
    return Number.isFinite(modifiedAt) ? modifiedAt : Date.parse(chat.idleModifiedAt);
}

function renderBoard() {
    for (const [device, bank] of deviceBanks) {
        if (bank >= board.bankCount) deviceBanks.set(device, board.bankCount - 1);
    }
    visibleKeys.forEach(render);
}

function chatAtKey(key) {
    if (key.action !== actions.slot || key.slot === modeSlot || devicesInManagementMode.has(key.device)) return;
    const slot = key.slot > modeSlot ? key.slot - 1 : key.slot;
    return board.sessionAt(deviceBanks.get(key.device) ?? 0, slot);
}

function sameChat(previous, current) {
    return current && previous.source === current.source
        && previous.resource === current.resource && previous.sessionResource === current.sessionResource;
}

function openChat(chat, context) {
    const url = chatLink(chat, {
        urlProtocol: chat.urlProtocol,
        tunnelId: chat.source === remoteHost.source ? tunnelId : undefined,
    });
    const showAlert = () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event: 'showAlert', context }));
    };
    if (!url) return showAlert();

    // Open the registered Windows URI handler directly, without a browser redirect.
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:COPILOT_DECK_CHAT_URL -ErrorAction Stop'],
        { windowsHide: true, env: { ...process.env, COPILOT_DECK_CHAT_URL: url }, timeout: 10_000 },
        (error) => { if (error) showAlert(); });
}

function handleKeyDown(key) {
    const { action, device, slot } = key;
    const managing = devicesInManagementMode.has(device);
    if (action === actions.slot && slot === modeSlot) {
        if (tunnelRecovery) {
            if (tunnelRecovery === 'sign-in-required') void refreshTunnels(tunnelProvider, true);
            return;
        }
        if (managing) devicesInManagementMode.delete(device);
        else devicesInManagementMode.add(device);
    } else if (managing && action === actions.slot && slot === compactSlot) {
        board.compact();
        deviceBanks.delete(device);
        devicesInManagementMode.delete(device);
        renderBoard();
        return;
    } else if (!managing && action === actions.more && board.bankCount > 1) {
        const bank = deviceBanks.get(device) ?? 0;
        deviceBanks.set(device, (bank + 1) % board.bankCount);
    } else if (!managing && action === actions.slot) {
        const chat = chatAtKey(key);
        if (!chat || key.press) return;
        key.press = { chat, startedAt: performance.now() };
        return;
    } else {
        return;
    }
    visibleKeys.forEach((visibleKey, context) => {
        if (visibleKey.device === device) render(visibleKey, context);
    });
}

function handleKeyUp(key, context) {
    const press = key.press;
    if (!press) return;
    key.press = undefined;
    const chat = chatAtKey(key);
    if (!sameChat(press.chat, chat)) return;
    if (performance.now() - press.startedAt >= chatHoldMs) {
        key.detailsChat = key.detailsChat ? undefined : chat;
        render(key, context);
    } else {
        openChat(chat, context);
    }
}

function sendInspectorStatus() {
    if (!inspectorContext || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
        event: 'sendToPropertyInspector', context: inspectorContext,
        payload: {
            tunnelId, tunnelStatus, tunnels, notice: inspectorNotice,
            busy: Boolean(inspectorOperation), signingIn: Boolean(inspectorOperation?.provider),
        },
    }));
}

function saveTunnelSettings(id) {
    socket.send(JSON.stringify({
        event: 'setGlobalSettings', context: uuid, payload: { tunnelId: id, tunnelProvider },
    }));
}

function configureTunnel(id, reconnect = false) {
    if (id === tunnelId && !reconnect) return;
    tunnelMonitor?.abort();
    if (id !== tunnelId) {
        remoteHost.chats = [];
        remoteHost.name = undefined;
        tunnelRecovery = undefined;
    } else if (tunnelRecovery) {
        tunnelRecovery = 'connecting';
    }
    updateSource(remoteHost, null);
    tunnelId = id;
    tunnelStatus = id ? 'Connecting to the remote machine…' : 'Choose a remote tunnel.';
    sendInspectorStatus();
    if (!id) return;

    const controller = new AbortController();
    tunnelMonitor = controller;
    const { signal } = controller;
    remoteHost.name ??= tunnels.find((tunnel) => tunnel.id === id)?.name;
    if (!remoteHost.name) {
        void listTunnels(signal).then((found) => {
            if (signal.aborted) return;
            remoteHost.name = found.find((tunnel) => tunnel.id === id)?.name;
            if (remoteHost.name) renderBoard();
        }).catch(() => {}); // The connection can work even if listing tunnels fails.
    }
    tunnelTask = tunnelTask.then(async () => {
        if (signal.aborted) return;
        await watchManagedTunnel(id, (catalogue) => {
            if (!signal.aborted) updateSource(remoteHost, catalogue);
        }, (status, state) => {
            if (signal.aborted) return;
            tunnelStatus = status;
            if (state === 'sign-in-required') {
                tunnelRecovery = state;
                devicesInManagementMode.clear();
                updateSource(remoteHost, null);
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ event: 'logMessage', payload: { message: 'Remote tunnel requires sign-in' } }));
                }
            } else if (tunnelRecovery && state === 'offline') {
                tunnelRecovery = 'offline';
                renderBoard();
            }
            sendInspectorStatus();
        }, signal);
    }).catch(() => {
        if (signal.aborted) return;
        if (tunnelRecovery) tunnelRecovery = 'offline';
        updateSource(remoteHost, null);
        tunnelStatus = 'Could not connect to the remote machine.';
        sendInspectorStatus();
    });
}

async function refreshTunnels(provider, fromDeck = false) {
    if (inspectorOperation || monitor.signal.aborted) return;
    const operation = { provider, controller: new AbortController() };
    inspectorOperation = operation;
    const savedTunnel = tunnelId;
    const signal = AbortSignal.any([monitor.signal, operation.controller.signal]);
    inspectorNotice = provider ? 'Finish in your browser, or cancel to try again.' : 'Finding tunnels…';
    renderBoard();
    sendInspectorStatus();
    try {
        if (provider) {
            await signIn(provider, signal);
            if (signal.aborted) return;
            tunnelProvider = provider;
            saveTunnelSettings(tunnelId);
            if (savedTunnel && savedTunnel === tunnelId) configureTunnel(tunnelId, true);
            if (fromDeck) {
                inspectorNotice = '';
                return;
            }
        }
        const found = await listTunnels(signal);
        if (signal.aborted) return;
        tunnels = found;
        inspectorNotice = tunnels.length ? 'Select the tunnel you use in VS Code.' : 'No VS Code tunnels found for this account.';
    } catch (error) {
        if (signal.aborted) return;
        tunnels = [];
        inspectorNotice = error.message;
    } finally {
        if (inspectorOperation === operation) {
            inspectorOperation = undefined;
            renderBoard();
            sendInspectorStatus();
        }
    }
}

function handleInspector(message) {
    inspectorContext = message.context;
    const { command, provider, id } = message.payload ?? {};
    if (command === 'list' || (command === 'signIn' && signInProviders.has(provider))) {
        void refreshTunnels(command === 'signIn' ? provider : undefined);
    } else if (command === 'cancelSignIn' && inspectorOperation?.provider) {
        const { controller } = inspectorOperation;
        inspectorOperation = undefined;
        controller.abort();
        inspectorNotice = 'Sign-in canceled. You can try again.';
        renderBoard();
        sendInspectorStatus();
    } else if ((command === 'connect' && validTunnelId(id)) || command === 'disconnect') {
        const nextId = command === 'connect' ? id : '';
        inspectorNotice = '';
        saveTunnelSettings(nextId);
        configureTunnel(nextId, true);
    } else {
        sendInspectorStatus();
    }
}

socket.on('open', () => {
    socket.send(JSON.stringify({ event: registration, uuid }));
    socket.send(JSON.stringify({ event: 'getGlobalSettings', context: uuid }));
    idleAgeTimer = setInterval(refreshIdleAges, idleAgeRefreshMs);
    watchCopilotSessions((catalogue, urlProtocol) => updateSource(local, catalogue, urlProtocol), monitor.signal)
        .catch(() => socket.close());
});

socket.on('message', (frame) => {
    let message;
    try {
        message = JSON.parse(frame.toString());
    } catch {
        return;
    }
    if (message?.event === 'didReceiveGlobalSettings') {
        const { tunnelId: id, tunnelProvider: provider } = message.payload?.settings ?? {};
        tunnelProvider = signInProviders.has(provider) ? provider : 'github';
        configureTunnel(validTunnelId(id) ? id : '');
        return;
    }
    if (message?.event === 'deviceDidDisconnect') {
        for (const [context, key] of visibleKeys) {
            if (key.device !== message.device) continue;
            visibleKeys.delete(context);
            stopPulsing(context);
        }
        return;
    }
    if (!actionIds.has(message?.action) || typeof message.context !== 'string') return;
    if (message.action === actions.more) {
        if (message.event === 'sendToPlugin') {
            handleInspector(message);
            return;
        }
        if (message.event === 'propertyInspectorDidDisappear' && inspectorContext === message.context) {
            inspectorContext = undefined;
        }
    }
    if (message.event === 'willAppear') {
        const slot = message.payload?.settings?.slot;
        if (message.action === actions.slot && (!Number.isInteger(slot) || slot < 0 || slot > slotsPerBank)) return;
        const key = { action: message.action, device: message.device, slot };
        visibleKeys.set(message.context, key);
        render(key, message.context);
    } else if (message.event === 'willDisappear') {
        visibleKeys.delete(message.context);
        stopPulsing(message.context);
    } else if (message.event === 'keyDown' || message.event === 'keyUp') {
        const key = visibleKeys.get(message.context);
        if (!key) return;
        if (message.event === 'keyDown') handleKeyDown(key);
        else handleKeyUp(key, message.context);
    }
});

socket.on('error', () => monitor.abort());
socket.on('close', () => {
    clearInterval(pulseTimer);
    clearInterval(idleAgeTimer);
    monitor.abort();
    tunnelMonitor?.abort();
});
