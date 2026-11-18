const assert = require('node:assert/strict');
const test = require('node:test');
const { applicationForChat } = require('../com.davidorn.copilot-status.sdPlugin/app-origin.cjs');
const { sessionKeyImage } = require('../com.davidorn.copilot-status.sdPlugin/session-key.cjs');

const from = name => ({ _meta: { 'vscode.session.initiator': { name } } });

test('application badges use exact origin identities, never the agent provider', () => {
    for (const name of ['vscode', 'vscode-editor-window']) {
        assert.equal(applicationForChat(from(name), {}), 'vscode');
    }
    assert.equal(applicationForChat(from('github/autopilot'), {}), 'copilot');
    assert.equal(applicationForChat({ provider: 'copilotcli' }, {}), undefined);
    assert.equal(applicationForChat(from('unknown'), {}), undefined);
    assert.equal(applicationForChat(from('vscode'), from('github/autopilot')), 'copilot');
    assert.equal(applicationForChat(from('vscode'), from('unknown')), undefined);
    assert.equal(applicationForChat({}, {}), undefined);
});

test('known app badges occupy lower left without colliding with the title or other corners', () => {
    for (const application of ['vscode', 'copilot']) {
        for (const status of ['Idle', 'Running', 'Needs input', 'Offline']) {
            const svg = decodeURIComponent(sessionKeyImage('A long conversation title that uses the available key space',
                status, 1600, { application, remote: true, groupColor: '#ffd400', unread: true }));
            assert.ok(svg.includes(`data-app="${application}" transform="translate(5 58)`));
            assert.ok(svg.includes('translate(54 57)'), 'remote marker stays lower right');
            assert.ok(svg.includes('59,2 68,2 68,11'), 'affinity stays upper right');
            const baselines = [...svg.matchAll(/<text x="5" y="(\d+)"/g)].map(m => Number(m[1]));
            assert.ok(Math.max(...baselines) <= 58);
        }
    }
    const unmarked = sessionKeyImage('Title', 'Idle');
    assert.equal(sessionKeyImage('Title', 'Idle', 0, { application: 'unknown' }), unmarked);
});
