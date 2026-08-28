import { describe,expect,it } from 'vitest';
import { advanceSchedule,earliestWake,normalizeSchedule,scheduleIsDue } from './schedulerCore';

describe('scheduler core',()=>{
  const now=new Date('2026-08-21T15:00:00.000Z');
  it('normalizes bounded interval schedules',()=>{
    const schedule=normalizeSchedule({kind:'interval',intervalMinutes:0},now);
    expect(schedule).toEqual({kind:'interval',intervalMinutes:60,nextRunAt:'2026-08-21T16:00:00.000Z'});
  });
  it('advances intervals from actual completion time',()=>{
    expect(advanceSchedule({kind:'interval',intervalMinutes:15,nextRunAt:'2026-08-21T14:00:00.000Z'},now).nextRunAt).toBe('2026-08-21T15:15:00.000Z');
  });
  it('recognizes due schedules and chooses the earliest wake',()=>{
    expect(scheduleIsDue({kind:'daily',dailyTime:'08:00',nextRunAt:'2026-08-21T14:59:59.000Z'},now)).toBe(true);
    expect(earliestWake(['2026-08-21T16:00:00Z','2026-08-21T15:30:00Z'])).toBe('2026-08-21T15:30:00.000Z');
  });
});
