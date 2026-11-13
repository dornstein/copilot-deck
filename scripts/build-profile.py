"""Build the bundled 5-by-3 Stream Deck profile."""

import json
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid5
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


PLUGIN = Path(__file__).resolve().parents[1] / 'com.davidorn.copilot-status.sdPlugin'
PROFILE_ID = UUID('aa0c7908-6c1e-41dd-b570-147fa6deedab')
PAGE_ID = UUID('904146bf-b515-4bca-bf9a-df3d597385e8')
PROFILE_NAME = 'Copilot Sessions'
COLUMNS, ROWS = 5, 3


def page_folder_id(page_id):
    # Stream Deck encodes a page UUID with a custom base-32 alphabet and a Z suffix.
    alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTVW'
    value = page_id.int << 2
    return ''.join(alphabet[(value >> shift) & 31] for shift in range(125, -1, -5)) + 'Z'


def main():
    manifest = json.loads((PLUGIN / 'manifest.json').read_text(encoding='utf-8'))
    plugin_id = PLUGIN.stem
    plugin = {'Name': manifest['Name'], 'UUID': plugin_id, 'Version': manifest['Version']}
    action_definitions = {action['UUID']: action for action in manifest['Actions']}
    buttons = {}
    for slot in range(COLUMNS * ROWS):
        more = slot == COLUMNS * ROWS - 1
        action_id = f'{plugin_id}.more' if more else f'{plugin_id}.slot'
        action = action_definitions[action_id]
        state = action['States'][0]
        buttons[f'{slot % COLUMNS},{slot // COLUMNS}'] = {
            'ActionID': str(uuid5(PROFILE_ID, str(slot))),
            'LinkedTitle': True,
            'Name': action['Name'],
            'Plugin': plugin,
            'Settings': {} if more else {'slot': slot},
            'State': 0,
            'States': [{
                'FontSize': state['FontSize'],
                'ShowTitle': True,
                'TitleAlignment': state['TitleAlignment'],
                'TitleColor': '#ffffff',
            }],
            'UUID': action_id,
        }

    profile = {
        'Device': {'Model': '20GBA9901', 'UUID': ''},
        'InstalledByPluginUUID': plugin_id,
        'Name': PROFILE_NAME,
        'Pages': {'Current': str(PAGE_ID), 'Pages': [str(PAGE_ID)]},
        'PreconfiguredName': PROFILE_NAME,
        'Version': '2.0',
    }
    page = {'Controllers': [{'Actions': buttons, 'Type': 'Keypad'}], 'Icon': '', 'Name': ''}
    root = f'{str(PROFILE_ID).upper()}.sdProfile'
    page_folder = f'{root}/Profiles/{page_folder_id(PAGE_ID)}'
    contents = BytesIO()
    with ZipFile(contents, 'w') as archive:
        for directory in (root, f'{root}/Profiles', page_folder):
            entry = ZipInfo(f'{directory}/')
            entry.external_attr = (0o40775 << 16) | 0x10
            archive.writestr(entry, b'')
        for path, value in {
            f'{root}/manifest.json': profile,
            f'{page_folder}/manifest.json': page,
        }.items():
            archive.writestr(ZipInfo(path), json.dumps(value, indent=2), compress_type=ZIP_DEFLATED)
    (PLUGIN / f'{PROFILE_NAME}.streamDeckProfile').write_bytes(contents.getvalue())


if __name__ == '__main__':
    main()
