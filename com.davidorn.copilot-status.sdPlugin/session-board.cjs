const { createHash } = require('node:crypto');

const slotsPerBank = 13;
const groupPalette = [
    '#ffd400', '#00e676', '#b24dff', '#ff7800', '#00d9ff',
    '#ff39d4', '#a8f000', '#ff453a', '#4d8dff', '#ff4081',
];

function sessionKey(session) {
    return session && `${session.source ?? 'local'}\0${session.resource}`;
}

function groupKey(chat) {
    return chat?.sessionResource && `${chat.source ?? 'local'}\0${chat.sessionResource}`;
}

function activityTime(chat) {
    const chatTime = Date.parse(chat.modifiedAt);
    if (Number.isFinite(chatTime)) return chatTime;
    const sessionTime = Date.parse(chat.sessionModifiedAt);
    return Number.isFinite(sessionTime) ? sessionTime : Number.NEGATIVE_INFINITY;
}

class SessionBoard {
    #slots = [];
    #groups = new Map();

    update(sessions) {
        const unassigned = new Map(sessions.map((session) => [sessionKey(session), session]));
        const vacancies = [];
        for (const [slot, existing] of this.#slots.entries()) {
            const key = sessionKey(existing);
            const session = unassigned.get(key);
            if (session) {
                this.#slots[slot] = session;
                unassigned.delete(key);
            } else {
                this.#slots[slot] = null;
                vacancies.push(slot);
            }
        }

        for (const [index, session] of Array.from(unassigned.values()).entries()) {
            this.#slots[vacancies[index] ?? this.#slots.length] = session;
        }
        while (this.#slots.length && !this.#slots.at(-1)) this.#slots.pop();
        this.#updateGroups();
    }

    #updateGroups() {
        const groups = new Map();
        for (const chat of this.#slots) {
            const key = groupKey(chat);
            if (!key) continue;
            const group = groups.get(key) ?? { count: 0, color: this.#groups.get(key)?.color };
            group.count++;
            groups.set(key, group);
        }

        // Keep a session's color reserved while any of its chats remain on the board.
        const used = new Set(Array.from(groups.values(), ({ color }) => color));
        for (const [key, group] of groups) {
            if (group.count < 2 || group.color) continue;
            const preferred = createHash('sha256').update(key).digest().readUInt32BE(0) % groupPalette.length;
            const colors = [...groupPalette.slice(preferred), ...groupPalette.slice(0, preferred)];
            group.color = colors.find((color) => !used.has(color)) ?? colors[0];
            used.add(group.color);
        }
        this.#groups = groups;
    }

    groupColorFor(chat) {
        const group = this.#groups.get(groupKey(chat));
        return group?.count >= 2 ? group.color : undefined;
    }

    compact() {
        this.#slots = this.#slots.filter(Boolean)
            .sort((left, right) => activityTime(right) - activityTime(left));
    }

    get bankCount() {
        return Math.max(1, Math.ceil(this.#slots.length / slotsPerBank));
    }

    sessionAt(bank, slot) {
        return this.#slots[bank * slotsPerBank + slot];
    }
}

module.exports = { SessionBoard, slotsPerBank };
