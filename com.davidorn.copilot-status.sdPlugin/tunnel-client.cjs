const { execFile, spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { watchDevTunnelSessions } = require('./agent-host.cjs');

const run = promisify(execFile);
const commandOptions = { windowsHide: true, cwd: dirname(process.execPath) };
const signInRequired = /not (?:logged|signed) in|no (?:authenticated )?user (?:is )?(?:logged|signed) in|(?:login|sign[- ]in) required|(?:login|cached access) token[^\r\n]*expired/i;
const forwarding = /Forwarding from 127\.0\.0\.1:(\d+)\s+to host port 31546\b/i;

function tunnelCli() {
    const winget = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet');
    const linked = join(winget, 'Links', 'devtunnel.exe');
    const installed = join(winget, 'Packages', 'Microsoft.devtunnel_Microsoft.Winget.Source_8wekyb3d8bbwe', 'devtunnel.exe');
    return [linked, installed].find(existsSync) ?? 'devtunnel.exe';
}

function validTunnelId(value) {
    return typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,126}$/i.test(value);
}

function failureMessage(error, fallback) {
    if (error.code === 'ENOENT') return 'Install Microsoft’s Dev Tunnels CLI.';
    if (signInRequired.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)) {
        return 'Sign in with the account that shared the tunnel.';
    }
    return fallback;
}

async function signIn(provider, signal) {
    const args = ['user', 'login', '--use-browser-auth', provider === 'github' ? '--github' : '--entra'];
    try {
        await run(tunnelCli(), args, { ...commandOptions, signal, timeout: 240_000 });
    } catch (error) {
        throw new Error(failureMessage(error, 'Sign-in did not finish. Try again.'));
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
            return { id: tunnel.tunnelId, name, label: name ? `${name} (${tunnel.tunnelId})` : tunnel.tunnelId };
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
            }, subscription.signal, port).catch(() => child.kill());
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

async function watchManagedTunnel(id, publish, report, signal) {
    let retry = 2000;
    while (!signal.aborted) {
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

module.exports = { listTunnels, signIn, validTunnelId, watchManagedTunnel };
