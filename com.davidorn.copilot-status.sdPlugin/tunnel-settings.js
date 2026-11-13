const form = document.querySelector('form');
const fieldset = form.querySelector('fieldset');
const tunnelId = document.querySelector('#tunnel-id');
const picker = document.querySelector('#tunnel-picker');
const choices = document.querySelector('#tunnels');
const connect = document.querySelector('#connect');
const disconnect = document.querySelector('#disconnect');
const cancelSignIn = document.querySelector('#cancel-sign-in');
const signInButtons = ['microsoft', 'github', 'find'].map((id) => document.getElementById(id));
const status = document.querySelector('#status');
const notice = document.querySelector('#notice');
let selectedId;
let listedTunnels;
let busy = false;
let send;

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
        if (message.event !== 'sendToPropertyInspector') return;
        const settings = message.payload;
        if (selectedId === undefined || tunnelId.value === selectedId) tunnelId.value = settings.tunnelId;
        selectedId = settings.tunnelId;
        const nextList = JSON.stringify(settings.tunnels);
        if (listedTunnels !== nextList) {
            listedTunnels = nextList;
            choices.replaceChildren(new Option('Select a tunnel', ''));
            for (const { id, label } of settings.tunnels) choices.add(new Option(label, id));
            picker.hidden = settings.tunnels.length === 0;
        }
        status.textContent = settings.tunnelStatus;
        notice.textContent = settings.notice;
        notice.hidden = !settings.notice;
        fieldset.disabled = false;
        busy = settings.busy;
        for (const button of signInButtons) button.disabled = busy;
        cancelSignIn.hidden = !settings.signingIn;
        disconnect.disabled = !selectedId;
        connect.disabled = busy || !tunnelId.validity.valid;
    };
    socket.onclose = () => {
        fieldset.disabled = true;
        status.textContent = 'Stream Deck connection closed.';
    };
};

choices.onchange = () => {
    if (choices.value) tunnelId.value = choices.value;
    connect.disabled = busy || !tunnelId.validity.valid;
};
tunnelId.oninput = () => { connect.disabled = busy || !tunnelId.validity.valid; };
form.onsubmit = (event) => {
    event.preventDefault();
    if (!busy && form.reportValidity()) send?.({ command: 'connect', id: tunnelId.value });
};
disconnect.onclick = () => send?.({ command: 'disconnect' });
cancelSignIn.onclick = () => send?.({ command: 'cancelSignIn' });
for (const button of signInButtons) {
    button.onclick = () => send?.(button.id === 'find' ? { command: 'list' } : { command: 'signIn', provider: button.id });
}
