import type { BoardTemplate, Shot } from './types';

type PlannedShot = Pick<Shot, 'number' | 'sceneId' | 'scene' | 'characterIds'>;
export interface PlannedBoardPage {
  number: number; shotNumbers: number[]; lookCount: number; continuation: boolean;
  emptyShotSlots: number[]; emptyLookSlots: number[];
}

export function planBoardPages(shots: readonly PlannedShot[], template: Pick<BoardTemplate, 'shotCapacity' | 'lookCapacity'>) {
  const groups: { key: string; shots: PlannedShot[] }[] = [];
  for (const shot of [...shots].sort((a, b) => a.number - b.number)) {
    const key = shot.sceneId ?? `legacy:${shot.scene}`;
    if (groups.at(-1)?.key !== key) groups.push({ key, shots: [] });
    groups.at(-1)!.shots.push(shot);
  }
  const pages: PlannedBoardPage[] = [];
  const emptySlots = (used: number, capacity: number) => Array.from({ length: capacity - used }, (_, index) => used + index + 1);
  for (const group of groups) {
    for (let offset = 0; offset < group.shots.length; offset += template.shotCapacity) {
      const pageShots = group.shots.slice(offset, offset + template.shotCapacity);
      const lookCount = new Set(pageShots.flatMap(shot => shot.characterIds)).size;
      for (let lookOffset = 0; lookOffset < Math.max(1, lookCount); lookOffset += template.lookCapacity) {
        const pageLookCount = Math.min(template.lookCapacity, lookCount - lookOffset);
        pages.push({
          number: pages.length + 1,
          shotNumbers: pageShots.map(shot => shot.number),
          lookCount: pageLookCount,
          continuation: lookOffset > 0,
          emptyShotSlots: emptySlots(pageShots.length, template.shotCapacity),
          emptyLookSlots: emptySlots(pageLookCount, template.lookCapacity),
        });
      }
    }
  }
  return {
    pages,
    continuationPages: pages.filter(page => page.continuation).length,
    emptyShotSlots: pages.reduce((sum, page) => sum + page.emptyShotSlots.length, 0),
    emptyLookSlots: pages.reduce((sum, page) => sum + page.emptyLookSlots.length, 0),
  };
}
