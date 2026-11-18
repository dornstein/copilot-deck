const assert = require('node:assert/strict');
const test = require('node:test');
const { isUnreadChat, sessionChats, sessionStatus } = require('../com.davidorn.copilot-status.sdPlugin/agent-host.cjs');
const { SessionBoard, slotsPerBank } = require('../com.davidorn.copilot-status.sdPlugin/session-board.cjs');
const { isPulsingStatus, sessionKeyImage } = require('../com.davidorn.copilot-status.sdPlugin/session-key.cjs');

function decodeImage(image) {
    return decodeURIComponent(image.slice('data:image/svg+xml,'.length));
}

function titleLines(image) {
    return Array.from(image.matchAll(/<text[^>]*>(.*?)<\/text>/g), ([, line]) => line);
}

test('an older session keeps its key when a turn makes it the most recent session', () => {
    const board = new SessionBoard();
    const sessions = Array.from({ length: 18 }, (_, index) => ({ resource: `session:${index}`, status: 33 }));
    board.update(sessions);
    const active = { ...sessions[9], status: 40 };
    board.update([active, ...sessions.filter(({ resource }) => resource !== active.resource)]);

    assert.equal(board.bankCount, 2);
    assert.equal(board.sessionAt(0, 0), sessions[0]);
    assert.equal(board.sessionAt(0, 9), active);
    assert.equal(sessionStatus(board.sessionAt(0, 9)), 'Running');
    assert.equal(board.sessionAt(1, 0), sessions[slotsPerBank]);
});

test('local and remote sessions keep separate slots when their resources match', () => {
    const board = new SessionBoard();
    const local = { resource: 'session:1', status: 33 };
    const remote = { ...local, source: 'remote' };
    board.update([local, remote]);
    const running = { ...remote, status: 40 };
    board.update([running, local]);
    assert.equal(board.sessionAt(0, 0), local);
    assert.equal(board.sessionAt(0, 1), running);
});

test('related chats share a stable color across banks only while both are on the board', () => {
    const board = new SessionBoard();
    const main = { resource: 'chat:main', sessionResource: 'session:one', status: 33 };
    const nested = { ...main, resource: 'chat:nested' };
    const singles = Array.from({ length: slotsPerBank - 1 }, (_, index) => ({
        resource: `chat:other-${index}`, sessionResource: `session:other-${index}`,
    }));
    board.update([main, ...singles]);
    assert.equal(board.groupColorFor(main), undefined);

    board.update([main, ...singles, nested]);
    const color = board.groupColorFor(board.sessionAt(0, 0));
    assert.match(color, /^#[0-9a-f]{6}$/);
    assert.equal(board.groupColorFor(board.sessionAt(1, 0)), color);
    assert.equal(board.groupColorFor(singles[0]), undefined);

    const running = { ...nested, status: 40 };
    board.update([running, ...singles, main]);
    assert.equal(board.groupColorFor(board.sessionAt(1, 0)), color);
    board.update([main, ...singles]);
    assert.equal(board.groupColorFor(main), undefined);
    board.update([main, ...singles, nested]);
    assert.equal(board.groupColorFor(main), color);
});

test('compacting sorts by activity, preserves group colors, and removes empty banks', () => {
    const board = new SessionBoard();
    const main = { resource: 'chat:main', sessionResource: 'session:one', sessionModifiedAt: '2026-11-12T19:00:00Z' };
    const nested = { ...main, resource: 'chat:nested', modifiedAt: '2026-11-12T12:00:00-08:00' };
    const remote = { resource: 'chat:remote', source: 'remote', modifiedAt: '2026-11-12T19:30:00Z' };
    const singles = Array.from({ length: slotsPerBank - 3 }, (_, index) => ({ resource: `chat:single-${index}` }));
    const sameTime = { resource: 'chat:tie', sessionModifiedAt: main.sessionModifiedAt, modifiedAt: 'invalid' };
    board.update([main, ...singles, sameTime, remote, nested]);
    const color = board.groupColorFor(main);
    board.update([nested, singles[3], sameTime, remote, main]);
    assert.equal(board.bankCount, 2);
    assert.equal(board.sessionAt(0, 0), main);

    board.compact();
    assert.equal(board.bankCount, 1);
    assert.deepEqual([0, 1, 2, 3, 4].map((slot) => board.sessionAt(0, slot)), [nested, remote, main, sameTime, singles[3]]);
    assert.equal(board.groupColorFor(nested), color);
    assert.equal(board.sessionAt(0, 5), undefined);
    board.update([nested, { ...main, modifiedAt: '2026-11-12T21:00:00Z' }, sameTime, remote, singles[3]]);
    assert.equal(board.sessionAt(0, 0), nested);
    board.compact();
    assert.equal(board.sessionAt(0, 0).resource, main.resource);
});

test('the same session resource on different sources forms separate groups', () => {
    const board = new SessionBoard();
    const local = { resource: 'chat:main', sessionResource: 'session:one' };
    const remote = { ...local, source: 'remote' };
    board.update([local, remote]);
    assert.equal(board.groupColorFor(local), undefined);
    assert.equal(board.groupColorFor(remote), undefined);

    board.update([local, remote, { ...local, resource: 'chat:nested' }]);
    const localColor = board.groupColorFor(local);
    assert.ok(localColor);
    assert.equal(board.groupColorFor(remote), undefined);
    board.update([local, remote, { ...local, resource: 'chat:nested' }, { ...remote, resource: 'chat:nested' }]);
    assert.equal(board.groupColorFor(local), localColor);
    assert.ok(board.groupColorFor(remote));
    assert.notEqual(board.groupColorFor(remote), localColor);
});

test('the board uses visible chat summaries and supports sessions from older hosts', () => {
    const main = { resource: 'chat:main', status: 33 };
    const nested = { resource: 'chat:nested', status: 40 };
    const unknown = { resource: 'chat:unknown' };
    const legacy = { resource: 'session:legacy', status: 40 };
    const session = { resource: 'session:one', status: 40, defaultChat: main.resource, chats: [
        main, nested, unknown,
        { resource: 'chat:archived', status: 65 },
        { resource: 'chat:hidden', status: 40, interactivity: 'hidden' },
    ] };
    const board = new SessionBoard();
    board.update([session, legacy].flatMap(sessionChats));

    assert.deepEqual(board.sessionAt(0, 0), { ...main, title: 'Untitled conversation' });
    assert.deepEqual(board.sessionAt(0, 1), { ...nested, title: 'Untitled conversation' });
    assert.deepEqual([0, 1, 2, 3].map((slot) => sessionStatus(board.sessionAt(0, slot))),
        ['Idle', 'Running', 'Unknown', 'Running']);
    assert.equal(board.sessionAt(0, 4), undefined);
});

test('idle keys have no status icon and the title gets multiple lines', () => {
    const title = 'Review the new build & verify <session slots> on the deck';
    const idle = decodeImage(sessionKeyImage(title, 'Idle'));
    assert.equal(isPulsingStatus('Idle'), false);
    assert.doesNotMatch(idle, /<path|<circle|<rect x=/);
    const lines = titleLines(idle);
    assert.ok(lines.length >= 3);
    assert.match(lines.join(' '), /&amp; verify &lt;session slots&gt;/);
    assert.doesNotMatch(idle, />Idle</);
    assert.match(decodeImage(sessionKeyImage('界'.repeat(100), 'Idle')), /…<\/text>/);
});

test('steady exceptional states each show a distinct corner icon', () => {
    for (const [status, path] of [
        ['Error', 'M12 3 22 21H2Z'], ['Starting', 'M5 3h14'],
        ['Unknown', 'M9 9a3 3'], ['Offline', 'M2 12h3'],
    ]) {
        const image = decodeImage(sessionKeyImage('Review the patch', status));
        assert.ok(image.includes(`<path d="${path}`), status);
        assert.doesNotMatch(image, /<rect x=/);
    }
});

test('the unread dot uses the chat read bit and appears only on idle keys', () => {
    assert.equal(isUnreadChat({ status: 1 }), true);
    assert.equal(isUnreadChat({ status: 33 }), false);
    assert.equal(isUnreadChat({}), false);

    const dot = /<circle cx="8" cy="7" r="3"/;
    const title = 'Review the patch';
    const unread = decodeImage(sessionKeyImage(title, 'Idle', 0, { remote: true, unread: true }));
    const read = decodeImage(sessionKeyImage(title, 'Idle', 0, { remote: true }));
    assert.match(unread, dot);
    assert.match(unread, /<path d="M9 7H7/);
    assert.doesNotMatch(read, dot);
    assert.deepEqual(titleLines(unread), titleLines(read));
    for (const status of ['Running', 'Needs input', 'Error', 'Starting', 'Unknown', 'Offline']) {
        assert.doesNotMatch(decodeImage(sessionKeyImage(title, status, 0, { unread: true })), dot);
    }
});

test('remote keys reserve space for the lower-right tunnel icon on every pulse frame', () => {
    const title = 'Improving checks display in merge section';
    const local = decodeImage(sessionKeyImage(title, 'Running'));
    const remote = decodeImage(sessionKeyImage(title, 'Running', 0, { remote: true }));
    const peak = decodeImage(sessionKeyImage(title, 'Running', 1600, { remote: true }));
    const icon = /<path d="M9 7H7/;
    assert.match(remote, icon);
    assert.doesNotMatch(local, icon);
    assert.equal(titleLines(remote).join(' '), titleLines(local).join(' '));
    assert.match(remote, /translate\(54 57\)/);
    assert.ok(Array.from(remote.matchAll(/<text x="5" y="(\d+)"/g), ([, y]) => Number(y)).at(-1) <= 58);
    assert.equal(peak, remote.replace('#133a72', '#2864ac'));
    assert.match(decodeImage(sessionKeyImage(title, 'Offline', 0, { remote: true })), icon);
});

test('the group triangle clears the title and keeps its color through a pulse', () => {
    const title = 'A long title that needs to wrap and leave the session group marker readable';
    const groupColor = '#b24dff';
    const options = { groupColor, remote: true };
    const idle = decodeImage(sessionKeyImage(title, 'Idle', 0, { ...options, unread: true }));
    const running = decodeImage(sessionKeyImage(title, 'Running', 0, options));
    const peak = decodeImage(sessionKeyImage(title, 'Running', 1600, options));
    const triangle = `<polygon points="59,2 68,2 68,11" fill="${groupColor}"/>`;
    for (const image of [idle, running, peak]) {
        assert.ok(image.includes(triangle));
        assert.match(image, /<path d="M9 7H7/);
        assert.ok(Array.from(image.matchAll(/<text x="5" y="(\d+)"/g), ([, y]) => Number(y)).at(-1) <= 58);
    }
    assert.match(idle, /<circle cx="8" cy="7" r="3"/);
    assert.doesNotMatch(decodeImage(sessionKeyImage(title, 'Idle')), /<polygon/);
    assert.equal(peak, running.replace('#133a72', '#2864ac'));
});

for (const [status, dark, bright] of [
    ['Running', '#133a72', '#2864ac'],
    ['Needs input', '#581725', '#b52d43'],
]) {
    test(`${status} pulses the full background while the title stays fixed`, () => {
        const title = 'Review the build and check the status on the deck';
        const start = decodeImage(sessionKeyImage(title, status));
        const peak = decodeImage(sessionKeyImage(title, status, 1600));
        const nextCycle = decodeImage(sessionKeyImage(title, status, 3200));
        const idle = decodeImage(sessionKeyImage(title, 'Idle'));

        assert.equal(isPulsingStatus(status), true);
        assert.ok(start.includes(`<rect width="72" height="72" fill="${dark}"`));
        assert.equal(peak, start.replace(dark, bright));
        assert.equal(nextCycle, start);
        assert.doesNotMatch(start, /<rect x="4" y="3"/);
        assert.deepEqual(titleLines(start), titleLines(idle));
        if (status === 'Needs input') assert.match(start, /<path d="M21 11.5/);
    });
}
