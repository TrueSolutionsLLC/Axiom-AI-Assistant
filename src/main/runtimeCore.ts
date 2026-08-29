import crypto from 'node:crypto';
import type { CapabilityHorizonItem, EvidenceItem, RuntimeRisk, RuntimeTaskPhase, RuntimeTaskStatus, ToolEvent } from '../shared/contracts';

export interface RuntimeOutcomeAssessment {
  status: Extract<RuntimeTaskStatus, 'waiting' | 'completed' | 'failed' | 'blocked'>;
  phase: RuntimeTaskPhase;
  summary: string;
  blocker?: string;
  nextAction?: string;
}

const rules: Array<[RuntimeRisk, RegExp]> = [
  ['privileged', /\b(admin(?:istrator)?|elevat(?:e|ion)|registry|firewall|security setting|credential|password|api key|powershell)\b/i],
  ['destructive', /\b(delete|remove|erase|wipe|uninstall|overwrite|format|discard)\b/i],
  ['external', /\b(send|email|message|post|publish|upload|purchase|buy|pay|book|reserve|submit)\b/i],
  ['sensitive', /\b(camera|microphone|clipboard|screen|account|private|personal|medical|financial)\b/i],
  ['write', /\b(create|write|edit|change|rename|move|copy|open|launch|click|type|fill|install|run|execute|build)\b/i],
];

export function classifyRuntimeRisk(text: string): RuntimeRisk {
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? 'read';
}

/**
 * Labels that make a control consequential enough to need fresh approval.
 * Shared with the browser adapter so a fuzzy label match cannot resolve to a
 * higher-risk control than the one the approval decision was made against.
 */
export const CONSEQUENTIAL_CONTROL = /\b(send|submit|publish|post|buy|purchase|pay|book|reserve|confirm|place order|delete|remove|checkout|subscribe|transfer|withdraw)\b/i;

export function toolRisk(risk: 'read' | 'write' | 'sensitive', toolName: string, args: Record<string, unknown> = {}): RuntimeRisk {
  if(toolName==='homebridge_control'&&['LockTargetState','SecuritySystemTargetState','TargetDoorState'].includes(String(args.characteristic||'')))return'external';
  if (toolName === 'control_application_window' && String(args.action ?? '').toLowerCase() === 'close') return 'destructive';
  if (toolName === 'browser_press' && String(args.key ?? '') === 'Enter') return 'external';
  // Was a hand-rolled regex missing delete/remove/checkout/subscribe/
  // transfer/withdraw that CONSEQUENTIAL_CONTROL (below) already defines as
  // consequential — an exact click on "Delete Account" or "Unsubscribe"
  // never escalated past ordinary sensitive risk. Now shares one definition
  // instead of drifting out of sync with it.
  if (toolName === 'browser_click' && CONSEQUENTIAL_CONTROL.test(String(args.text ?? ''))) return 'external';
  // Desktop-native invoke/menu-select are the same kind of "activate
  // whatever this labeled control does" action browser_click is, just
  // outside the browser — but had no equivalent content check at all, so
  // invoking a button/menu item literally named "Delete Account" or
  // "Confirm Purchase" in a third-party app stayed at ordinary sensitive
  // risk and auto-executed.
  if (toolName === 'invoke_application_control' && CONSEQUENTIAL_CONTROL.test(String(args.selector ?? ''))) return 'external';
  if (toolName === 'select_application_menu' && (CONSEQUENTIAL_CONTROL.test(String(args.item ?? ''))||CONSEQUENTIAL_CONTROL.test(String(args.subitem ?? '')))) return 'external';
  // A permanent, unrecoverable delete with no checkpoint — the same shape
  // as remove_skill/remove_agent below, which do escalate because their
  // names contain "remove". forget_memory doesn't match that pattern, so it
  // was auto-executing on a bare "forget the note about X" with no fresh
  // approval and no way to recover the deleted text.
  if (toolName === 'forget_memory') return 'destructive';
  if (/delete|remove|close|restore_project_checkpoint/.test(toolName)) return 'destructive';
  if (/powershell/.test(toolName)) return 'privileged';
  if (/send|publish|purchase|upload/.test(toolName)) return 'external';
  if (/calendar_create_event|generate_(?:image|video)/.test(toolName)) return 'external';
  return risk;
}

// 'privileged' is deliberately excluded here, not an oversight: PowerShell
// is the only tool that resolves to it (toolRisk() below), and it
// implements its own bespoke one-time-code confirmation entirely inside its
// own execute() (a separate pendingPowerShell token, checked against
// "APPROVE <code>" in the message) — a different mechanism from this
// module's store-backed approval queue, using a different code format.
// Folding 'privileged' into this check would route execute_confirmed_
// powershell through *both* systems: the generic queue would intercept it
// before its own execute() ever ran, generate an incompatible AX-XXXXXX
// code the tool's internal logic doesn't recognize, and the confirmation
// flow would never complete. If a future tool needs 'privileged' via the
// generic path (rather than its own bespoke gate like PowerShell's), this
// function needs to learn to tell them apart — not just add the tier back.
export function requiresFreshApproval(risk: RuntimeRisk): risk is 'external' | 'destructive' {
  return risk === 'external' || risk === 'destructive';
}

export function stableActionDigest(toolName: string, args: Record<string, unknown>): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key, normalize(item)]));
    return value;
  };
  return crypto.createHash('sha256').update(`${toolName}\n${JSON.stringify(normalize(args))}`).digest('hex');
}

export function approvalPreview(toolName: string, args: Record<string, unknown>): { preview: string; recovery: string } {
  const clean = (value: unknown) => String(value ?? '').trim().slice(0, 260);
  if (toolName === 'delete_project_file') return { preview: `Delete project file ${clean(args.path)}.`, recovery: 'Axiom will create a checkpoint before deletion so the file can be restored.' };
  if (toolName === 'restore_project_checkpoint') return { preview: `Restore project checkpoint ${clean(args.checkpoint)}.`, recovery: 'Review the checkpoint manifest and rerun the project checks after restoration.' };
  // control_application_window's real schema field is `application`, not
  // `target` — reading the wrong key here silently produced "Close
  // application window ." with the actual app name missing every single
  // time this approval fired, live and reproduced: Robbie was asked to
  // approve closing a window with no way to tell which one from the text.
  if (toolName === 'control_application_window') return { preview: `Close application window “${clean(args.application)}”.`, recovery: 'Unsaved application state may not be recoverable; reopen the application if needed.' };
  if (toolName === 'browser_press') return { preview: `Press Enter in Axiom Browser. This may submit the focused form.`, recovery: 'If the site accepts the submission, recovery depends on that site.' };
  if (toolName === 'browser_click') return { preview: `Click “${clean(args.text)}” in Axiom Browser. This may create an external action.`, recovery: 'Axiom will reread the page and report the resulting state.' };
  if(toolName==='gmail_send')return{preview:`Send email to ${clean(args.to)} with subject “${clean(args.subject)}”.`,recovery:'Sent email cannot be recalled reliably; Axiom will report the Gmail message ID.'};
  if(toolName==='calendar_create_event')return{preview:`Create calendar event “${clean(args.summary)}” from ${clean(args.start)} to ${clean(args.end)}.`,recovery:'Axiom can delete the resulting event if you later authorize that removal.'};
  if(toolName==='homebridge_control')return{preview:`Authorize Homebridge to set ${clean(args.characteristic||'a characteristic')} on “${clean(args.target)}” to ${clean(args.value)}.`,recovery:'Axiom will reread the accessory state after the command. Physical security changes may require manual reversal.'};
  if(toolName==='generate_image'){const quality=String(args.quality||'medium'),size=String(args.size||'1024x1024'),base=quality==='low'?.02:quality==='high'?.25:.08,estimate=(base*(size==='1024x1024'?1:1.5)).toFixed(3);return{preview:`Generate one ${quality} ${size} image. Conservative approval cap: $${estimate} USD. Prompt: ${clean(args.prompt)}`,recovery:'Generation charges are not reversible; the resulting local image can be deleted.'};}
  if(toolName==='generate_video'){const seconds=Number(args.seconds)||4,rate=args.model==='sora-2-pro'?.3:.1;return{preview:`Generate a ${seconds}-second ${String(args.model||'sora-2')} video. Published-price estimate: $${(seconds*rate).toFixed(2)} USD. Prompt: ${clean(args.prompt)}`,recovery:'Generation charges are not reversible; the resulting local video can be deleted.'};}
  return { preview: `Authorize ${toolName.replaceAll('_',' ')}.`, recovery: 'Axiom will verify the outcome and report whether recovery is available.' };
}

export function actionEvidence(event: ToolEvent, taskId?: string): EvidenceItem | undefined {
  if (event.status !== 'verified' || !event.actionId) return undefined;
  const id = event.evidenceId ?? crypto.randomUUID();
  return {
    id,
    actionId: event.actionId,
    taskId,
    kind: 'tool-result',
    summary: event.summary,
    observedAt: event.at,
    integrity: crypto.createHash('sha256').update(`${event.actionId}\n${event.at}\n${event.name}\n${event.summary}\n${event.resultDigest ?? ''}`).digest('hex'),
    resultDigest: event.resultDigest,
  };
}

/**
 * Turns tool receipts into an honest terminal task outcome. A model response is
 * never accepted as proof that an action succeeded.
 */
export function assessRuntimeOutcome(events: ToolEvent[], actionExpected: boolean): RuntimeOutcomeAssessment {
  const approval = events.find((event) => event.status === 'blocked' && event.approvalId);
  if (approval) return {
    status: 'waiting',
    phase: 'awaiting-approval',
    summary: approval.summary,
    blocker: approval.summary,
    nextAction: 'Review the exact action in the approval queue, then approve or deny it.',
  };

  const blocked = events.find((event) => event.status === 'blocked');
  if (blocked) return {
    status: 'blocked',
    phase: 'blocked',
    summary: blocked.summary,
    blocker: blocked.summary,
    nextAction: 'Restore the reported capability or permission, then resume this task.',
  };

  const failed = events.filter((event) => event.status === 'failed');
  const verified = events.filter((event) => event.status === 'verified');
  if (failed.length) {
    const unresolved = failed.filter((failure) => !events.some((event) => event.status === 'verified' && event.name === failure.name && Date.parse(event.at) >= Date.parse(failure.at)));
    if (unresolved.length) return {
      status: 'failed',
      phase: 'blocked',
      summary: unresolved.map((event) => `${event.name.replaceAll('_', ' ')}: ${event.summary}`).join(' | ').slice(0, 1000),
      blocker: unresolved[0].summary,
      nextAction: 'Inspect the failed capability, choose a safe alternate route, and resume from the last verified step.',
    };
  }

  if (actionExpected && !verified.length) return {
    status: 'failed',
    phase: 'blocked',
    summary: 'The request required a computer action, but no capability produced verified evidence.',
    blocker: 'No verified tool receipt was produced.',
    nextAction: 'Replan with an available capability instead of answering from the model alone.',
  };

  return {
    status: 'completed',
    phase: 'completed',
    summary: verified.length ? `${verified.length} verified action${verified.length === 1 ? '' : 's'} completed.` : 'Conversation completed without a requested computer action.',
  };
}

export const capabilityHorizon: CapabilityHorizonItem[] = [
  { id:'semantic-desktop', title:'Semantic desktop object graph', stage:'engineering', priority:100, rationale:'Keep durable identities for windows, documents, controls, people, and projects across application changes.' },
  { id:'rehearsal-engine', title:'Counterfactual rehearsal engine', stage:'engineering', priority:98, rationale:'Dry-run consequential plans in disposable workspaces before touching the user’s real environment.' },
  { id:'interruptible-voice', title:'Full-duplex interruption-safe voice', stage:'today', priority:96, rationale:'Unify audio, cancellation, reasoning, tools, and avatar animation on one conversation clock.' },
  { id:'memory-provenance', title:'Evidence-backed memory fabric', stage:'engineering', priority:95, rationale:'Give every memory a source, confidence, expiry, contradiction history, and user correction path.' },
  { id:'attention-contracts', title:'Sensor attention contracts', stage:'engineering', priority:93, rationale:'Show what Axiom is observing, for which task, for how long, and with what retention.' },
  { id:'reversible-actions', title:'Universal reversible action protocol', stage:'engineering', priority:92, rationale:'Require inverse operations, checkpoints, compensation, or an explicit irreversibility warning.' },
  { id:'cross-device', title:'Encrypted cross-device continuity', stage:'engineering', priority:84, rationale:'Continue tasks across desktop, phone, tablet, vehicle, and wearables without copying unrestricted authority.' },
  { id:'workflow-learning', title:'Transparent workflow learning', stage:'experimental', priority:80, rationale:'Recognize repeated friction and propose automations without silently profiling or changing behavior.' },
  { id:'social-boundaries', title:'Multi-person social boundary model', stage:'experimental', priority:78, rationale:'Protect private context during guests, meetings, shared screens, and speaker changes.' },
  { id:'resource-conscience', title:'Cost, energy, and interruption governor', stage:'today', priority:76, rationale:'Optimize API spend, battery, heat, network use, and the human’s limited attention.' },
  { id:'skill-forge', title:'Sandboxed skill forge and certification', stage:'experimental', priority:72, rationale:'Let Axiom create missing utilities, then test, constrain, sign, and roll them back safely.' },
  { id:'intent-understanding', title:'Reliable unspoken intent understanding', stage:'future', priority:55, rationale:'Useful as a research direction, but current systems must continue to expose uncertainty and ask when consequences matter.' },
];
