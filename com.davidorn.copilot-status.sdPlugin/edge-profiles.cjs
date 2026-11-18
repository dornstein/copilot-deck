const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

function getEdgeProfiles() {
    const local = process.env.LOCALAPPDATA;
    if (!local) return { profiles: [] };

    const executable = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, local]
        .filter(Boolean)
        .map((root) => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
        .find(existsSync);
    if (!executable) return { profiles: [] };

    const userData = join(local, 'Microsoft', 'Edge', 'User Data');
    try {
        const { profile } = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8'));
        const profiles = Object.entries(profile?.info_cache ?? {})
            .filter(([directory, entry]) => /^(Default|Profile \d+)$/.test(directory)
                && entry && !entry.is_omitted && existsSync(join(userData, directory, 'Preferences')))
            .map(([directory, entry]) => ({
                directory,
                name: [entry.shortcut_name, entry.name].find((name) => typeof name === 'string' && name.trim()) ?? directory,
            }));
        return { executable, profiles };
    } catch {
        return { profiles: [] };
    }
}

module.exports = { getEdgeProfiles };
