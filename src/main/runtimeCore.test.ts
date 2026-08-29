import { describe, expect, it } from 'vitest';
import { actionEvidence, approvalPreview, assessRuntimeOutcome, capabilityHorizon, classifyRuntimeRisk, requiresFreshApproval, stableActionDigest, toolRisk } from './runtimeCore';

describe('runtime risk classification', () => {
  it('chooses the highest consequential class before generic write language', () => {
    expect(classifyRuntimeRisk('Delete the obsolete project folder')).toBe('destructive');
    expect(classifyRuntimeRisk('Send the finished report to Sarah')).toBe('external');
    expect(classifyRuntimeRisk('Run this PowerShell command as administrator')).toBe('privileged');
    expect(classifyRuntimeRisk('Create a local draft')).toBe('write');
    expect(classifyRuntimeRisk('What time is it?')).toBe('read');
  });

  it('upgrades tool-specific destructive and privileged actions', () => {
    expect(toolRisk('sensitive', 'delete_project_file')).toBe('destructive');
    expect(toolRisk('sensitive', 'execute_confirmed_powershell')).toBe('privileged');
    expect(toolRisk('write', 'control_application_window', {action:'close'})).toBe('destructive');
    expect(toolRisk('write', 'control_application_window', {action:'minimize'})).toBe('write');
    expect(toolRisk('read', 'list_directory')).toBe('read');
    expect(toolRisk('write','homebridge_control',{characteristic:'LockTargetState'})).toBe('external');
    expect(toolRisk('write','homebridge_control',{characteristic:'Brightness'})).toBe('write');
  });

  it('requires fresh approval before sending a WhatsApp message, same as gmail_send',()=>{
    expect(toolRisk('sensitive','whatsapp_send_message')).toBe('external');
    expect(requiresFreshApproval(toolRisk('sensitive','whatsapp_send_message'))).toBe(true);
    // Read-only connector tools (Stripe/Klaviyo) stay at their declared
    // base risk — nothing about their name matches the send/publish/
    // purchase/upload escalation.
    expect(toolRisk('sensitive','stripe_payments')).toBe('sensitive');
    expect(toolRisk('sensitive','klaviyo_campaigns')).toBe('sensitive');
  });

  it('permanently deletes memory only with the same destructive escalation as remove_skill/remove_agent',()=>{
    // forget_memory didn't contain "delete"/"remove" so it slipped past the
    // generic escalation regex those two rely on, executing an
    // unrecoverable delete with no fresh-approval prompt.
    expect(toolRisk('sensitive','forget_memory')).toBe('destructive');
    expect(toolRisk('sensitive','remove_skill')).toBe('destructive');
    expect(toolRisk('sensitive','remove_agent')).toBe('destructive');
  });

  it('escalates browser_click and its desktop-native equivalents using one shared consequential-label definition',()=>{
    // browser_click used to hand-roll a narrower copy of CONSEQUENTIAL_
    // CONTROL that had drifted to omit delete/remove/checkout/subscribe/
    // transfer/withdraw — an exact click on "Delete Account" never
    // escalated. invoke_application_control/select_application_menu (the
    // desktop-native equivalent of clicking a labeled control) had no
    // content-based escalation at all.
    expect(toolRisk('sensitive','browser_click',{text:'Delete Account'})).toBe('external');
    expect(toolRisk('sensitive','browser_click',{text:'Withdraw Funds'})).toBe('external');
    expect(toolRisk('sensitive','browser_click',{text:'Cancel'})).toBe('sensitive');
    expect(toolRisk('sensitive','invoke_application_control',{selector:'Delete Account'})).toBe('external');
    expect(toolRisk('sensitive','invoke_application_control',{selector:'Cancel'})).toBe('sensitive');
    expect(toolRisk('sensitive','select_application_menu',{item:'Checkout'})).toBe('external');
    expect(toolRisk('sensitive','select_application_menu',{menu:'File',item:'Save',subitem:'Confirm Purchase'})).toBe('external');
    expect(toolRisk('sensitive','select_application_menu',{menu:'File',item:'Save'})).toBe('sensitive');
  });

  it('requires fresh authority only for external and destructive effects', () => {
    expect(requiresFreshApproval('destructive')).toBe(true);
    expect(requiresFreshApproval('external')).toBe(true);
    expect(requiresFreshApproval('write')).toBe(false);
    expect(requiresFreshApproval('privileged')).toBe(false);
  });

  it('fingerprints semantically identical argument objects consistently', () => {
    expect(stableActionDigest('delete_project_file',{path:'a.ts',reason:'obsolete'})).toBe(stableActionDigest('delete_project_file',{reason:'obsolete',path:'a.ts'}));
    expect(stableActionDigest('delete_project_file',{path:'a.ts'})).not.toBe(stableActionDigest('delete_project_file',{path:'b.ts'}));
    expect(approvalPreview('delete_project_file',{path:'src/old.ts'})).toMatchObject({preview:'Delete project file src/old.ts.'});
    expect(approvalPreview('homebridge_control',{target:'Front Door',characteristic:'LockTargetState',value:0}).preview).toContain('Front Door');
  });

  // Real, live bug: control_application_window's actual schema field is
  // `application`, not `target` — approvalPreview() was reading the wrong
  // key, so every close-window approval showed "Close application window ."
  // with the real app name silently missing, no matter what the model sent.
  it('names the real application in a close-window approval preview, not an empty field', () => {
    expect(approvalPreview('control_application_window',{application:'Slack',action:'close'}).preview).toContain('Slack');
    expect(approvalPreview('control_application_window',{application:'Slack',action:'close'}).preview).not.toBe('Close application window “”.');
  });
});

describe('runtime evidence', () => {
  it('creates integrity evidence only for verified actions', () => {
    const verified=actionEvidence({name:'write_text_file',status:'verified',summary:'Wrote and verified a text file',at:'2026-08-20T12:00:00.000Z',actionId:'action-1',evidenceId:'evidence-1',resultDigest:'result-hash'},'task-1');
    expect(verified).toMatchObject({id:'evidence-1',actionId:'action-1',taskId:'task-1',kind:'tool-result',resultDigest:'result-hash'});
    expect(verified?.integrity).toMatch(/^[a-f0-9]{64}$/);
    expect(actionEvidence({name:'write_text_file',status:'failed',summary:'failed',at:'2026-08-20T12:00:00.000Z',actionId:'action-2'})).toBeUndefined();
  });

  it('keeps a unique, prioritized capability horizon', () => {
    expect(new Set(capabilityHorizon.map((item)=>item.id)).size).toBe(capabilityHorizon.length);
    expect(capabilityHorizon[0].priority).toBeGreaterThan(capabilityHorizon.at(-1)!.priority);
    expect(new Set(capabilityHorizon.map((item)=>item.stage))).toEqual(new Set(['today','engineering','experimental','future']));
  });
});

describe('evidence-aware task outcomes',()=>{
  const at='2026-08-22T12:00:00.000Z';
  it('never marks an action complete without verified evidence',()=>{
    expect(assessRuntimeOutcome([],true)).toMatchObject({status:'failed',phase:'blocked'});
    expect(assessRuntimeOutcome([{name:'write_text_file',status:'failed',summary:'Disk full',at}],true)).toMatchObject({status:'failed',blocker:'Disk full'});
  });
  it('distinguishes approval waits from capability blockers',()=>{
    expect(assessRuntimeOutcome([{name:'browser_click',status:'blocked',summary:'AX-123456 awaiting approval',at,approvalId:'approval-1'}],true)).toMatchObject({status:'waiting',phase:'awaiting-approval'});
    expect(assessRuntimeOutcome([{name:'screen_capture',status:'blocked',summary:'Permission disabled',at}],true)).toMatchObject({status:'blocked',phase:'blocked'});
  });
  it('accepts verified actions and recovered attempts',()=>{
    expect(assessRuntimeOutcome([{name:'path_exists',status:'verified',summary:'Path verified',at}],true)).toMatchObject({status:'completed',summary:'1 verified action completed.'});
    expect(assessRuntimeOutcome([{name:'path_exists',status:'failed',summary:'Temporary timeout',at},{name:'path_exists',status:'verified',summary:'Path verified',at:'2026-08-22T12:00:01.000Z'}],true).status).toBe('completed');
  });
});
