const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const agentHost = require('../com.davidorn.copilot-status.sdPlugin/agent-host.cjs');
const tunnelClient = require.resolve('../com.davidorn.copilot-status.sdPlugin/tunnel-client.cjs');

test('account status shows the CLI identity and distinguishes signed out from an unavailable check', async (t) => {
    t.after(() => { delete require.cache[tunnelClient]; });
    let stdout;
    let error;
    const promisify = t.mock.method(require('node:util'), 'promisify', () => async (_file, args) => {
        assert.deepEqual(args, ['user', 'show', '--json']);
        if (error) throw error;
        return { stdout };
    });
    const { getTunnelAccount } = require(tunnelClient);
    promisify.mock.restore();

    stdout = JSON.stringify({ status: 'Logged in', provider: 'github', username: 'deck-user', objectId: '456' });
    assert.deepEqual(await getTunnelAccount(), { status: 'signed-in', provider: 'github', username: 'deck-user' });

    stdout = JSON.stringify({ status: 'Logged in', provider: 'entra', username: 'deck@example.com' });
    assert.deepEqual(await getTunnelAccount(), { status: 'signed-in', provider: 'entra', username: 'deck@example.com' });

    stdout = 'Welcome to dev tunnels!\r\n\r\n{"status":"Not logged in"}';
    assert.deepEqual(await getTunnelAccount(), { status: 'signed-out' });

    stdout = 'Unexpected response';
    assert.deepEqual(await getTunnelAccount(), { status: 'unavailable' });

    error = Object.assign(new Error(), { code: 'ENOENT' });
    assert.deepEqual(await getTunnelAccount(), { status: 'missing-cli' });
});

test('Microsoft sign-in uses the Windows work account and stops a device-code fallback', async (t) => {
    t.after(() => { delete require.cache[tunnelClient]; });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stop;
    const login = new Promise((_resolve, reject) => { stop = reject; });
    login.child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill() {
            stdout.end();
            stderr.end();
            stop(new Error('CLI stopped'));
        },
    });
    const promisify = t.mock.method(require('node:util'), 'promisify', () => (_file, args) => {
        assert.deepEqual(args, ['user', 'login', '--entra', '--use-integrated-windows-auth']);
        return login;
    });
    const { signIn } = require(tunnelClient);
    promisify.mock.restore();

    const done = signIn('microsoft');
    stdout.write('To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code ');
    stdout.write('ABC123DEF to authenticate.\r\n');
    await assert.rejects(done, /Windows work account sign-in was unavailable/);
});

test('GitHub sign-in reports a code and checks the approved account before opening the tunnel', async (t) => {
    t.after(() => { delete require.cache[tunnelClient]; });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let completeLogin;
    let cliAccount = { status: 'Logged in', provider: 'github', username: 'personal' };
    const login = new Promise((resolve) => { completeLogin = resolve; });
    login.child = Object.assign(new EventEmitter(), { stdout, stderr });
    const promisify = t.mock.method(require('node:util'), 'promisify', () => (_file, args) => {
        if (args[1] === 'login') {
            assert.deepEqual(args, ['user', 'login', '--github', '--use-device-code-auth']);
            return login;
        }
        return Promise.resolve({ stdout: JSON.stringify(cliAccount) });
    });
    const spawn = t.mock.method(childProcess, 'spawn', () => assert.fail('Tried to connect with the wrong account'));
    const { normalizeGitHubUsername, signIn, verifyGitHubAccount, watchManagedTunnel } = require(tunnelClient);
    promisify.mock.restore();

    const expected = normalizeGitHubUsername(' @work_user ');
    assert.equal(expected, 'work_user');
    const codes = [];
    const started = Date.now();
    const signedIn = signIn('github', undefined, (code, deadline) => {
        assert.ok(deadline >= started + 240_000);
        assert.ok(deadline <= Date.now() + 240_000);
        codes.push(code);
    });
    stdout.write('Browse to https://github.com/login/device and enter the code: ABCD-');
    stdout.write('1234\r\n');
    assert.deepEqual(codes, ['ABCD-1234']);
    stdout.end();
    stderr.end();
    completeLogin();
    await signedIn;

    const states = [];
    const { signal } = new AbortController();
    await watchManagedTunnel('saved-host', () => {}, (message, state) => states.push([message, state]), signal, expected);
    assert.deepEqual(states, [['GitHub signed in as @personal. Choose @work_user on GitHub and try again.', 'sign-in-required']]);
    assert.equal(spawn.mock.callCount(), 0);

    cliAccount = { status: 'Logged in', provider: 'microsoft', username: 'work_user' };
    await assert.rejects(verifyGitHubAccount(expected), /Sign in with GitHub as @work_user/);
    cliAccount = { status: 'Logged in', provider: 'github', username: 'Work_User' };
    await verifyGitHubAccount(expected);
});

test('canceling a GitHub code waits for the CLI to close before allowing renewal', async (t) => {
    t.after(() => { delete require.cache[tunnelClient]; });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const controller = new AbortController();
    const promisify = t.mock.method(require('node:util'), 'promisify', () => (_file, _args, { signal }) => {
        const login = new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('CLI canceled')), { once: true });
        });
        login.child = child;
        return login;
    });
    const { signIn } = require(tunnelClient);
    promisify.mock.restore();

    let settled = false;
    const attempt = signIn('github', controller.signal).finally(() => { settled = true; });
    const assertion = assert.rejects(attempt, /CLI canceled/);
    controller.abort();
    await new Promise(setImmediate);
    assert.equal(settled, false);
    child.stdout.end();
    child.stderr.end();
    child.emit('close');
    await assertion;
    assert.equal(settled, true);
});

test('the plugin starts the forwarder hidden and stops it with the subscription', async (t) => {
    const monitor = new AbortController();
    t.after(() => monitor.abort());
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stopped = false;
    child.kill = () => {
        stopped = true;
        queueMicrotask(() => child.emit('close'));
    };
    const start = t.mock.method(childProcess, 'spawn', () => child);
    const subscribe = t.mock.method(agentHost, 'watchDevTunnelSessions', async (publish, signal, port) => {
        assert.equal(port, 31547);
        publish([{ resource: 'ahp-session:/existing' }]);
        assert.equal(signal.aborted, true);
    });
    const { watchManagedTunnel } = require(tunnelClient);
    t.after(() => { delete require.cache[tunnelClient]; });
    const states = [];
    const watch = watchManagedTunnel('saved-tunnel-id', (sessions) => {
        assert.deepEqual(sessions, [{ resource: 'ahp-session:/existing' }]);
        monitor.abort();
    }, (state) => states.push(state), monitor.signal);
    child.stdout.write('SSH: Forwarding from 127.0.0.1:315');
    child.stdout.write('47 to host port 31546.\n');
    await watch;

    assert.deepEqual(start.mock.calls[0].arguments[1], ['connect', 'saved-tunnel-id']);
    assert.equal(start.mock.calls[0].arguments[2].windowsHide, true);
    assert.equal(subscribe.mock.callCount(), 1);
    assert.equal(stopped, true);
    assert.match(states.at(-1), /^Connected/);
});

test('expired login asks for sign-in and stops retries', async (t) => {
    const monitor = new AbortController();
    t.after(() => monitor.abort());
    t.after(() => { delete require.cache[tunnelClient]; });
    t.mock.method(childProcess, 'spawn', () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => {
            child.stderr.write('Login token expired.\nLogin required.\n');
            child.emit('close', 3);
        });
        return child;
    });
    const { watchManagedTunnel } = require(tunnelClient);
    const states = [];
    await watchManagedTunnel('saved-tunnel-id', () => {}, (_text, state) => states.push(state), monitor.signal);
    assert.deepEqual(states, ['connecting', 'sign-in-required']);
});

test('a connected host with slow chat inspection does not trip the tunnel watchdog', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const monitor = new AbortController();
    t.after(() => monitor.abort());
    t.after(() => { delete require.cache[tunnelClient]; });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let killed = false;
    child.kill = () => { killed = true; queueMicrotask(() => child.emit('close')); };
    t.mock.method(childProcess, 'spawn', () => child);
    t.mock.method(agentHost, 'watchDevTunnelSessions', async (publish, signal, port, onConnected) => {
        onConnected();
        t.mock.timers.tick(36_000);
        assert.equal(killed, false, 'metadata work must not kill a healthy tunnel');
        publish([]);
        monitor.abort();
    });
    const states = [];
    const { watchManagedTunnel } = require(tunnelClient);
    const watch = watchManagedTunnel('saved-tunnel-id', () => {}, (_text, state) => states.push(state), monitor.signal);
    child.stdout.write('Forwarding from 127.0.0.1:31546 to host port 31546.\n');
    await watch;
    assert.deepEqual(states, ['connecting', 'waiting', 'loading', 'connected']);
});

test('a relay timeout stays in the offline retry flow', async (t) => {
    const monitor = new AbortController();
    t.after(() => monitor.abort());
    t.after(() => { delete require.cache[tunnelClient]; });
    t.mock.method(childProcess, 'spawn', () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => {
            child.stderr.write('Timed out connecting to the remote relay.\n');
            child.emit('close', 1);
        });
        return child;
    });
    const { watchManagedTunnel } = require(tunnelClient);
    const states = [];
    await watchManagedTunnel('saved-tunnel-id', () => {}, (_text, state) => {
        states.push(state);
        if (state === 'offline') monitor.abort();
    }, monitor.signal);
    assert.deepEqual(states, ['connecting', 'offline']);
});
