const element = (id) => document.getElementById(id);
const form = document.querySelector('form');
const fieldset = form.querySelector('fieldset');
const tunnelId = element('tunnel-id');
const choices = element('tunnels');
const details = element('connection-details');
const primaryAction = element('primary-action');
const githubUsername = element('github-username');
const githubContinue = element('github-continue');
const verification = element('github-verification');
const githubCode = element('github-code');
const githubBrowser = element('github-browser');
const githubOpen = element('github-open');
const githubCopy = element('github-copy');
const githubRenew = element('github-renew');
const copyFeedback = element('copy-feedback');
const availableStates = {
    connected: ['Connected', 'good'],
    connecting: ['Connecting', 'checking'],
    loading: ['Loading chats', 'checking'],
    waiting: ['Waiting for VS Code', 'checking'],
    offline: ['Retrying', 'attention'],
    'sign-in-required': ['Sign-in required', 'attention'],
};
let settings = {};
let send;
let tunnelList;
let edgeProfiles;
let selectedBrowser = '';
let expiryTimer;
let compactTimer;

function showText(id, text) {
    const node = element(id);
    if (node.textContent !== text) node.textContent = text;
    node.hidden = !text;
}

function toggleAccountEditor(open) {
    element('github-account').hidden = !open;
    element('github').setAttribute('aria-expanded', String(open));
    if (open) githubUsername.focus();
}

function updateGitHubContinue() {
    githubContinue.disabled = settings.busy || !/^@?[a-z0-9][a-z0-9_-]{0,63}$/i.test(githubUsername.value.trim());
}

function startGitHubSignIn(username) {
    if (!username || settings.busy) return;
    send?.({ command: 'signIn', provider: 'github', githubUsername: username });
    toggleAccountEditor(false);
    details.open = false;
}

function showAccount(account = {}) {
    const { status, provider, username } = account;
    const label = status === 'signed-in' ? 'Signed in as' : 'Dev Tunnels account';
    let name = {
        checking: 'Checking…',
        'signed-out': 'Not signed in',
        'missing-cli': 'Dev Tunnels CLI required',
    }[status] ?? 'Couldn’t check sign-in';
    if (status === 'signed-in') {
        const providerName = provider === 'github' ? 'GitHub'
            : ['aad', 'entra', 'microsoft', 'msa'].includes(provider) ? 'Microsoft' : '';
        const handle = provider === 'github' && username ? '@' + username.replace(/^@/, '') : username;
        name = [handle || 'Account name unavailable', providerName].filter(Boolean).join(' · ');
    }
    showText('account-label', label);
    showText('account-name', name);
}

function updateOpenButton() {
    const profile = settings.edgeProfiles?.find(({ directory }) => directory === selectedBrowser);
    githubOpen.textContent = profile ? `Open GitHub in Edge ${profile.name}` : 'Open GitHub';
}

function showVerification() {
    const hadCode = !verification.hidden;
    const timeLeft = Math.max(0, Math.ceil((settings.githubCodeDeadline - Date.now()) / 1000));
    const active = Boolean(settings.githubCode && timeLeft > 0);
    const expired = settings.githubCodeExpired || Boolean(settings.githubCode && !active);
    const requesting = settings.requestingGitHubCode;
    verification.hidden = !(active || expired || requesting);
    if (!hadCode && !verification.hidden) window.scrollTo(0, 0);

    const username = settings.githubVerificationUsername;
    const message = expired ? `Code expired for @${username}.`
        : requesting ? `Getting a GitHub code for @${username}…`
        : active ? `On GitHub, continue as @${username}.` : '';
    showText('github-target', message);
    element('github-code-row').hidden = !active;
    element('github-time').hidden = !active;
    const code = active ? settings.githubCode : '';
    if (githubCode.value !== code) {
        githubCode.value = code;
        showText('copy-feedback', '');
    }
    if (active) showText('github-time', `Time left ${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`);
    githubOpen.hidden = !active;
    githubRenew.hidden = !(active || expired);
    githubRenew.textContent = expired ? 'Get a new code' : 'Renew code';
    element('cancel-sign-in').hidden = !settings.signingIn;
    element('github-browser-options').hidden = !active || !(settings.edgeProfiles?.length);
    element('connection-summary').hidden = !verification.hidden;
}

function showConnection() {
    const { tunnelState, tunnelStatus, tunnelName, remoteChatCount, tunnelAccount, githubUsername: username, busy } = settings;
    const [badge, tone] = availableStates[tunnelState] ?? ['', ''];
    showText('connection-badge', badge);
    element('connection-badge').dataset.tone = tone;
    showText('machine', settings.tunnelId ? (tunnelName || 'Saved remote computer') : '');

    const account = tunnelAccount ?? {};
    const signInRequired = tunnelState === 'sign-in-required' || (settings.tunnelId && account.status === 'signed-out');
    let message = tunnelStatus ?? '';
    let action;
    if (account.status === 'missing-cli') {
        message = 'Install Microsoft’s Dev Tunnels CLI to connect.';
    } else if (signInRequired && username && settings.tunnelProvider === 'github') {
        message = tunnelState === 'connected' ? 'Sign in again so Stream Deck can reconnect if the connection drops.'
            : `Use @${username} to connect to this computer.`;
        action = [`Sign in as @${username}`, () => startGitHubSignIn(username)];
    } else if (signInRequired && settings.tunnelProvider === 'microsoft') {
        message = 'Use the Windows work account that shared this computer.';
        action = ['Sign in with Windows work account', signInWithWindows];
    } else if (signInRequired || (!settings.tunnelId && account.status === 'signed-out')) {
        message = 'Use the account that shared the computer.';
        action = ['Choose GitHub account', openAccountEditor];
    } else if (tunnelState === 'connected') {
        message = remoteChatCount === 0 ? 'No remote chats yet.'
            : `${remoteChatCount} remote ${remoteChatCount === 1 ? 'chat' : 'chats'} on your deck.`;
    } else if (tunnelState === 'offline') {
        message = 'Can’t reach the remote computer. Retrying automatically.';
        action = ['Retry now', () => send?.({ command: 'retry' })];
    } else if (!settings.tunnelId) {
        message = 'Choose a computer to see its remote chats.';
        action = ['Find computers', findComputers];
    }
    showText('connection-message', message);
    showText('primary-action', action?.[0] ?? '');
    primaryAction.onclick = action?.[1] ?? null;
    primaryAction.disabled = Boolean(busy);
    element('cancel-other-sign-in').hidden = !settings.signingIn || !verification.hidden;
}

function updateSettings(next) {
    const previous = settings;
    settings = next;
    if (previous.tunnelId === undefined || tunnelId.value === previous.tunnelId) tunnelId.value = settings.tunnelId;
    if ((previous.githubUsername ?? '') === githubUsername.value) githubUsername.value = settings.githubUsername ?? '';

    const nextTunnels = JSON.stringify(settings.tunnels);
    if (tunnelList !== nextTunnels) {
        tunnelList = nextTunnels;
        choices.replaceChildren(new Option('Select a computer', ''));
        for (const { id, label } of settings.tunnels) choices.add(new Option(label, id));
        element('tunnel-picker').hidden = settings.tunnels.length === 0;
    }
    const nextProfiles = JSON.stringify(settings.edgeProfiles);
    if (!edgeProfiles || selectedBrowser === (previous.githubBrowserProfile ?? '')) {
        selectedBrowser = settings.githubBrowserProfile ?? '';
    }
    if (edgeProfiles !== nextProfiles) {
        edgeProfiles = nextProfiles;
        githubBrowser.replaceChildren(new Option('Default browser', ''));
        for (const { directory, name } of settings.edgeProfiles) githubBrowser.add(new Option(`Edge — ${name}`, directory));
    }
    githubBrowser.value = selectedBrowser;
    if (githubBrowser.selectedIndex < 0) githubBrowser.selectedIndex = 0;
    selectedBrowser = githubBrowser.value;
    updateOpenButton();

    fieldset.disabled = false;
    for (const id of ['microsoft', 'github', 'find', 'github-username']) element(id).disabled = Boolean(settings.busy);
    element('disconnect').disabled = settings.busy || !settings.tunnelId;
    element('connect').disabled = settings.busy || !tunnelId.validity.valid;
    updateGitHubContinue();
    showAccount(settings.tunnelAccount);
    element('new-sign-in-note').hidden = settings.tunnelAccount?.status !== 'signed-in';
    showVerification();
    showConnection();
    const staleSetupPrompt = settings.tunnelState === 'connected'
        && settings.notice === 'Select the tunnel you use in VS Code.';
    showText('notice', settings.requestingGitHubCode || staleSetupPrompt ? '' : settings.notice ?? '');
    githubOpen.disabled = false;
    githubRenew.disabled = false;
    githubCopy.disabled = false;
    clearInterval(expiryTimer);
    if (settings.githubCode) {
        expiryTimer = setInterval(() => {
            showVerification();
            if (element('github-code-row').hidden) clearInterval(expiryTimer);
        }, 1000);
    }
}

function openAccountEditor() {
    details.open = true;
    toggleAccountEditor(true);
}

function signInWithWindows() {
    details.open = false;
    send?.({ command: 'signIn', provider: 'microsoft' });
}

function findComputers() {
    details.open = true;
    send?.({ command: 'list' });
}

window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, actionInfo) => {
    const { action } = JSON.parse(actionInfo);
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    send = (payload) => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ event: 'sendToPlugin', action, context: uuid, payload }));
        }
    };
    socket.onopen = () => {
        socket.send(JSON.stringify({ event: registerEvent, uuid }));
        send({ command: 'status' });
    };
    socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.event === 'sendToPropertyInspector') updateSettings(message.payload);
    };
    socket.onclose = () => {
        clearInterval(expiryTimer);
        fieldset.disabled = true;
        verification.hidden = true;
        githubCode.value = '';
        showText('account-name', 'Couldn’t check sign-in');
        showText('notice', 'Stream Deck connection closed.');
    };
};

choices.onchange = () => {
    if (choices.value) tunnelId.value = choices.value;
    element('connect').disabled = settings.busy || !tunnelId.validity.valid;
};
tunnelId.oninput = () => { element('connect').disabled = settings.busy || !tunnelId.validity.valid; };
form.onsubmit = (event) => {
    event.preventDefault();
    if (!settings.busy && form.reportValidity()) {
        send?.({ command: 'connect', id: tunnelId.value });
        details.open = false;
    }
};
element('disconnect').onclick = () => send?.({ command: 'disconnect' });
element('microsoft').onclick = signInWithWindows;
element('find').onclick = findComputers;
element('github').onclick = () => toggleAccountEditor(element('github-account').hidden);
for (const id of ['cancel-sign-in', 'cancel-other-sign-in']) {
    element(id).onclick = () => send?.({ command: 'cancelSignIn' });
}
githubUsername.oninput = updateGitHubContinue;
githubUsername.onkeydown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    githubContinue.click();
};
githubContinue.onclick = () => startGitHubSignIn(githubUsername.value.trim());
githubBrowser.onchange = () => {
    selectedBrowser = githubBrowser.value;
    updateOpenButton();
};
githubOpen.onclick = () => send?.({ command: 'openGitHubSignIn', browserProfile: selectedBrowser });
githubRenew.onclick = () => {
    githubRenew.disabled = true;
    githubOpen.disabled = true;
    githubCopy.disabled = true;
    send?.({ command: 'renewGitHubCode' });
};
githubCopy.onclick = async () => {
    const code = githubCode.value;
    if (!code || Date.now() >= settings.githubCodeDeadline) return;
    githubCode.select();
    let copied = false;
    try {
        copied = document.execCommand('copy');
        if (!copied && navigator.clipboard) {
            await navigator.clipboard.writeText(code);
            copied = true;
        }
    } catch {
        // Keep the code selected so it can be copied with the keyboard.
    }
    if (githubCode.value !== code) return;
    if (copied) githubCopy.focus({ preventScroll: true });
    showText('copy-feedback', copied ? 'Code copied.' : 'Code selected. Press Ctrl+C to copy.');
};
element('compact').onclick = () => {
    send?.({ command: 'compactChats' });
    showText('compact-status', 'Chats compacted.');
    clearTimeout(compactTimer);
    compactTimer = setTimeout(() => showText('compact-status', ''), 3000);
};
