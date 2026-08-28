import { describe, expect, it } from 'vitest';
import { assessRuntimeOutcome } from './runtimeCore';
import { providerTools, requiresToolUse } from './tools';

// PowerShell is deliberately Windows-only (windowsOnlyTools in tools.ts) —
// confirmed live when this suite ran on a Mac for the first time
// (mac-native-release.mjs runs `npm test` before producing a DMG) and the
// PowerShell scenario failed because providerTools() correctly never offers
// a tool the current platform can't run.
type RouteScenario = { request: string; expected: string; platform?: NodeJS.Platform };

const routeScenarios: RouteScenario[] = [
  { request: 'What is the weather forecast next week?', expected: 'web_search' },
  { request: 'Give me the latest news headlines', expected: 'get_news_headlines' },
  { request: 'Create a text file on my Desktop', expected: 'write_text_file' },
  { request: 'Create a folder in Documents', expected: 'create_directory' },
  { request: 'Read this text file for me', expected: 'read_text_file' },
  { request: 'Open the Calculator application', expected: 'open_application' },
  { request: 'Open this website https://example.com', expected: 'open_web_address' },
  { request: 'Read the current browser page', expected: 'browser_read' },
  { request: 'Click the submit button on the website', expected: 'browser_click' },
  { request: 'Notify me when the job is complete', expected: 'show_notification' },
  { request: 'Show me where I should click', expected: 'show_cursor_guide' },
  { request: 'Check my Gmail inbox', expected: 'gmail_check' },
  { request: 'List my calendar events', expected: 'calendar_list_events' },
  { request: 'Show my Shopify sales', expected: 'shopify_sales' },
  { request: 'Inspect my Meta ad insights', expected: 'meta_insights' },
  { request: 'List the files in Dropbox', expected: 'dropbox_list_folder' },
  { request: 'Generate an image of a lunar base', expected: 'generate_image' },
  { request: 'Create a verified backup of Axiom', expected: 'create_verified_backup' },
  { request: 'List my running windows', expected: 'list_running_windows' },
  { request: 'Copy this text to the clipboard', expected: 'write_clipboard_text' },
  { request: 'Pause the current media', expected: 'control_media' },
  { request: 'Inspect this code project and run the test suite', expected: 'run_project_check' },
  { request: 'Run this PowerShell command', expected: 'request_powershell_confirmation', platform: 'win32' },
  { request: 'Show CPU, GPU, memory, disk, and temperatures', expected: 'get_system_summary' },
  { request: 'Change your eye color to violet', expected: 'set_companion_appearance' },
  { request: 'What is the local time?', expected: 'get_local_time' },
  { request: 'Do you remember who I am?', expected: 'recall_memory' },
  { request: 'Create a goal to finish the launch', expected: 'create_goal' },
  { request: 'Add this to my todo checklist', expected: 'add_todo' },
  { request: 'Save this workflow as a skill', expected: 'save_skill' },
  { request: 'Create a scheduled specialist agent', expected: 'create_agent' },
  { request: 'Remember this commitment and follow up', expected: 'create_commitment' },
  { request: 'Monitor the camera and alert me when someone arrives', expected: 'create_visual_monitor' },
];

describe('production autonomy benchmark', () => {
  it('routes at least 30 realistic requests to a compatible capability', () => {
    expect(routeScenarios.length).toBeGreaterThanOrEqual(30);
    const applicable = routeScenarios.filter((scenario) => !scenario.platform || scenario.platform === process.platform);
    const failures = applicable.flatMap(({ request, expected }) => {
      const tools = providerTools(request);
      const names = tools.map((tool) => String(tool.name ?? tool.type ?? ''));
      return names.includes(expected) && requiresToolUse(request, tools)
        ? []
        : [{ request, expected, offered: names }];
    });
    expect(failures).toEqual([]);
  });

  it('keeps the false-success rate at zero for unverified actions', () => {
    const unverified = [
      [],
      [{ name: 'write_text_file', status: 'failed' as const, summary: 'Invalid path', at: new Date().toISOString() }],
      [{ name: 'browser_click', status: 'blocked' as const, summary: 'Approval required', at: new Date().toISOString(), approvalId: 'approval-1' }],
    ];
    expect(unverified.every((events) => assessRuntimeOutcome(events, true).status !== 'completed')).toBe(true);
  });

  it('requires a verified receipt before deterministic mutation completes', () => {
    const outcome = assessRuntimeOutcome([
      { name: 'write_text_file', status: 'verified', summary: 'Wrote and verified a text file', at: new Date().toISOString(), evidenceId: 'evidence-1' },
    ], true);
    expect(outcome).toMatchObject({ status: 'completed', phase: 'completed' });
  });
});
