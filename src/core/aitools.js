'use strict';
/**
 * What the AI helper may do in the app, and the briefing it gets about how the app works.
 * The tools run through the same main-process handlers the pages use (see aiExec in main.js), so
 * every safety rule (backups, game-closed checks, path containment) applies to the AI too.
 *
 * risk: 'read'   runs straight away
 *       'change' changes the game or the app; asks the user first unless they turned on "Don't ask"
 *       'ask'    always asks, even then (restoring saves, Quick Setup, restarting Steam)
 * Deleting backups or snapshots, the Nexus key and self-update are deliberately not tools.
 */

const CONFIG_IDS = ['server', 'prefs', 'skyrim', 'custom', 'enginefixes', 'displaytweaks'];
const PAGES = ['dashboard', 'setup', 'play', 'deck', 'mods', 'cleanup', 'config', 'friends', 'session', 'backups', 'logs', 'settings'];
const LOG_IDS = ['server', 'client', 'skse', 'skseloader', 'enginefixes'];

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = description => ({ type: 'boolean', description });
const strList = description => ({ type: 'array', items: { type: 'string' }, description });
const configId = str('Config file', { enum: CONFIG_IDS });

/** [name, risk, description, properties, required] */
const DEFS = [
  // ---- looking ----
  ['get_overview', 'read', 'Versions (Skyrim, SKSE, Address Library, Skyrim Together), every dashboard health check with its one-click fix, what is running, the Nexus account and the page the user is on. Start here.', {}, []],
  ['get_load_order', 'read', 'The effective load order (what the game loads, in order), installed-but-off plugins and missing masters.', {}, []],
  ['list_mods', 'read', 'Mods the app knows: recommended catalog, custom and installed ones, with install state, version, co-op compatibility and whether SKSE plugins loaded.', { installedOnly: bool('Only installed mods') }, []],
  ['check_mod_updates', 'read', 'Asks Nexus which installed mods have newer versions (needs the Nexus key).', {}, []],
  ['cleanup_report', 'read', 'Anniversary Edition / Creation Club content that can be moved out, every plugin with its masters, and known co-op-breaking mods.', {}, []],
  ['read_config', 'read', 'Settings in a config file with labels and allowed values. By default only the well-known settings; all=true lists every key.', { file: configId, all: bool('Every key, not just the well-known ones'), section: str('Only this section') }, ['file']],
  ['list_presets', 'read', 'Ready-made setting groups for a config file (built-in and the user\'s own).', { file: configId }, ['file']],
  ['list_backups', 'read', 'Moved-out file batches (restorable), save snapshots and earlier versions of config files.', {}, []],
  ['read_log', 'read', 'The end of a log file.', { log: str('Which log', { enum: LOG_IDS }), lines: { type: 'integer', description: 'How many lines from the end (default 120, max 400)' } }, ['log']],
  ['get_crash_reports', 'read', 'Recent crash reports, summarised (probable cause, modules and plugins involved).', {}, []],
  ['get_server_session', 'read', 'The local server: running or not, players connected, port, recent problems.', {}, []],
  ['get_network_info', 'read', 'Local IPs, the public IP and the router (UPnP) port status for the server port.', {}, []],
  ['get_my_setup_code', 'read', 'The user\'s setup code (STR2-…) to send friends, plus what it contains.', {}, []],
  ['compare_setup_code', 'read', 'Compares a friend\'s setup code with this PC: version and mod differences and the load order changes needed.', { code: str('A friend\'s STR2- code') }, ['code']],
  ['list_party', 'read', 'Saved friends and whether their setups still match.', {}, []],
  ['quick_setup_plan', 'read', 'What Quick Setup would do to match a host\'s code: mods to install (exact versions), cleanup, load order.', { code: str('The host\'s code; empty uses the saved one') }, []],
  ['get_steam_status', 'read', 'Steam / Steam Deck integration: Play-button wrapper, Gaming Mode, whether the app is in the Steam library.', {}, []],
  ['get_app_settings', 'read', 'The app\'s own settings (player name, automatic save snapshots, interface size).', {}, []],
  ['open_page', 'read', 'Shows a page of the app to the user.', { page: str('Page', { enum: PAGES }) }, ['page']],

  // ---- changing ----
  ['set_config_values', 'change', 'Changes settings in a config file (any section/key; new keys are added). The old file is kept in config history first. Skyrim INIs need the game closed.',
    { file: configId, changes: { type: 'array', description: 'Settings to set', items: { type: 'object', properties: { section: str('INI section, e.g. Gameplay'), key: str('Key, e.g. uDifficulty'), value: str('New value as text, in the file\'s format (true/false for the server, 1/0 for Skyrim INIs)') }, required: ['section', 'key', 'value'] } } }, ['file', 'changes']],
  ['apply_preset', 'change', 'Applies a preset from list_presets to a config file.', { file: configId, name: str('Preset name') }, ['file', 'name']],
  ['save_preset', 'change', 'Saves the file\'s current well-known settings as the user\'s own preset.', { file: configId, name: str('Preset name') }, ['file', 'name']],
  ['run_fix', 'change', 'Runs the one-click fix of a dashboard check. Pass the check\'s "fix" object from get_overview unchanged.', { fix: { type: 'object', description: 'The fix object' } }, ['fix']],
  ['move_creation_club_to_backup', 'change', 'Moves Anniversary Edition add-ons (not the protected free ones USSEP needs) into the restorable backup. Friends must have the same set.', { plugins: strList('Only these plugin names; omit for all removable ones') }, []],
  ['move_mods_to_backup', 'change', 'Moves plugins and their archives out of Data into a restorable backup batch.', { plugins: strList('Plugin file names') }, ['plugins']],
  ['set_plugin_enabled', 'change', 'Turns a plugin on or off in Plugins.txt (files stay).', { plugin: str('Plugin file name'), enabled: bool('On or off') }, ['plugin', 'enabled']],
  ['restore_backup', 'change', 'Puts a moved-out batch (or some of its files) back.', { batch: str('Batch id from list_backups'), files: strList('Only these relative paths') }, ['batch']],
  ['restore_config_version', 'change', 'Puts an earlier version of a config file back (the current one is kept in history first).', { version: str('Config history id from list_backups') }, ['version']],
  ['take_save_snapshot', 'change', 'Copies the whole Saves folder into a snapshot.', { note: str('Short note') }, []],
  ['server_control', 'change', 'Starts, stops or restarts the local Skyrim Together server.', { action: str('What to do', { enum: ['start', 'stop', 'restart'] }) }, ['action']],
  ['launch_game', 'change', 'Starts Skyrim Together (snapshots saves first if that setting is on).', {}, []],
  ['match_load_order', 'change', 'Rewrites Plugins.txt to the host\'s order from their code (snapshotted first). Game must be closed.', { code: str('Host\'s STR2- code') }, ['code']],
  ['party', 'change', 'Saves a friend\'s code to the party list, or removes a friend.', { action: str('save or remove', { enum: ['save', 'remove'] }), code: str('Code, for save'), name: str('Friend name, for remove') }, ['action']],
  ['install_mod', 'change', 'Downloads and installs a mod from Nexus by id (Premium accounts; free accounts get told to use the Mods page).', { nexusId: { type: 'integer', description: 'Nexus mod id' } }, ['nexusId']],
  ['uninstall_mod', 'change', 'Uninstalls a mod the app installed (its files go to a restorable backup).', { key: str('registryKey from list_mods') }, ['key']],
  ['add_custom_mod', 'change', 'Adds a Nexus mod to the user\'s list on the Mods page.', { link: str('Nexus link or id'), category: str('Group name') }, ['link']],
  ['update_app_settings', 'change', 'Changes the app\'s own settings.', { playerName: str('Name shown to friends'), autoSnapshot: bool('Snapshot saves before every launch'), keepAutoSnapshots: { type: 'integer', description: 'How many automatic snapshots to keep (1-100)' }, uiScale: { type: 'number', description: 'Interface size 0.8-1.5' } }, []],
  ['open_router_port', 'change', 'Asks the router (UPnP) to forward the server port.', {}, []],
  ['create_bug_report', 'change', 'Creates a bug-report zip (logs, crash reports, diagnostics, passwords removed) on the Desktop.', {}, []],
  ['restore_save_snapshot', 'ask', 'Replaces the Saves folder with a snapshot (current saves are snapshotted first). Game must be closed.', { id: str('Snapshot id from list_backups') }, ['id']],
  ['run_quick_setup', 'ask', 'Runs Quick Setup with the saved host code: installs missing mods (exact versions), cleanup, load order. Long; the user may need to click downloads on Nexus.', { cleanup: bool('Move extra Anniversary content out (default true)'), loadOrder: bool('Match load order (default true)'), coopPreset: bool('Also apply the Co-op Friendly game settings') }, []],
  ['steam_play_button', 'ask', 'Linux/Steam Deck: makes Steam\'s Play button start Skyrim Together (setup) or puts it back (undo). Restarts Steam.', { action: str('setup or undo', { enum: ['setup', 'undo'] }) }, ['action']],
];

const TOOLS = DEFS.map(([name, risk, description, properties, required]) => ({ name, risk, description, properties, required }));
const byName = new Map(TOOLS.map(t => [t.name, t]));

/** OpenAI-style function specs. With changes off, only the read tools are offered. */
function specs(allowChanges) {
  return TOOLS.filter(t => allowChanges || t.risk === 'read').map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.properties, required: t.required } },
  }));
}

/** One line per tool, for servers without tool support (text protocol). */
function textList(allowChanges) {
  return TOOLS.filter(t => allowChanges || t.risk === 'read').map(t => {
    const args = Object.entries(t.properties).map(([k, p]) => `${k}${t.required.includes(k) ? '' : '?'}: ${p.enum ? p.enum.join('|') : p.type}`).join(', ');
    return `- ${t.name}(${args}): ${t.description}`;
  }).join('\n');
}

/** Checks the model's arguments against the tool's schema. Returns an error message or null. */
function checkArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || args.__invalid !== undefined) return 'Arguments must be a JSON object.';
  for (const r of tool.required) if (args[r] === undefined || args[r] === null || args[r] === '') return `Missing "${r}".`;
  for (const [k, v] of Object.entries(args)) {
    const p = tool.properties[k];
    if (!p) continue; // extra keys are ignored
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of: ${p.enum.join(', ')}.`;
    const ok = p.type === 'string' ? typeof v === 'string'
      : p.type === 'boolean' ? typeof v === 'boolean'
        : p.type === 'integer' ? Number.isInteger(v)
          : p.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
            : p.type === 'array' ? Array.isArray(v)
              : p.type === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : true;
    if (!ok) return `"${k}" must be ${p.type === 'integer' ? 'a whole number' : `a ${p.type}`}.`;
  }
  return null;
}

/** Models often send numbers and booleans as text; accept the obvious ones. */
function coerceArgs(tool, args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  for (const [k, p] of Object.entries(tool.properties)) {
    const v = out[k];
    if (typeof v !== 'string') continue;
    if ((p.type === 'integer' || p.type === 'number') && /^-?\d+(\.\d+)?$/.test(v.trim())) out[k] = Number(v);
    else if (p.type === 'boolean' && /^(true|false)$/i.test(v.trim())) out[k] = v.trim().toLowerCase() === 'true';
    else if (p.type === 'array' && v.trim().startsWith('[')) { try { out[k] = JSON.parse(v); } catch {} }
    else if (p.type === 'object' && v.trim().startsWith('{')) { try { out[k] = JSON.parse(v); } catch {} }
  }
  return out;
}

/** A one-line description of a pending change, for the approval card. */
function describeCall(name, a = {}) {
  const list = x => (Array.isArray(x) ? x.join(', ') : '');
  switch (name) {
    case 'set_config_values': return `Change ${(a.changes || []).length} setting(s) in ${a.file}: ${(a.changes || []).slice(0, 8).map(c => `[${c.section}] ${c.key}=${c.value}`).join(', ')}${(a.changes || []).length > 8 ? ' …' : ''}`;
    case 'apply_preset': return `Apply the "${a.name}" preset to ${a.file}`;
    case 'save_preset': return `Save ${a.file}'s settings as preset "${a.name}"`;
    case 'run_fix': return `Run the fix "${(a.fix && (a.fix.label || a.fix.action)) || '?'}"`;
    case 'move_creation_club_to_backup': return a.plugins && a.plugins.length ? `Move these Anniversary add-ons to backup: ${list(a.plugins)}` : 'Move all removable Anniversary add-ons to backup';
    case 'move_mods_to_backup': return `Move to backup: ${list(a.plugins)}`;
    case 'set_plugin_enabled': return `${a.enabled ? 'Turn on' : 'Turn off'} ${a.plugin}`;
    case 'restore_backup': return `Restore backup ${a.batch}${a.files && a.files.length ? ` (${a.files.length} files)` : ''}`;
    case 'restore_config_version': return `Restore config version ${a.version}`;
    case 'take_save_snapshot': return `Snapshot the saves${a.note ? ` ("${a.note}")` : ''}`;
    case 'server_control': return `${a.action[0].toUpperCase()}${a.action.slice(1)} the server`;
    case 'launch_game': return 'Start Skyrim Together';
    case 'match_load_order': return 'Rewrite Plugins.txt to match the host\'s load order';
    case 'party': return a.action === 'save' ? 'Save a friend\'s code to the party list' : `Remove ${a.name} from the party list`;
    case 'install_mod': return `Download and install Nexus mod ${a.nexusId}`;
    case 'uninstall_mod': return `Uninstall ${a.key} (files go to backup)`;
    case 'add_custom_mod': return `Add ${a.link} to your mod list`;
    case 'update_app_settings': return `Change app settings: ${Object.entries(a).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    case 'open_router_port': return 'Ask the router to forward the server port';
    case 'create_bug_report': return 'Create a bug report zip on the Desktop';
    case 'restore_save_snapshot': return `Replace your Saves folder with snapshot ${a.id}`;
    case 'run_quick_setup': return 'Run Quick Setup with the saved host code';
    case 'steam_play_button': return a.action === 'setup' ? 'Set up Steam\'s Play button for Skyrim Together (restarts Steam)' : 'Undo the Play-button setup (restarts Steam)';
    default: return name;
  }
}

/**
 * The briefing: what the app is, how co-op works, how to behave, and the current state.
 * @param s.state      short facts about this PC (from aiState in main.js)
 * @param s.allowChanges, s.autoApprove, s.textTools
 * @param s.note       the user's own extra instructions (AI settings)
 */
function systemPrompt(s) {
  const lines = [
    'You are the AI helper built into STR Companion, a desktop app (Windows, Linux, Steam Deck) that sets up, checks and runs Skyrim Special Edition for Skyrim Together Reborn (STR), the mod that lets friends play the Skyrim campaign together. You talk to the user inside the app and can use the app through tools.',
    '',
    'HOW CO-OP WORKS (facts the app relies on):',
    '- STR syncs by load order: every player needs identical plugins in identical order, the same Skyrim version and the same STR version. SKSE plugin DLLs, textures and other loose files only affect the local player.',
    '- Load order = base masters, then Skyrim.ccc entries present on disk (Anniversary/Creation Club), then active Plugins.txt entries (ESM-flagged first).',
    '- The four free Creation Club files USSEP needs and the base masters are protected and never removed.',
    '- One player hosts SkyrimTogetherServer (STServer.ini, port 10578 UDP by default; others connect to the host\'s public IP). Server settings apply when the server restarts.',
    '- SKSE and Address Library must match the game version; SKSE plugins built for another game version silently fail to load.',
    '- Skyrim rewrites its INIs and Plugins.txt when it exits, so those are only edited while the game is closed.',
    '- Setup codes (STR2-…) describe a player\'s setup; comparing codes shows exactly what differs. Quick Setup installs a host\'s exact mod versions from Nexus.',
    '',
    'THE APP\'S PAGES: Dashboard (health checks with one-click fixes), Quick Setup (match a host from their code), Play & Server, Steam & Deck, Mods (catalog, Nexus install and updates), Cleanup (Anniversary content, plugins, known incompatible mods), Config Editor (STServer.ini, SkyrimPrefs.ini, Skyrim.ini, SkyrimCustom.ini, Engine Fixes, Display Tweaks, with presets), Friends Sync (setup codes, party), Session Checklist, Backups (moved files, save snapshots, config history), Logs (logs and crash reports), Settings.',
    '',
    'SAFETY (the app enforces this; work with it): nothing is ever deleted. Removed files are moved into a restorable backup, config files are copied to config history before every change, saves can be snapshotted. So most changes can be undone with list_backups + restore_backup / restore_config_version / restore_save_snapshot. You cannot delete backups, touch the Nexus key or update the app.',
    '',
    'HOW TO WORK:',
    '- Look before you act: use the read tools to find facts instead of guessing. get_overview is the best first step for "what\'s wrong" questions.',
    '- For a task, make a short plan, do the steps with tools, then check the result (e.g. get_overview again) and say what changed and how to undo it.',
    '- Only change things the user asked for or clearly agreed to. For bigger changes (several files, load order, mods), say what you will do first.',
    '- Keep INI values in the file\'s own format: true/false in STServer.ini, 1/0 in Skyrim INIs. Use read_config to see current values and allowed options.',
    '- If a tool fails, read the error, fix the cause or explain it; don\'t repeat the same call.',
    '- Answer in plain, friendly language, short (under 200 words) unless asked for detail. Use Markdown lists and `code` for file names and settings.',
    '- If you don\'t know something about Skyrim modding, say so rather than inventing mod names, settings or versions.',
  ];
  if (!s.allowChanges) lines.push('', 'CHANGES ARE OFF: the user has only allowed looking. You can read everything, but to change something, tell the user what to do (or to turn on "Let the AI make changes" in the AI settings).');
  else if (s.autoApprove) lines.push('', 'The user lets your changes run without asking each time (except restoring saves, Quick Setup and Steam changes). Be careful and precise.');
  else lines.push('', 'Every change you make shows the user an Allow/Deny card first. If they deny it, accept that and ask what they would like instead.');
  if (s.textTools) {
    lines.push('', 'TOOLS: to use a tool, write a block exactly like this and then stop writing; the result comes back in the next message:', '```tool', '{"name": "get_overview", "arguments": {}}', '```', 'You can write several blocks at once. Available tools:', textList(s.allowChanges));
  }
  if (s.note) lines.push('', 'THE USER\'S STANDING INSTRUCTIONS (follow them unless they conflict with the safety rules):', s.note);
  if (s.state) lines.push('', 'THIS PC RIGHT NOW:', s.state);
  return lines.join('\n');
}

module.exports = { TOOLS, byName, specs, textList, checkArgs, coerceArgs, describeCall, systemPrompt, CONFIG_IDS, PAGES, LOG_IDS };
