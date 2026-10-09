import type { ExportRecord, Project } from './types';

export const LOCAL_PROJECT_DIRECTORIES = ['Actor_image', 'Story_image', 'Movie', 'Analysis'] as const;
export type LocalProjectDirectory = typeof LOCAL_PROJECT_DIRECTORIES[number];
export type LocalProjectAsset = { url: string; relativePath: string; kind: 'image' | 'video' | 'metadata' };
export type LocalProjectSyncPlan = {
  directories: readonly string[];
  snapshot: Project;
  assets: LocalProjectAsset[];
  videoUrls: string[];
};

function pad(value: number, length = 3) { return String(value).padStart(length, '0'); }
function stem(value: unknown, fallback: string) {
  const clean = String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().replace(/\s+/g, '_');
  return (clean || fallback).slice(0, 100);
}
function extension(url: string, fallback: string) {
  try {
    const pathname = new URL(url, 'https://local.invalid').pathname;
    const match = /\.([a-z0-9]{1,8})$/i.exec(pathname);
    return match ? `.${match[1].toLowerCase()}` : fallback;
  } catch { return fallback; }
}

function episodeNumberFor(segment: Project['segments'][number]) {
  return Number.isInteger(segment.episodeNumber) && (segment.episodeNumber as number) > 0 ? segment.episodeNumber as number : 1;
}

function segmentMovieCode(segment: Project['segments'][number], segments: Project['segments']) {
  const episode = episodeNumberFor(segment);
  const ordinal = segments.filter(candidate => episodeNumberFor(candidate) === episode).findIndex(candidate => candidate.id === segment.id) + 1;
  return `${episode}-${pad(ordinal > 0 ? ordinal : segment.number)}`;
}

export function mediaPathForCleanup(value: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('视频媒体地址无效。');
  let pathname: string;
  try { pathname = new URL(value, 'https://local.invalid').pathname; } catch { throw new Error('视频媒体地址无效。'); }
  const marker = pathname.indexOf('/media/');
  if (marker < 0) throw new Error('视频媒体地址必须属于项目媒体目录。');
  const result = pathname.slice(marker);
  if (!/^\/media\/[A-Za-z0-9_-]{1,100}\/(?:[^/]+\/)*[^/]+\.mp4$/i.test(result) || result.includes('..')) throw new Error('视频媒体地址无效。');
  return result;
}

export function buildLocalProjectSync(project: Project): LocalProjectSyncPlan {
  const assets = new Map<string, LocalProjectAsset>();
  const videoUrls: string[] = [];
  const movieNameCounts = new Map<string, number>();
  const add = (url: unknown, relativePath: string, kind: LocalProjectAsset['kind']) => {
    if (typeof url !== 'string' || !url.trim() || assets.has(url)) return;
    assets.set(url, { url, relativePath, kind });
    if (kind === 'video') {
      const path = mediaPathForCleanup(url);
      if (!videoUrls.includes(path)) videoUrls.push(path);
    }
  };
  const addImage = (url: unknown, relativePath: string) => add(url, relativePath, 'image');
  const addVideo = (url: unknown, relativePath: string) => add(url, relativePath, 'video');
  const addMetadata = (url: unknown, relativePath: string) => add(url, relativePath, 'metadata');
  const addVersionedVideo = (url: unknown, base: string) => {
    if (typeof url !== 'string' || !url.trim() || assets.has(url)) return;
    const count = movieNameCounts.get(base) || 0;
    movieNameCounts.set(base, count + 1);
    const suffix = count ? `（${count}）` : '';
    addVideo(url, `Movie/${base}${suffix}.mp4`);
  };

  const segments = project.segments || [];
  const segmentById = new Map(segments.map(segment => [segment.id, segment]));
  const shotSegment = new Map(segments.flatMap(segment => segment.shots.map(shot => [shot.id, segment] as const)));

  // The ledger is chronological. Allocate the base name to the first version
  // and suffix later regenerations so local copies remain inspectable.
  const mediaHistory = (project as Project & { mediaHistory?: Array<Record<string, unknown>> }).mediaHistory || [];
  mediaHistory.forEach((record, index) => {
    const url = record.assetUrl;
    const type = String(record.recordType || 'asset');
    if (!type.includes('video')) return;
    const segment = typeof record.segmentId === 'string' ? segmentById.get(record.segmentId) : undefined;
    const shot = typeof record.shotId === 'string' ? segment?.shots.find(item => item.id === record.shotId) || shotSegment.get(record.shotId)?.shots.find(item => item.id === record.shotId) : undefined;
    const base = type === 'segment-video' && segment
      ? segmentMovieCode(segment, segments)
      : type === 'shot-video' && segment && shot
        ? `${segmentMovieCode(segment, segments)}-shot-${pad(shot.number, 2)}`
        : `history-${pad(index + 1)}`;
    addVersionedVideo(url, base);
  });

  project.characters.forEach((character, index) => {
    addImage(character.reference, `Actor_image/character-${pad(index + 1)}-${stem(character.name, 'character')}${extension(character.reference || '', '.png')}`);
  });
  (project.looks || []).forEach((look, index) => {
    addImage(look.reference, `Actor_image/look-${pad(index + 1)}-${stem(look.name, 'look')}${extension(look.reference || '', '.png')}`);
  });
  (project.assets || []).forEach((asset, index) => {
    addImage(asset.reference, `Actor_image/asset-${pad(index + 1)}-${stem(asset.name, 'asset')}${extension(asset.reference || '', '.png')}`);
  });
  segments.forEach(segment => {
    const segmentPrefix = `segment-${pad(segment.number)}`;
    const moviePrefix = segmentMovieCode(segment, segments);
    addImage(segment.storyboardImage, `Story_image/${segmentPrefix}-storyboard${extension(segment.storyboardImage || '', '.png')}`);
    addVersionedVideo(segment.video, moviePrefix);
    segment.shots.forEach(shot => {
      addImage(shot.image, `Story_image/${segmentPrefix}-shot-${pad(shot.number, 2)}${extension(shot.image || '', '.png')}`);
      addVersionedVideo(shot.video, `${moviePrefix}-shot-${pad(shot.number, 2)}`);
    });
  });
  const addExport = (record: Partial<ExportRecord>, label: string) => {
    const segment = typeof record.segmentId === 'string' ? segmentById.get(record.segmentId) : undefined;
    const prefix = record.projectExport ? 'project' : segment ? segmentMovieCode(segment, segments) : `${label}-${pad(Number(record.number) || 1)}`;
    addVersionedVideo(record.videoUrl, prefix);
    addImage(record.gridUrl, `Story_image/${prefix}-cover${extension(record.gridUrl || '', '.jpg')}`);
    addMetadata(record.manifestUrl, `Analysis/${prefix}-manifest.json`);
    addMetadata(record.csvUrl, `Analysis/${prefix}-shots.csv`);
    record.pages?.forEach((page, index) => addImage(page.gridUrl, `Story_image/${prefix}-page-${pad(index + 1, 2)}${extension(page.gridUrl || '', '.jpg')}`));
  };
  project.exports.forEach(record => addExport(record, 'export'));
  (project.projectExports || []).forEach(record => addExport(record, 'project-export'));
  (project.exportHistory || []).forEach(record => addExport(record, record.projectExport ? 'project-export-history' : 'export-history'));
  mediaHistory.forEach((record, index) => {
    const url = record.assetUrl;
    const type = String(record.recordType || 'asset');
    const base = `history-${pad(index + 1)}-${stem(record.assetTitle || type, 'asset')}`;
    if (type.includes('video')) return;
    else if (type.includes('image')) addImage(url, `Story_image/${base}${extension(typeof url === 'string' ? url : '', '.png')}`);
  });
  return { directories: LOCAL_PROJECT_DIRECTORIES, snapshot: structuredClone(project), assets: [...assets.values()], videoUrls };
}
