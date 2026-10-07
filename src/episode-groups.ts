import type { Segment } from './types';

export interface EpisodeGroup {
  key: string;
  episodeNumber?: number;
  title: string;
  segments: Segment[];
}

/** Keep episode navigation deterministic while preserving the source segment order. */
export function groupSegmentsByEpisode(segments: Segment[]): EpisodeGroup[] {
  const groups = new Map<string, EpisodeGroup>();
  for (const segment of segments) {
    const episodeNumber = Number.isInteger(segment.episodeNumber) && (segment.episodeNumber ?? 0) > 0
      ? segment.episodeNumber
      : undefined;
    const key = episodeNumber === undefined ? 'unassigned' : `episode:${episodeNumber}`;
    const existing = groups.get(key);
    if (existing) {
      existing.segments.push(segment);
      if (existing.title === `第${episodeNumber}集` && segment.episodeTitle?.trim()) existing.title = `第${episodeNumber}集 · ${segment.episodeTitle.trim()}`;
      continue;
    }
    const episodeTitle = segment.episodeTitle?.trim();
    groups.set(key, {
      key,
      ...(episodeNumber === undefined ? {} : { episodeNumber }),
      title: episodeNumber === undefined ? '未分集内容' : `第${episodeNumber}集${episodeTitle ? ` · ${episodeTitle}` : ''}`,
      segments: [segment],
    });
  }
  return [...groups.values()].sort((left, right) => {
    if (left.episodeNumber === undefined) return 1;
    if (right.episodeNumber === undefined) return -1;
    return left.episodeNumber - right.episodeNumber;
  });
}
