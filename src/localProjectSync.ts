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

  project.characters.forEach((character, index) => {
    addImage(character.reference, `Actor_image/character-${pad(index + 1)}-${stem(character.name, 'character')}${extension(character.reference || '', '.png')}`);
  });
  (project.looks || []).forEach((look, index) => {
    addImage(look.reference, `Actor_image/look-${pad(index + 1)}-${stem(look.name, 'look')}${extension(look.reference || '', '.png')}`);
  });
  project.segments.forEach(segment => {
    const segmentPrefix = `segment-${pad(segment.number)}`;
    addImage(segment.storyboardImage, `Story_image/${segmentPrefix}-storyboard${extension(segment.storyboardImage || '', '.png')}`);
    addVideo(segment.video, `Movie/${segmentPrefix}.mp4`);
    segment.shots.forEach(shot => {
      addImage(shot.image, `Story_image/${segmentPrefix}-shot-${pad(shot.number, 2)}${extension(shot.image || '', '.png')}`);
      addVideo(shot.video, `Movie/${segmentPrefix}-shot-${pad(shot.number, 2)}.mp4`);
    });
  });
  const addExport = (record: Partial<ExportRecord>, label: string) => {
    const prefix = `${label}-${pad(Number(record.number) || 1)}`;
    addVideo(record.videoUrl, `Movie/${prefix}.mp4`);
    addImage(record.gridUrl, `Story_image/${prefix}-cover${extension(record.gridUrl || '', '.jpg')}`);
    addMetadata(record.manifestUrl, `Analysis/${prefix}-manifest.json`);
    addMetadata(record.csvUrl, `Analysis/${prefix}-shots.csv`);
    record.pages?.forEach((page, index) => addImage(page.gridUrl, `Story_image/${prefix}-page-${pad(index + 1, 2)}${extension(page.gridUrl || '', '.jpg')}`));
  };
  project.exports.forEach(record => addExport(record, 'export'));
  (project.projectExports || []).forEach(record => addExport(record, 'project-export'));
  (project.exportHistory || []).forEach(record => addExport(record, record.projectExport ? 'project-export-history' : 'export-history'));
  const mediaHistory = (project as Project & { mediaHistory?: Array<Record<string, unknown>> }).mediaHistory || [];
  mediaHistory.forEach((record, index) => {
    const url = record.assetUrl;
    const type = String(record.recordType || 'asset');
    const base = `history-${pad(index + 1)}-${stem(record.assetTitle || type, 'asset')}`;
    if (type.includes('video')) addVideo(url, `Movie/${base}.mp4`);
    else if (type.includes('image')) addImage(url, `Story_image/${base}${extension(typeof url === 'string' ? url : '', '.png')}`);
  });
  return { directories: LOCAL_PROJECT_DIRECTORIES, snapshot: structuredClone(project), assets: [...assets.values()], videoUrls };
}
