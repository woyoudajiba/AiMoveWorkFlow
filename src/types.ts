export type Role = 'protagonist' | 'supporting' | 'extra';
export type SourceType = 'auto' | 'novel' | 'script' | 'article' | 'paper' | 'news';
export type NarrativeMode = 'auto' | 'narrator' | 'protagonist';
export type VisualStyle = 'photorealistic' | '2d-animation' | '3d-animation';
export type View = 'story' | 'characters' | 'looks' | 'storyboard' | 'videos' | 'history' | 'projects';
export interface Character {
  id: string; name: string; role: Role; aliases: string[]; appearance: string;
  evidence: string; reference: string | null; referenceVersion?: number | null; approved: boolean; version: number;
}
export interface Scene { id: string; name: string; description: string }
export interface Look { id: string; sceneId: string; characterId: string; name: string; appearance: string; reference: string | null; referenceVersion?: number | null; approved: boolean; version: number }
export interface Shot {
  id: string; number: number; duration: number; scene: string; sceneId?: string; action: string;
  camera: string; movementId?: string; movementPlan?: string; transitionPlan?: string; dialogue: string; narration?: string; sourceEvidence?: string; backgroundActors?: string; characterIds: string[]; image: string | null; imageVersion?: number | null;
  approved: boolean; version: number; trimStart: number; video: string | null; videoVersion: number | null; videoDuration?: number | null; remoteVideoDeleted?: boolean;
}
export interface Segment {
  id: string; number: number; title: string; summary: string; duration: number; episodeNumber?: number; episodeTitle?: string; boardTemplateId?: string;
  generationMode?: 'segment-board' | 'legacy-shot'; shotCount?: number;
  storyboardImage?: string | null; storyboardImageVersion?: string | null; storyboardApproved?: boolean; storyboardLayout?: Record<string, unknown>;
  video?: string | null; videoVersion?: string | null; videoDuration?: number | null; remoteVideoDeleted?: boolean;
  shots: Shot[];
}
export interface BoardTemplate { id: string; name: string; description: string; shotCapacity: number; lookCapacity: number; shotColumns: number; shotRows: number }
export interface BoardTemplateCatalog { defaultTemplateId: string; templates: BoardTemplate[] }
export interface BoardPage { number: number; gridUrl: string; shotNumbers: number[]; lookIds: string[]; continuation: boolean; layout?: Record<string, unknown> }
export interface Job {
  id: string; kind: 'analyze' | 'character' | 'look' | 'image' | 'storyboard' | 'video' | 'segment-video' | 'export'; targetId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'unknown' | 'interrupted';
  analysisProgress?: { completedChunks: number; totalChunks: number; phase: 'analyzing' | 'correcting'; model: string; currentChunk?: number; currentEpisodes?: number[] };
  analysisRetryOf?: string; analysisRetryJobId?: string; analysisRetryAcceptedAt?: string; analysisRetryable?: boolean; analysisChunk?: number; analysisAppend?: boolean; analysisBaseLength?: number; analysisBaseSegments?: number;
  progress: number; error?: string; providerTaskId?: string; businessId?: string; videoModel?: string; videoResolution?: string; estimatedCostCny?: number | null; estimatedCostCnyRange?: { min: number; max: number } | null; inputVersion?: string | number; createdAt: string; updatedAt: string;
}
export interface ExportRecord { id: string; segmentId: string; number: number; videoUrl: string; gridUrl: string; templateId?: string; pages?: BoardPage[]; manifestUrl: string; csvUrl: string; createdAt: string; projectExport?: boolean; remoteDeleted?: boolean; localOutput?: { status: 'saved' | 'failed'; directory?: string; files?: string[]; error?: string } | null }
export interface HistoryRecord extends Partial<ExportRecord> {
  id: string;
  projectId: string;
  projectTitle: string;
  segmentId?: string;
  segmentTitle?: string;
  sceneId?: string;
  sceneTitle?: string;
  shotId?: string;
  characterId?: string;
  characterName?: string;
  source?: string;
  recordType?: 'character-image' | 'look-image' | 'storyboard-image' | 'shot-image' | 'shot-video' | 'segment-video' | 'segment-export' | 'project-export';
  assetUrl?: string;
  assetTitle?: string;
  duration?: number | null;
  version?: string | number | null;
  remoteDeleted?: boolean;
}
export interface PreviewRecord { projectId: string; segmentId: string; number: number; gridUrl: string; templateId?: string; pages?: BoardPage[]; manifestUrl: string; csvUrl: string; requiresReview: boolean; hasStaleAssets?: boolean; hasUnverifiedAssets?: boolean; hasMissingReferences?: boolean; assetsCurrent?: boolean; createdAt?: string }
export interface Project {
  id: string; title: string; novel: string; style: string; visualStyle?: VisualStyle; sourceType?: SourceType; narrativeMode?: NarrativeMode; aspectRatio: '9:16' | '16:9'; duration: 15 | 30; durationMode?: 'auto' | 'fixed'; generationMode?: 'segment-board' | 'legacy-shot';
  createdAt: string; updatedAt: string; analysisSourceLength?: number; analysisSourceHash?: string | null; workflowVersion?: number; characters: Character[]; scenes?: Scene[]; looks?: Look[]; segments: Segment[]; jobs: Job[]; exports: ExportRecord[]; projectExports?: ExportRecord[]; exportHistory?: ExportRecord[];
}
export interface ProjectSummary { id: string; title: string; createdAt?: string; updatedAt: string; segmentCount: number; characterCount?: number; shotCount?: number; activeJobCount?: number }
export interface LlmModelPreset {
  id: string; label: string; description: string;
  provider: 'coding-plan' | 'token-plan'; providerLabel: string;
  speed: 'standard' | 'fast'; recommended: boolean; configured: boolean;
}
export interface PublicConfig {
  llmConfigured: boolean; grsaiConfigured: boolean; minimaxConfigured: boolean; xiongmaoMinimaxH3Configured: boolean; arkConfigured: boolean;
  codingPlanConfigured: boolean; tokenPlanConfigured: boolean; llmModels: LlmModelPreset[];
  llmModel: string; imageModel: string; videoModel: string; videoOptions: VideoModelOption[]; credentialStorage: 'encrypted' | 'session'; ffmpegAvailable: boolean;
  imageModels: { id: string; label: string; description: string }[];
}
export interface VideoResolutionOption { id: string; label: string; pricePerSecondCny: number | null; pricePerSecondCnyRange?: { min: number; max: number } | null }
export interface VideoModelOption { id: string; label: string; provider: string; providerModel?: string; quality?: string; minDurationSeconds?: number; maxDurationSeconds: number; resolutions: VideoResolutionOption[] }

export function isMiniMaxVideoModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.toLowerCase().startsWith('minimax-');
}
export function isXiongmaoVideoModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.toLowerCase().startsWith('xiongmao-');
}
export function isArkVideoModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.toLowerCase().startsWith('doubao-seedance-');
}
export interface AppState { projects: ProjectSummary[]; config: PublicConfig }
export type ShotDraft = Pick<Shot, 'scene' | 'sceneId' | 'action' | 'camera' | 'movementId' | 'movementPlan' | 'transitionPlan' | 'dialogue' | 'narration' | 'sourceEvidence' | 'backgroundActors' | 'characterIds' | 'duration' | 'trimStart'>;
export type CharacterDraft = Pick<Character, 'name' | 'role' | 'aliases' | 'appearance' | 'evidence'>;
export type LookDraft = Pick<Look, 'name' | 'appearance'>;
export type SceneDraft = Pick<Scene, 'name' | 'description'>;
export type ProjectAction = (path: string, body?: unknown, method?: string, success?: string) => Promise<Project | null>;
export type BatchKind = 'character' | 'look' | 'shot';
export type BatchActionName = 'generate' | 'approve' | 'video';
export interface BatchRequest { kind: BatchKind; action: BatchActionName; targetIds: string[]; expectedVersions: Record<string, number>; videoModel?: string; videoResolution?: string }
export interface BatchSkip { targetId: string; code: string; message: string }
export interface BatchResult { project: Project; accepted: string[]; skipped: BatchSkip[]; createdJobIds: string[] }
export type BatchAction = (request: BatchRequest) => Promise<BatchResult | null>;
export const roleNames: Record<Role, string> = { protagonist: '主角', supporting: '配角', extra: '群演' };
export const jobNames: Record<Job['kind'], string> = { analyze: '文本分析', character: '身份参考', look: '造型三视图', image: '分镜生图', storyboard: '整段分镜板', video: '镜头视频', 'segment-video': '片段完整视频', export: '成片导出' };
export const sourceTypeNames: Record<SourceType, string> = { auto: '自动识别', novel: '小说', script: '剧本', article: '讲解文章', paper: '论文', news: '新闻' };
export const visualStyleNames: Record<VisualStyle, string> = { photorealistic: '仿真人 / 写实', '2d-animation': '2D 动画', '3d-animation': '3D 动画' };
export const statusNames: Record<Job['status'], string> = { queued: '排队中', running: '进行中', completed: '已完成', failed: '失败', unknown: '待核实', interrupted: '已中断' };
export const isActive = (job: Job) => job.status === 'queued' || job.status === 'running';
export function isCurrentJob(project: Project, job: Job) {
  if (job.inputVersion === undefined && job.kind !== 'analyze') return false;
  if (job.kind === 'character') return job.inputVersion === project.characters.find(character => character.id === job.targetId)?.version;
  if (job.kind === 'look') return job.inputVersion === project.looks?.find(look => look.id === job.targetId)?.version;
  if (job.kind === 'image' || job.kind === 'video') return job.inputVersion === project.segments.flatMap(segment => segment.shots).find(shot => shot.id === job.targetId)?.version;
  if (job.kind === 'segment-video') {
    const segment = project.segments.find(item => item.id === job.targetId);
    return !!segment && job.inputVersion === JSON.stringify({ generationMode: segment.generationMode ?? project.generationMode, templateId: segment.boardTemplateId ?? 'classic-nine', storyboardImageVersion: segment.storyboardImageVersion ?? null, duration: segment.duration, aspectRatio: project.aspectRatio, shots: segment.shots.map(shot => [shot.id, shot.version, shot.imageVersion, shot.approved, shot.duration, shot.trimStart]) });
  }
  if (job.kind === 'storyboard') {
    const segment = project.segments.find(item => item.id === job.targetId);
    return !!segment && job.inputVersion === JSON.stringify({ templateId: segment.boardTemplateId ?? 'classic-nine', shots: segment.shots.map(shot => [shot.id, shot.version, shot.duration, shot.trimStart]) });
  }
  if (job.kind === 'export') {
    const segment = project.segments.find(item => item.id === job.targetId);
    return !!segment && job.inputVersion === JSON.stringify({ templateId: segment.boardTemplateId ?? 'classic-nine', shots: segment.shots.map(shot => [shot.id, shot.version, shot.videoVersion, shot.trimStart, shot.duration]) });
  }
  return true;
}
export function latestCurrentJobs(project: Project) {
  const latest = new Map<string, Job>();
  for (const job of project.jobs) {
    if (isCurrentJob(project, job)) latest.set(`${job.kind}:${job.targetId}`, job);
  }
  return [...latest.values()];
}
export function isSupersededAnalysis(project: Project, job: Job) {
  if (job.kind !== 'analyze' || job.status !== 'failed' || job.inputVersion === undefined) return false;
  const index = project.jobs.indexOf(job);
  if (index < 0 || project.characters.length === 0 || project.segments.length === 0) return false;
  return project.jobs.slice(index + 1).some(candidate => candidate.kind === 'analyze'
    && candidate.status === 'completed'
    && candidate.targetId === job.targetId
    && candidate.inputVersion === job.inputVersion);
}
export function currentProblemJobs(project: Project) {
  const latest = new Set(latestCurrentJobs(project));
  // A later attempt cannot resolve an earlier paid request with an unknown result.
  return project.jobs.filter(job => job.kind === 'analyze' && job.analysisRetryJobId ? false : job.status === 'unknown'
    ? isCurrentJob(project, job)
    : latest.has(job) && ['failed', 'interrupted'].includes(job.status));
}
export const currentVideo = (shot: Shot) => Boolean(shot.video && shot.videoVersion === shot.version && shot.approved);
export const currentSegmentVideo = (project: Project, segment: Segment) => Boolean(project.generationMode === 'segment-board' && segment.video && segment.videoVersion && segment.videoVersion === JSON.stringify({ generationMode: segment.generationMode ?? project.generationMode, templateId: segment.boardTemplateId ?? 'classic-nine', storyboardImageVersion: segment.storyboardImageVersion ?? null, duration: segment.duration, aspectRatio: project.aspectRatio, shots: segment.shots.map(shot => [shot.id, shot.version, shot.imageVersion, shot.approved, shot.duration, shot.trimStart]) }));
export const currentReference = (value: Pick<Character, 'reference' | 'referenceVersion' | 'version'>) => Boolean(value.reference && value.referenceVersion === value.version);
export const currentImage = (shot: Shot) => Boolean(shot.image && shot.imageVersion === shot.version);
export const sceneWorkflow = (project: Project) => project.workflowVersion === 2 || Boolean(project.scenes?.length || project.looks?.length);
export const identityReady = (project: Project, character: Character | undefined) => Boolean(character?.approved && character.reference && (!sceneWorkflow(project) || currentReference(character)));
export function lookFor(project: Project, sceneId: string | undefined, characterId: string) { return project.looks?.find(look => look.sceneId === sceneId && look.characterId === characterId); }
export function shotReferencesReady(project: Project, shot: Pick<Shot, 'sceneId' | 'characterIds'>) {
  if (sceneWorkflow(project) && !project.scenes?.some(scene => scene.id === shot.sceneId)) return false;
  return shot.characterIds.every(id => {
    if (!identityReady(project, project.characters.find(character => character.id === id))) return false;
    if (!sceneWorkflow(project)) return true;
    const look = lookFor(project, shot.sceneId, id);
    return Boolean(look?.approved && currentReference(look));
  });
}
export const pad = (value: number) => String(value).padStart(2, '0');
