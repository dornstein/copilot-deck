const { execFile, spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const WebSocket = require('ws');
const { isUnreadChat, sessionChats, sessionStatus, watchCopilotSessions } = require('./agent-host.cjs');
const { applicationForChat } = require('./app-origin.cjs');
const { chatLink } = require('./chat-link.cjs');
const { getEdgeProfiles } = require('./edge-profiles.cjs');
const { SessionBoard, slotsPerBank } = require('./session-board.cjs');
const { chatDetailsImage, isPulsingStatus, sessionKeyImage } = require('./session-key.cjs');
const {
    getTunnelAccount, githubDeviceSignInUrl, listTunnels, normalizeGitHubUsername,
    signIn, validTunnelId, verifyGitHubAccount, watchManagedTunnel,
} = require('./tunnel-client.cjs');

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
let tunnelGitHubUsername = '';
let githubBrowserProfile = '';
let tunnelMonitor;
let tunnelTask = Promise.resolve();
let tunnelState = 'unconfigured';
let tunnelStatus = 'Choose a remote tunnel.';
let tunnelRecovery;
let inspectorContext;
let inspectorOperation;
let inspectorNotice = '';
let githubCodeExpired = false;
let githubVerificationUsername = '';
let tunnelAccount = { status: 'checking' };
let accountCheck;
let tunnels = [];
let edgeProfiles = [];

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
            const chatTitle = tunnelProvider === 'github' ? 'Sign in on PC'
                : inspectorOperation?.provider ? 'Signing in' : 'Remote Sign in';
            return { title: '', chatTitle, status: 'Sign in' };
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
        const status = (remote ? remoteHost : local).connected ? sessionStatus(chat)
            : remote && ['connecting', 'waiting', 'loading'].includes(tunnelState) ? 'Starting' : 'Offline';
        return {
            title: '',
            image: images[status],
            chatTitle: typeof chat.title === 'string' ? chat.title : 'Copilot',
            remote,
            application: chat.application,
            status,
            unread: status === 'Idle' && isUnreadChat(chat),
            idleSince: status === 'Idle' ? chat.idleSince : undefined,
            groupColor: board.groupColorFor(chat),
            log: `Copilot Sessions bank ${bank + 1} slot ${key.slot + 1} updated to ${status}`,
        };
    }

    if (!tunnelRecovery && bank === 0 && key.slot === 0 && !local.chats.length && !remoteHost.chats.length) {
        if (tunnelId && ['connecting', 'waiting', 'loading'].includes(tunnelState)) {
            return { title: '', chatTitle: tunnelState === 'loading' ? 'Loading chats' : 'Connecting', status: 'Starting' };
        }
        const status = local.connected || remoteHost.connected ? 'No session' : 'Offline';
        return { title: labels[status], image: images[status] };
    }
    return { title: '', image: 'empty' };
}

function sendImage(key, context) {
    const { image, chatTitle, status, pulseStart, remote, unread, groupColor, idleAge, application } = key;
    const elapsed = pulseStart === undefined ? 0 : performance.now() - pulseStart;
    const renderedImage = chatTitle !== undefined || pulseStart !== undefined
        ? sessionKeyImage(chatTitle, status, elapsed, { remote, unread, groupColor, idleAge, application })
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
    const { title, image, chatTitle, status, remote, unread, groupColor, idleSince, application, log } = displayFor(key, chat);
    key.idleSince = idleSince;
    const idleAge = formatIdleAge(idleSince, Date.now());
    if (title === key.title && image === key.image && chatTitle === key.chatTitle
        && status === key.status && remote === key.remote && unread === key.unread
        && groupColor === key.groupColor && idleAge === key.idleAge && application === key.application) return;
    key.title = title;
    key.image = image;
    key.chatTitle = chatTitle;
    key.status = status;
    key.remote = remote;
    key.unread = unread;
    key.groupColor = groupColor;
    key.application = application;
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
            application: applicationForChat(session, chat),
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

function openWindowsUri(uri, onError) {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:COPILOT_DECK_URI -ErrorAction Stop'],
        { windowsHide: true, env: { ...process.env, COPILOT_DECK_URI: uri }, timeout: 10_000 },
        (error) => { if (error) onError(); });
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
    openWindowsUri(url, showAlert);
}

function handleKeyDown(key, context) {
    const { action, device, slot } = key;
    const managing = devicesInManagementMode.has(device);
    if (action === actions.slot && slot === modeSlot) {
        if (tunnelRecovery) {
            if (tunnelRecovery === 'sign-in-required') {
                openWindowsUri('streamdeck://open/mainwindow', () => {
                    socket.send(JSON.stringify({ event: 'showAlert', context }));
                });
                if (tunnelProvider === 'github' && tunnelGitHubUsername) {
                    void refreshTunnels('github', { githubUsername: tunnelGitHubUsername });
                } else if (tunnelProvider === 'microsoft') {
                    void refreshTunnels('microsoft', { fromDeck: true });
                }
            }
            return;
        }
        if (managing) devicesInManagementMode.delete(device);
        else devicesInManagementMode.add(device);
    } else if (managing && action === actions.slot && slot === compactSlot) {
        compactChats(device);
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

function compactChats(device) {
    board.compact();
    if (device) {
        deviceBanks.delete(device);
        devicesInManagementMode.delete(device);
    } else {
        deviceBanks.clear();
        devicesInManagementMode.clear();
    }
    renderBoard();
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
            tunnelId, tunnelState, tunnelStatus, tunnelProvider, tunnelAccount, tunnels, notice: inspectorNotice,
            tunnelName: remoteHost.name, remoteChatCount: remoteHost.chats.length,
            busy: Boolean(inspectorOperation), signingIn: Boolean(inspectorOperation?.provider),
            githubUsername: tunnelGitHubUsername, githubVerificationUsername, githubCode: inspectorOperation?.githubCode,
            githubCodeDeadline: inspectorOperation?.githubCodeDeadline, githubCodeExpired,
            requestingGitHubCode: inspectorOperation?.provider === 'github' && !inspectorOperation.githubCode
                && (inspectorOperation.renew || !inspectorOperation.controller.signal.aborted && !inspectorOperation.verifying),
            edgeProfiles, githubBrowserProfile,
        },
    }));
}

async function refreshTunnelAccount() {
    if (!inspectorContext || monitor.signal.aborted) return;
    accountCheck?.abort();
    accountCheck = new AbortController();
    const signal = AbortSignal.any([accountCheck.signal, monitor.signal]);
    const account = await getTunnelAccount(signal);
    if (signal.aborted) return;
    tunnelAccount = account;
    sendInspectorStatus();
}

function saveTunnelSettings(id, tunnelName = id === tunnelId ? remoteHost.name : undefined) {
    socket.send(JSON.stringify({
        event: 'setGlobalSettings', context: uuid,
        payload: { tunnelId: id, tunnelName, tunnelProvider, tunnelGitHubUsername, githubBrowserProfile },
    }));
}

function configureTunnel(id, reconnect = false, name) {
    if (id === tunnelId && !reconnect) return;
    tunnelMonitor?.abort();
    if (id !== tunnelId) {
        remoteHost.chats = [];
        remoteHost.name = name;
        tunnelRecovery = undefined;
    } else if (tunnelRecovery) {
        tunnelRecovery = 'connecting';
    }
    updateSource(remoteHost, null);
    tunnelId = id;
    tunnelState = id ? 'connecting' : 'unconfigured';
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
            remoteHost.name = found.find((tunnel) => tunnel.id === id || `${tunnel.id}.${tunnel.clusterId}` === id)?.name;
            if (remoteHost.name) {
                saveTunnelSettings(id);
                sendInspectorStatus();
                renderBoard();
            }
        }).catch(() => {}); // The connection can work even if listing tunnels fails.
    }
    tunnelTask = tunnelTask.then(async () => {
        if (signal.aborted) return;
        await watchManagedTunnel(id, (catalogue) => {
            if (!signal.aborted) updateSource(remoteHost, catalogue);
        }, (status, state) => {
            if (signal.aborted) return;
            const enteredSignInRequired = state === 'sign-in-required' && tunnelState !== state;
            if (tunnelState !== state && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ event: 'logMessage', payload: { message: `Remote tunnel state: ${state}` } }));
            }
            tunnelState = state;
            tunnelStatus = status;
            renderBoard();
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
            if (enteredSignInRequired && !inspectorOperation) void refreshTunnelAccount();
        }, signal, tunnelProvider === 'github' ? tunnelGitHubUsername : undefined);
    }).catch(() => {
        if (signal.aborted) return;
        if (tunnelRecovery) tunnelRecovery = 'offline';
        tunnelState = 'offline';
        updateSource(remoteHost, null);
        tunnelStatus = 'Could not connect to the remote machine.';
        sendInspectorStatus();
    });
}

function openGitHubSignIn(browserProfile) {
    const operation = inspectorOperation;
    const reportError = (message) => {
        if (inspectorOperation !== operation) return;
        inspectorNotice = message;
        sendInspectorStatus();
    };
    if (browserProfile) {
        const edge = getEdgeProfiles();
        edgeProfiles = edge.profiles;
        if (!edge.profiles.some(({ directory }) => directory === browserProfile)) {
            reportError('That Edge profile is unavailable. Choose a browser profile and try again.');
            return;
        }
        const child = spawn(edge.executable, [`--profile-directory=${browserProfile}`, githubDeviceSignInUrl], {
            detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.once('error', () => reportError('Couldn’t open GitHub in the selected Edge profile.'));
        child.unref();
    } else {
        openWindowsUri(githubDeviceSignInUrl, () => reportError('Couldn’t open GitHub in your default browser.'));
    }
    githubBrowserProfile = browserProfile;
    inspectorNotice = '';
    saveTunnelSettings(tunnelId);
    sendInspectorStatus();
}

async function refreshTunnels(provider, { fromDeck = false, githubUsername = '' } = {}) {
    if (inspectorOperation || monitor.signal.aborted) return;
    const operation = { provider, controller: new AbortController() };
    inspectorOperation = operation;
    const savedTunnel = tunnelId;
    const signal = AbortSignal.any([monitor.signal, operation.controller.signal]);
    inspectorNotice = provider === 'microsoft' ? 'Signing in with your Windows work account…'
        : provider === 'github' ? 'Requesting a GitHub sign-in code…' : 'Finding tunnels…';
    if (provider) {
        githubCodeExpired = false;
        tunnelAccount = { status: 'checking' };
    }
    if (provider === 'github') githubVerificationUsername = githubUsername;
    renderBoard();
    sendInspectorStatus();
    try {
        if (provider) {
            await signIn(provider, signal, (code, deadline) => {
                if (signal.aborted) return;
                operation.githubCode = code;
                operation.githubCodeDeadline = deadline;
                inspectorNotice = '';
                sendInspectorStatus();
                void refreshTunnelAccount();
            });
            if (signal.aborted) return;
            operation.githubCode = undefined;
            if (provider === 'github') {
                operation.verifying = true;
                inspectorNotice = `Checking GitHub sign-in for @${githubUsername}…`;
                sendInspectorStatus();
                await verifyGitHubAccount(githubUsername, signal);
                if (signal.aborted) return;
                tunnelGitHubUsername = githubUsername;
            }
            inspectorNotice = fromDeck ? '' : 'Finding tunnels…';
            tunnelProvider = provider;
            saveTunnelSettings(tunnelId);
            if (savedTunnel && savedTunnel === tunnelId) configureTunnel(tunnelId, true);
            if (fromDeck) return;
            sendInspectorStatus();
        } else if (tunnelProvider === 'github' && tunnelGitHubUsername) {
            await verifyGitHubAccount(tunnelGitHubUsername, signal);
            if (signal.aborted) return;
        }
        const found = await listTunnels(signal);
        if (signal.aborted) return;
        tunnels = found;
        remoteHost.name ??= found.find((tunnel) => tunnel.id === tunnelId || `${tunnel.id}.${tunnel.clusterId}` === tunnelId)?.name;
        inspectorNotice = tunnelState === 'connected' ? ''
            : tunnels.length ? 'Select the tunnel you use in VS Code.' : 'No VS Code tunnels found for this account.';
    } catch (error) {
        if (signal.aborted) return;
        tunnels = [];
        githubCodeExpired = provider === 'github' && error.code === 'SIGN_IN_TIMEOUT';
        inspectorNotice = githubCodeExpired ? '' : error.message;
    } finally {
        if (inspectorOperation === operation) {
            inspectorOperation = undefined;
            renderBoard();
            if (operation.renew) {
                void refreshTunnels('github', { githubUsername });
            } else {
                sendInspectorStatus();
                void refreshTunnelAccount();
            }
        }
    }
}

function handleInspector(message) {
    inspectorContext = message.context;
    const { command, provider, id, browserProfile, githubUsername: inputUsername } = message.payload ?? {};
    const githubUsername = normalizeGitHubUsername(inputUsername);
    if (command === 'status') {
        edgeProfiles = getEdgeProfiles().profiles;
        sendInspectorStatus();
        void refreshTunnelAccount();
    } else if (command === 'list' || (command === 'signIn' && provider === 'microsoft')) {
        void refreshTunnels(command === 'signIn' ? provider : undefined);
    } else if (command === 'signIn' && provider === 'github' && githubUsername) {
        void refreshTunnels('github', { githubUsername });
    } else if (command === 'openGitHubSignIn' && inspectorOperation?.githubCode
        && Date.now() < inspectorOperation.githubCodeDeadline) {
        openGitHubSignIn(typeof browserProfile === 'string' ? browserProfile : '');
    } else if (command === 'renewGitHubCode' && inspectorOperation?.githubCode) {
        inspectorOperation.renew = true;
        inspectorOperation.githubCode = undefined;
        inspectorOperation.controller.abort();
        inspectorNotice = 'Requesting a new GitHub code…';
        sendInspectorStatus();
    } else if (command === 'renewGitHubCode' && !inspectorOperation && githubCodeExpired && githubVerificationUsername) {
        void refreshTunnels('github', { githubUsername: githubVerificationUsername });
    } else if (command === 'cancelSignIn' && inspectorOperation?.provider) {
        inspectorOperation.renew = false;
        inspectorOperation.githubCode = undefined;
        inspectorOperation.controller.abort();
        inspectorNotice = 'Sign-in canceled. You can try again.';
        sendInspectorStatus();
    } else if (command === 'retry' && !inspectorOperation && tunnelId) {
        inspectorNotice = '';
        configureTunnel(tunnelId, true);
    } else if (command === 'compactChats') {
        compactChats(visibleKeys.get(message.context)?.device);
    } else if (!inspectorOperation && (command === 'disconnect' || (command === 'connect' && validTunnelId(id)))) {
        const nextId = command === 'connect' ? id : '';
        githubCodeExpired = false;
        inspectorNotice = '';
        const name = nextId === tunnelId ? remoteHost.name : tunnels.find((tunnel) => tunnel.id === nextId)?.name;
        saveTunnelSettings(nextId, name);
        configureTunnel(nextId, true, name);
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
        const settings = message.payload?.settings ?? {};
        const { tunnelId: id, tunnelProvider: provider, tunnelGitHubUsername: githubUsername } = settings;
        tunnelProvider = signInProviders.has(provider) ? provider : 'github';
        tunnelGitHubUsername = normalizeGitHubUsername(githubUsername);
        githubBrowserProfile = typeof settings.githubBrowserProfile === 'string' ? settings.githubBrowserProfile : '';
        const name = typeof settings.tunnelName === 'string' ? settings.tunnelName : undefined;
        configureTunnel(validTunnelId(id) ? id : '', false, name);
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
    if (message.action === actions.more || message.action === actions.slot) {
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
        if (message.event === 'keyDown') handleKeyDown(key, message.context);
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
