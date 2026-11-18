const { execFile, spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { watchDevTunnelSessions } = require('./agent-host.cjs');

const run = promisify(execFile);
const commandOptions = { windowsHide: true, cwd: dirname(process.execPath) };
const signInRequired = /not (?:logged|signed) in|no (?:authenticated )?user (?:is )?(?:logged|signed) in|(?:login|sign[- ]in) required|(?:login|cached access) token[^\r\n]*expired/i;
const forwarding = /Forwarding from 127\.0\.0\.1:(\d+)\s+to host port 31546\b/i;
const microsoftDeviceSignInPrompt = /https:\/\/(?:login\.microsoft\.com\/device|(?:www\.)?microsoft\.com\/devicelogin)\s+and enter the code/i;
const githubDeviceSignInUrl = 'https://github.com/login/device';
const githubDeviceSignInPrompt = /^Browse to https:\/\/github\.com\/login\/device and enter the code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/i;
const signInTimeout = 240_000;

function tunnelCli() {
    const winget = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet');
    const linked = join(winget, 'Links', 'devtunnel.exe');
    const installed = join(winget, 'Packages', 'Microsoft.devtunnel_Microsoft.Winget.Source_8wekyb3d8bbwe', 'devtunnel.exe');
    return [linked, installed].find(existsSync) ?? 'devtunnel.exe';
}

function validTunnelId(value) {
    return typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,126}$/i.test(value);
}

function normalizeGitHubUsername(value) {
    if (typeof value !== 'string') return '';
    const username = value.trim().replace(/^@/, '');
    return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(username) ? username : '';
}

function failureMessage(error, fallback) {
    if (error.code === 'ENOENT') return 'Install Microsoft’s Dev Tunnels CLI.';
    if (signInRequired.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)) {
        return 'Sign in with the account that shared the tunnel.';
    }
    return fallback;
}

async function getTunnelAccount(signal) {
    try {
        const { stdout } = await run(tunnelCli(), ['user', 'show', '--json'], {
            ...commandOptions, signal, timeout: 10_000,
        });
        // The CLI can print a welcome banner before the JSON on first use.
        const jsonStart = stdout.indexOf('{');
        if (jsonStart === -1) return { status: 'unavailable' };
        const account = JSON.parse(stdout.slice(jsonStart).trim());
        if (account?.status === 'Not logged in') return { status: 'signed-out' };
        if (account?.status !== 'Logged in') return { status: 'unavailable' };
        return {
            status: 'signed-in',
            provider: typeof account.provider === 'string' ? account.provider.toLowerCase() : '',
            username: typeof account.username === 'string' ? account.username.trim() : '',
        };
    } catch (error) {
        if (error.code === 'ENOENT') return { status: 'missing-cli' };
        if (signInRequired.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)) return { status: 'signed-out' };
        return { status: 'unavailable' };
    }
}

async function verifyGitHubAccount(username, signal) {
    const status = await getTunnelAccount(signal);
    const actual = status.provider === 'github' ? normalizeGitHubUsername(status.username) : '';
    if (actual && actual.toLowerCase() === username.toLowerCase()) return;
    if (actual) throw new Error(`GitHub signed in as @${actual}. Choose @${username} on GitHub and try again.`);
    if (status.status === 'signed-out' || status.status === 'signed-in') {
        throw new Error(`Sign in with GitHub as @${username} to connect.`);
    }
    throw new Error(`Couldn’t verify the GitHub sign-in for @${username}.`);
}

async function signIn(provider, signal, onGitHubCode) {
    const windowsSignIn = provider === 'microsoft';
    const args = windowsSignIn ? ['user', 'login', '--entra', '--use-integrated-windows-auth']
        : ['user', 'login', '--github', '--use-device-code-auth'];
    let switchedToDeviceCode = false;
    let reportedGitHubCode = false;
    let closed;
    try {
        const expiresAt = Date.now() + signInTimeout;
        const login = run(tunnelCli(), args, { ...commandOptions, signal, timeout: signInTimeout });
        closed = new Promise(resolve => login.child.once('close', resolve));
        for (const input of [login.child.stdout, login.child.stderr]) {
            createInterface({ input, crlfDelay: Infinity }).on('line', (line) => {
                if (signal?.aborted) return;
                if (windowsSignIn && !switchedToDeviceCode && microsoftDeviceSignInPrompt.test(line)) {
                    switchedToDeviceCode = true;
                    login.child.kill();
                }
                if (!windowsSignIn && !reportedGitHubCode) {
                    const code = githubDeviceSignInPrompt.exec(line)?.[1];
                    if (code) {
                        reportedGitHubCode = true;
                        onGitHubCode?.(code, expiresAt);
                    }
                }
            });
        }
        await login;
    } catch (error) {
        if (signal?.aborted) {
            await closed;
            throw error;
        }
        if (switchedToDeviceCode) throw new Error('Windows work account sign-in was unavailable. Dev Tunnels switched to device-code sign-in, which can’t verify device health.');
        if (error.killed) throw Object.assign(new Error('Sign-in timed out.'), { code: 'SIGN_IN_TIMEOUT' });
        const fallback = windowsSignIn ? 'Couldn’t sign in with your Windows work account.'
            : 'Sign-in did not finish. Try again.';
        throw new Error(failureMessage(error, fallback));
    }
}

async function listTunnels(signal) {
    try {
        const { stdout } = await run(tunnelCli(), ['list', '--json', '--labels', 'vscode-server-launcher'], {
            ...commandOptions, signal, timeout: 20_000,
        });
        const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        const tunnels = Array.isArray(result) ? result : result.tunnels ?? result.value;
        if (!Array.isArray(tunnels)) throw new Error('Unexpected tunnel list');
        return tunnels.filter((tunnel) => validTunnelId(tunnel?.tunnelId)).map((tunnel) => {
            const labels = Array.isArray(tunnel.labels) ? tunnel.labels : [];
            const name = labels.find((label) => typeof label === 'string'
                && !/^(?:vscode-server-launcher|protocolv\d+|platform-.*)$/i.test(label));
            return { id: tunnel.tunnelId, clusterId: tunnel.clusterId, name, label: name ? `${name} (${tunnel.tunnelId})` : tunnel.tunnelId };
        });
    } catch (error) {
        throw new Error(failureMessage(error, 'Could not list tunnels. Check your sign-in or enter the tunnel ID.'));
    }
}

async function forwardTunnel(id, publish, report, signal) {
    const child = spawn(tunnelCli(), ['connect', id], {
        ...commandOptions, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const subscription = new AbortController();
    let output = '';
    let watcher;
    let error;
    let reachedHost = false;
    let deadline;
    const stop = () => {
        subscription.abort();
        child.kill();
    };
    function waitForHost() {
        clearTimeout(deadline);
        deadline = setTimeout(stop, 35_000);
    }
    signal.addEventListener('abort', stop, { once: true });
    process.once('exit', stop);
    waitForHost();
    const closed = new Promise((resolve) => {
        child.once('error', (failure) => { error = failure; });
        child.once('close', resolve);
    });

    for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
            pending = (pending + chunk).slice(-4096);
            output = (output + chunk).slice(-8192);
            if (watcher || signal.aborted || subscription.signal.aborted) return;
            const port = Number(forwarding.exec(pending)?.[1]);
            if (!Number.isInteger(port) || port < 1 || port > 65535) return;
            waitForHost();
            report('Waiting for the remote Agent Host…', 'waiting');
            watcher = watchDevTunnelSessions((sessions) => {
                reachedHost ||= sessions !== null;
                if (sessions) clearTimeout(deadline);
                else waitForHost();
                publish(sessions);
                report(sessions ? `Connected · ${sessions.length} session(s)` : 'Waiting for the remote Agent Host…', sessions ? 'connected' : 'waiting');
            }, subscription.signal, port, () => {
                // The host handshake/catalogue succeeded. Slow optional chat inspection
                // is not a tunnel failure and must not trip the 35-second watchdog.
                reachedHost = true;
                clearTimeout(deadline);
                report('Connected · loading chats…', 'loading');
            }).catch(() => child.kill());
        });
    }

    await closed;
    clearTimeout(deadline);
    signal.removeEventListener('abort', stop);
    process.removeListener('exit', stop);
    subscription.abort();
    await watcher;
    return { error, output, reachedHost };
}

async function watchManagedTunnel(id, publish, report, signal, githubUsername) {
    let retry = 2000;
    while (!signal.aborted) {
        if (githubUsername) {
            try {
                await verifyGitHubAccount(githubUsername, signal);
            } catch (error) {
                if (!signal.aborted) {
                    report(error.message, 'sign-in-required');
                    publish(null);
                }
                return;
            }
        }
        if (signal.aborted) return;
        report('Connecting to the remote machine…', 'connecting');
        const { error, output, reachedHost } = await forwardTunnel(id, publish, report, signal);
        if (signal.aborted) return;
        if (signInRequired.test(output)) {
            report('Sign in with the account that shared the tunnel.', 'sign-in-required');
            publish(null);
            return;
        }
        publish(null);
        if (error?.code === 'ENOENT') {
            report('Install Microsoft’s Dev Tunnels CLI.', 'offline');
            return;
        }
        report('Tunnel offline. Retrying…', 'offline');
        if (reachedHost) retry = 2000;
        await delay(retry, undefined, { signal }).catch(() => {});
        retry = Math.min(retry * 2, 30_000);
    }
}

module.exports = {
    getTunnelAccount, githubDeviceSignInUrl, listTunnels, normalizeGitHubUsername,
    signIn, validTunnelId, verifyGitHubAccount, watchManagedTunnel,
};
