function cornerIcon(shape, color) {
    return `<g transform="translate(4 0) scale(.55)" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${shape}</g>`;
}

const statusIcons = {
    'Needs input': cornerIcon('<path d="M21 11.5a8.5 8.5 0 0 1-12 7.75L3 21l1.75-5.5A8.5 8.5 0 1 1 21 11.5Z"/>', '#f2f5fa'),
    Error: cornerIcon('<path d="M12 3 22 21H2Z M12 9v5m0 3v.1"/>', '#ff8085'),
    Starting: cornerIcon('<path d="M5 3h14M5 21h14M7 3v4l5 5-5 5v4m10-18v4l-5 5 5 5v4"/>', '#97caff'),
    Unknown: cornerIcon('<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4.6 2.5c-1.1.7-1.6 1.2-1.6 2.5m0 3v.1"/>', '#bfcbdb'),
    Offline: cornerIcon('<path d="M2 12h3m0-5h6v10H5Zm6 2h2m-2 6h2m4-8h2v10h-2m2-5h3"/>', '#bfcbdb'),
    'Sign in': cornerIcon('<path d="M21 8a5 5 0 0 1-6.7 4.7L7 20H3v-4l7.3-7.3A5 5 0 1 1 21 8Z"/><path d="M16 7h.01"/>', '#f4ca64'),
};
const unreadDot = '<circle cx="8" cy="7" r="3" fill="#8fc6ff"/>';
const pulseColors = new Map([
    ['Running', { dark: [19, 58, 114], bright: [40, 100, 172] }],
    ['Needs input', { dark: [88, 23, 37], bright: [181, 45, 67] }],
]);
const tunnelIcon = `<g transform="translate(54 57) scale(.58)" fill="none" stroke="#e1edff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 7H7a5 5 0 0 0 0 10h2m6-10h2a5 5 0 0 1 0 10h-2M8 12h8"/>
</g>`;

// Small, simplified application marks drawn for the key's 72px coordinate space.
const applicationIcons = new Map([
    ['vscode', `<g data-app="vscode" transform="translate(5 58) scale(.75)">
        <path fill="#28a9f5" d="M11.5 0 16 2v12l-4.5 2L4.8 10.4 1.8 13 0 12V4l1.8-1 3 2.6ZM2 5.5v5L4.2 8Zm4.6 2.5 4.9 4V4Z"/>
    </g>`],
    ['copilot', `<g data-app="copilot" transform="translate(5 58) scale(.75)" fill="none" stroke="#f2f5fa" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 7v5c3 3 9 3 12 0V7M2 8H.7v3H2m12-3h1.3v3H14"/>
        <path d="M7.7 4.5C7.7 2 6.4 1.4 4 1.8 2.2 2 1.8 3 1.8 4.8s.7 2.5 2.7 2.5c2.2 0 3.2-1 3.2-2.8Zm.6 0C8.3 2 9.6 1.4 12 1.8c1.8.2 2.2 1.2 2.2 3s-.7 2.5-2.7 2.5c-2.2 0-3.2-1-3.2-2.8ZM6 9v2m4-2v2"/>
    </g>`],
]);

// Segoe UI advance widths, measured at 100px for printable ASCII on Windows.
const asciiWidths = [
    27, 28, 39, 59, 54, 82, 80, 23, 30, 30, 42, 68, 22, 40, 22, 39,
    54, 54, 54, 54, 54, 54, 54, 54, 54, 54, 22, 22, 68, 68, 68, 45,
    96, 65, 57, 62, 70, 51, 49, 69, 71, 27, 36, 58, 47, 90, 75, 75,
    56, 75, 60, 53, 52, 69, 62, 93, 59, 55, 57, 30, 38, 30, 68, 42,
    27, 51, 59, 46, 59, 52, 31, 59, 57, 24, 24, 50, 24, 86, 57, 59,
    59, 59, 35, 42, 34, 57, 48, 72, 46, 48, 45, 30, 24, 30, 68,
];
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const titleTop = 13;
const titleHeight = 56;
const footerTitleHeight = 47;

function glyphs(text) {
    return Array.from(segmenter.segment(text), ({ segment }) => ({
        text: segment,
        width: asciiWidths[segment.codePointAt(0) - 32] ?? 115,
    }));
}

function wrap(words, widthLimit, lineLimit) {
    const lines = [];
    let line = [];
    let width = 0;
    for (const word of words) {
        const wordWidth = word.reduce((sum, glyph) => sum + glyph.width, 0);
        if (line.length && width + asciiWidths[0] + wordWidth > widthLimit) {
            lines.push(line);
            line = [];
            width = 0;
            if (lines.length === lineLimit) return { lines, truncated: true };
        }
        if (line.length) {
            line.push({ text: ' ', width: asciiWidths[0] });
            width += asciiWidths[0];
        }
        for (const glyph of word) {
            if (width + glyph.width > widthLimit) {
                lines.push(line);
                line = [];
                width = 0;
                if (lines.length === lineLimit) return { lines, truncated: true };
            }
            line.push(glyph);
            width += glyph.width;
        }
    }
    lines.push(line);
    return { lines, truncated: false };
}

function fitTitle(title, height) {
    const words = title.split(' ').map(glyphs);
    for (const size of [12, 11, 10, 9.5, 9]) {
        const lineHeight = Math.ceil(size * 1.16);
        const widthLimit = 61 * 100 / size;
        const { lines, truncated } = wrap(words, widthLimit, Math.floor(height / lineHeight));
        if (truncated && size > 9) continue;
        if (truncated) {
            const last = lines.at(-1);
            const ellipsis = { text: '…', width: 100 };
            let width = last.reduce((sum, glyph) => sum + glyph.width, ellipsis.width);
            while (width > widthLimit) width -= last.pop().width;
            last.push(ellipsis);
        }
        return { size, lineHeight, lines: lines.map((line) => line.map(({ text }) => text).join('')) };
    }
}

function escapeXml(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function cleanText(text) {
    return text.replace(/[\p{Cc}\uFFFE\uFFFF]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function pulseBackground({ dark, bright }, elapsedMs) {
    const intensity = (1 - Math.cos(2 * Math.PI * elapsedMs / 3200)) / 2;
    return `#${dark.map((channel, index) =>
        Math.round(channel + (bright[index] - channel) * intensity).toString(16).padStart(2, '0')).join('')}`;
}

function titleMarkup(title, color, height) {
    const cleanTitle = cleanText(title) || 'Copilot';
    const { size, lineHeight, lines } = fitTitle(cleanTitle, height);
    const firstBaseline = Math.round(titleTop + (height - lines.length * lineHeight) / 2 + size);
    const text = lines.map((line, index) =>
        `<text x="5" y="${firstBaseline + index * lineHeight}">${escapeXml(line)}</text>`).join('');
    return `<g fill="${color}" font-family="Segoe UI" font-size="${size}">${text}</g>`;
}

function isPulsingStatus(status) {
    return pulseColors.has(status);
}

function sessionKeyImage(title, status, elapsedMs = 0, { remote = false, unread = false, groupColor, idleAge, application } = {}) {
    const colors = pulseColors.get(status);
    const background = colors ? pulseBackground(colors, elapsedMs) : '#161b26';
    const icon = status === 'Idle' && unread ? unreadDot : statusIcons[status] ?? '';
    const age = status === 'Idle' && idleAge
        ? `<text x="36" y="11" text-anchor="middle" fill="#c4cfdf" font-family="Segoe UI" font-size="9">${escapeXml(idleAge)}</text>`
        : '';
    const triangle = groupColor ? `<polygon points="59,2 68,2 68,11" fill="${groupColor}"/>` : '';
    const titleColor = status === 'Offline' ? '#b8c3d4' : '#f2f5fa';
    const applicationIcon = applicationIcons.get(application) ?? '';
    const titleArea = remote || applicationIcon ? footerTitleHeight : titleHeight;
    const image = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 72 72">
        <rect width="72" height="72" fill="${background}"/>
        ${title === undefined ? '' : icon}
        ${remote ? tunnelIcon : ''}
        ${age}
        ${title === undefined ? '' : titleMarkup(title, titleColor, titleArea)}
        ${triangle}
        ${applicationIcon}
    </svg>`;
    return `data:image/svg+xml,${encodeURIComponent(image)}`;
}

function detailsLine(text, baseline, size) {
    const width = 60;
    const line = glyphs(cleanText(text));
    let lineWidth = line.reduce((sum, glyph) => sum + glyph.width, 0);
    const fontSize = Math.min(size, Math.max(9, Math.floor(width * 200 / lineWidth) / 2));
    const widthLimit = width * 100 / fontSize;
    if (lineWidth > widthLimit) {
        while (lineWidth + 100 > widthLimit) lineWidth -= line.pop().width;
        line.push({ text: '…' });
    }
    const content = escapeXml(line.map(({ text }) => text).join(''));
    return `<text x="6" y="${baseline}" font-size="${fontSize}">${content}</text>`;
}

function workspaceName(chat) {
    const chatDirectory = chat.workingDirectories?.[0] ?? chat.workingDirectory;
    if (typeof chatDirectory === 'string') return directoryName(chatDirectory);
    if (typeof chat.projectName === 'string' && chat.projectName.trim()) return chat.projectName;
    return directoryName(chat.sessionWorkingDirectory);
}

function directoryName(directory) {
    if (typeof directory !== 'string') return;
    try {
        const url = new URL(directory);
        if (url.protocol === 'file:') return decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname);
    } catch {
        // Some older hosts supply a path instead of a file URI.
    }
    return directory.split(/[\\/]/).filter(Boolean).at(-1);
}

function chatRole(chat) {
    if (chat.resource === chat.defaultChat || chat.resource === chat.sessionResource
        || (!chat.defaultChat && chat.resource.startsWith('ahp-chat://default/'))) return 'Main chat';
    switch (chat.origin?.kind) {
        case 'sideChat': return 'Side chat';
        case 'fork': return 'Forked chat';
        case 'tool': return 'Tool chat';
        default: return undefined;
    }
}

function chatDetailsImage(chat, { remote, tunnelName }) {
    const location = remote ? tunnelName || 'Remote' : 'This PC';
    const rows = [
        [location, 11],
        [workspaceName(chat), 12],
        [chatRole(chat), 10],
    ].filter(([text]) => text);
    const rowHeight = 16;
    const firstBaseline = 41 - (rows.length - 1) * rowHeight / 2;
    const body = rows.map(([text, size], index) => detailsLine(text, firstBaseline + index * rowHeight, size)).join('');
    const image = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 72 72">
        <rect width="72" height="72" fill="#ffffff"/>
        <g fill="#000000" font-family="Segoe UI">${body}</g>
    </svg>`;
    return `data:image/svg+xml,${encodeURIComponent(image)}`;
}

module.exports = { chatDetailsImage, isPulsingStatus, sessionKeyImage };
