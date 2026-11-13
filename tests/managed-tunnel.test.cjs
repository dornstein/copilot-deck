const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const agentHost = require('../com.davidorn.copilot-status.sdPlugin/agent-host.cjs');
const tunnelClient = require.resolve('../com.davidorn.copilot-status.sdPlugin/tunnel-client.cjs');

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
