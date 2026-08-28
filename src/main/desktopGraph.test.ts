import { describe, expect, it } from 'vitest';
import { emptyDesktopGraphData, ingestDesktopToolResult, ingestWindowSnapshot, queryDesktopGraph, snapshotDesktopGraph } from './desktopGraph';

const chrome={hwnd:1201,processId:88,processName:'chrome',title:'Axiom research',label:'Axiom research',width:1440,height:900,ownerHwnd:0,className:'Chrome_WidgetWin_1',isForeground:true};

describe('desktop object graph',()=>{
  it('preserves stable identities across repeated observations',()=>{
    const graph=emptyDesktopGraphData();ingestWindowSnapshot(graph,[chrome],'2026-08-20T10:00:00.000Z');
    const first=graph.entities.find((item)=>item.kind==='window')!;
    ingestWindowSnapshot(graph,[chrome],'2026-08-20T10:01:00.000Z');
    const second=graph.entities.find((item)=>item.kind==='window')!;
    expect(second.id).toBe(first.id);expect(second.seenCount).toBe(2);expect(graph.entities.filter((item)=>item.kind==='window')).toHaveLength(1);
  });

  it('keeps the identity when a live HWND changes title and records the change',()=>{
    const graph=emptyDesktopGraphData();ingestWindowSnapshot(graph,[chrome],'2026-08-20T10:00:00.000Z');const id=graph.entities.find((item)=>item.kind==='window')!.id;
    ingestWindowSnapshot(graph,[{...chrome,title:'Axiom architecture'}],'2026-08-20T10:02:00.000Z');
    expect(graph.entities.find((item)=>item.kind==='window')?.id).toBe(id);expect(graph.entities.find((item)=>item.id===id)?.label).toBe('Axiom architecture');expect(graph.observations.some((item)=>item.kind==='changed')).toBe(true);
  });

  it('marks disappeared windows stale without erasing history',()=>{
    const graph=emptyDesktopGraphData();ingestWindowSnapshot(graph,[chrome],'2026-08-20T10:00:00.000Z');ingestWindowSnapshot(graph,[],'2026-08-20T10:03:00.000Z');
    const snapshot=snapshotDesktopGraph(graph);expect(snapshot.metrics.liveWindows).toBe(0);expect(snapshot.metrics.staleObjects).toBeGreaterThanOrEqual(2);expect(snapshot.observations[0].kind).toBe('disappeared');
  });

  it('maps inspected controls beneath their owning window and resolves them semantically',()=>{
    const graph=emptyDesktopGraphData();ingestWindowSnapshot(graph,[chrome],'2026-08-20T10:00:00.000Z');
    ingestDesktopToolResult(graph,'inspect_application_ui',{application:'hwnd:1201'},JSON.stringify({application:'hwnd:1201',controls:'saveButton Button "Save project"\nqueryField Edit "Search the web"'}),'2026-08-20T10:04:00.000Z');
    const controls=graph.entities.filter((item)=>item.kind==='control');expect(controls).toHaveLength(2);expect(queryDesktopGraph(graph,'save project')[0]?.kind).toBe('control');expect(graph.relations.some((item)=>item.toId===controls[0].id)).toBe(true);
  });
});
