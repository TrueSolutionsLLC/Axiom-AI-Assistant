import { describe,expect,it } from 'vitest';
import { imageEstimate } from './media';

describe('media generation approval estimates',()=>{
  it('prices image quality and portrait/landscape multipliers deterministically',()=>{
    expect(imageEstimate('low','1024x1024')).toBe(.02);
    expect(imageEstimate('medium','1024x1536')).toBe(.12);
    expect(imageEstimate('high','1536x1024')).toBe(.375);
  });
});
