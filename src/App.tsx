import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, BookOpen, Box, CalendarDays, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Clapperboard, Clock3, Download, Eye, FileImage, Film, FolderCog, FolderOpen, Grid2X2, History, Layers3, LayoutGrid, LogOut, Menu, MonitorDown, Play, Plus, RefreshCw, Save, Search, Settings2, ShieldCheck, Shirt, Sparkles, Trash2, Users, Video, X } from 'lucide-react';
import { api, assetPreviewUrl, assetUrl, isMissingProjectError, readableError } from './api';
import { Badge, BatchSelectCheckbox, EmptyImage, ImageLightbox, Modal, Notice, SectionEmpty, Spinner, ToastRegion } from './components';
import { BatchDialog, ImportDialog, JobsDialog, SettingsDialog } from './dialogs';
import { llmPickerItems, ModelPicker, videoPickerItems } from './model-picker';
import { CharacterEditor, characterDraft, ShotEditor, shotDraft } from './editors';
import { AssetsWorkspace } from './assets';
import { CharacterLibrary } from './character-library';
import { LooksWorkspace, lookDraft, sceneDraft } from './looks';
import { BoardPages, BoardTemplatePicker } from './boards';
import { groupSegmentsByEpisode, type EpisodeGroup } from './episode-groups';
import { useDrafts } from './useDrafts';
import { appendNovelContent, storyDraftContentConflict, type StoryDraft } from './drafts';
import { useAccount } from './accountContext';
import type { AccountStorage } from './accountStorage';
import { LegacyImport } from './LegacyImport';
import { readWorkspaceRecovery, writeWorkspaceRecovery } from './workspaceRecovery';
import { hasDesktopUpdateBridge } from './desktop-update';
import { buildLocalProjectSync, LOCAL_PROJECT_DIRECTORIES } from './localProjectSync';
import { createProjectCache } from './project-cache';
// The same small runtime module is imported by Node tests and Vite; its typed
// notification event shape is enforced at the effect boundary below.
// @ts-expect-error Vite resolves the adjacent .mjs module at build time.
import { collectTaskNotifications } from './task-notifications.mjs';
import { sendTaskNotification } from './task-notification-effects';
import './recovery.css';
import './shot-ratios.css';
import { currentImage, currentProblemJobs, currentSegmentVideo, currentVideo, identityReady, isActive, isArkVideoModel, isCurrentJob, isMiniMaxVideoModel, isXiongmaoVideoModel, latestCurrentJobs, pad, roleNames, shotReferencesReady, sourceTypeNames, visualStyleNames, type AppState, type BatchAction, type BatchRequest, type BatchResult, type BoardTemplate, type BoardTemplateCatalog, type CharacterDraft, type ExportRecord, type HistoryRecord, type Job, type LookDraft, type PreviewRecord, type Project, type ProjectSummary, type PublicConfig, type SceneDraft, type Segment, type Shot, type ShotDraft, type View } from './types';

const views = [
  { id: 'story' as const, name: '原始内容', subtitle: '内容是所有镜头的起点', icon: BookOpen },
  { id: 'characters' as const, name: '人物身份', subtitle: '先确定同一张脸，再为每个场景准备造型', icon: Users },
  { id: 'assets' as const, name: '关键物品', subtitle: '统一武器、服饰和重要道具的连续性参考', icon: Box },
  { id: 'looks' as const, name: '场景造型', subtitle: '同一个人，不同场景；每套造型都有正、侧、背三视图', icon: Shirt },
  { id: 'storyboard' as const, name: '分镜审核', subtitle: '在故事成为影像之前，把每一帧想清楚', icon: LayoutGrid },
  { id: 'videos' as const, name: '视频与导出', subtitle: '把审核后的画面，连接成一段完整的故事', icon: Clapperboard },
];
const historyView = { id: 'history' as const, name: '历史记录', subtitle: '查看所有项目的导出文件与设定板', icon: History };
const projectsView = { id: 'projects' as const, name: '项目管理', subtitle: '集中查看、打开和整理你的短剧项目', icon: FolderCog };
const clientDownloadUrl = (() => {
  const env = (import.meta as unknown as { env?: { VITE_CLIENT_DOWNLOAD_URL?: string; BASE_URL?: string } }).env;
  const configured = env?.VITE_CLIENT_DOWNLOAD_URL?.trim();
  if (configured) return configured;
  const base = env?.BASE_URL || './';
  return `${base.endsWith('/') ? base : `${base}/`}downloads/YingXu-2026-10-09-v11-win-x64-setup.exe`;
})();
// Only the preload bridge proves that native folder and updater APIs exist.
// User-Agent sniffing misclassifies embedded browsers as the desktop client.
const isDesktopRuntime = typeof window !== 'undefined' && Boolean(window.aiframeDesktop);

type Toast = { id: number; message: string; error: boolean };
type DesktopUpdateState = 'idle' | 'checking' | 'current' | 'available' | 'installing' | 'error';
const storyDraft = (project: Project): StoryDraft => ({ title: project.title, novel: project.novel, style: project.style, llmModel: project.llmModel || 'qwen3.7-plus' });
function rememberedProject(storage: AccountStorage | null) { try { return storage?.getItem('aiframe-project') || null; } catch { return null; } }
function rememberProject(storage: AccountStorage | null, id: string | null) {
  try { if (id) storage?.setItem('aiframe-project', id); else storage?.removeItem('aiframe-project'); } catch { /* Opening and editing remain available when browser storage is disabled. */ }
}
function updateDraft<T extends object>(drafts: Record<string, T>, key: string, saved: T, patch: Partial<T>) {
  const next = { ...drafts };
  const draft = { ...(drafts[key] || saved), ...patch };
  if (JSON.stringify(draft) === JSON.stringify(saved)) delete next[key];
  else next[key] = draft;
  return next;
}
export default function App() {
  const account = useAccount();
  const [accountStorage] = useState(() => account.storage);
  const [recoveryPoint] = useState(() => readWorkspaceRecovery(accountStorage));
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [view, setView] = useState<View>('storyboard');
  const [segmentId, setSegmentId] = useState('');
  const [shotId, setShotId] = useState('');
  const [characterId, setCharacterId] = useState('');
  const [sceneId, setSceneId] = useState('');
  const [lookId, setLookId] = useState('');
  const [showInspector, setShowInspector] = useState(true);
  const [modal, setModal] = useState<'import' | 'settings' | 'jobs' | 'preview' | 'update' | 'logout' | 'delete-project' | 'duration-reset' | 'local-sync' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deleteForceAvailable, setDeleteForceAvailable] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [shownPreview, setShownPreview] = useState<PreviewRecord | null>(null);
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewRecord>>({});
  const [templateCatalog, setTemplateCatalog] = useState<BoardTemplateCatalog | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState('');
  const [savingTemplate, setSavingTemplate] = useState<{ target: string; templateId: string } | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [batch, setBatch] = useState<'images' | 'videos' | null>(null);
  const [batchShotIds, setBatchShotIds] = useState<string[] | null>(null);
  const [videoModelSelection, setVideoModelSelection] = useState<string | null>(null);
  const [videoResolutionSelection, setVideoResolutionSelection] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [selectedCharacters, setSelectedCharacters] = useState<string[]>([]);
  const [selectedShots, setSelectedShots] = useState<string[]>([]);
  const [mobileNav, setMobileNav] = useState(false);
  const [busy, setBusy] = useState(new Set<string>());
  const [initialLoading, setInitialLoading] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [updateState, setUpdateState] = useState<DesktopUpdateState>('idle');
  const [updateInfo, setUpdateInfo] = useState<DesktopUpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState('');
  const [localFolders, setLocalFolders] = useState<Record<string, DesktopProjectFolder | null>>({});
  const [localSyncTarget, setLocalSyncTarget] = useState<ProjectSummary | null>(null);
  const [localSyncCleanup, setLocalSyncCleanup] = useState(true);
  const [localSyncBusy, setLocalSyncBusy] = useState(false);
  const [localSyncError, setLocalSyncError] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [shotDrafts, setShotDrafts, shotRecovery] = useDrafts('shot');
  const [characterDrafts, setCharacterDrafts, characterRecovery] = useDrafts('character');
  const [storyDrafts, setStoryDrafts, storyRecovery] = useDrafts('story');
  const [sceneDrafts, setSceneDrafts, sceneRecovery] = useDrafts('scene');
  const [lookDrafts, setLookDrafts, lookRecovery] = useDrafts('look');
  const activeId = useRef<string | null>(null);
  const toastSequence = useRef(0);
  const inflight = useRef(new Set<string>());
  const mutationVersion = useRef(0);
  const activeBoardKey = useRef<string | null>(null);
  const localSyncLocks = useRef(new Set<string>());
  const localSyncStatus = useRef(new Map<string, string>());
  const projectCache = useRef(createProjectCache<Project>(4));
  const projectRequest = useRef<AbortController | null>(null);
  const observedProject = useRef<Project | null>(null);
  const taskNotificationKeys = useRef(new Set<string>());
  const taskActivityAt = useRef(new Map<string, number>());
  const anyBusy = busy.size > 0;
  const episodeGroups = useMemo(() => groupSegmentsByEpisode(project?.segments ?? []), [project?.segments]);
  const selectedSegment = project?.segments.find(item => item.id === segmentId);
  const currentEpisode = episodeGroups.find(group => group.segments.some(item => item.id === selectedSegment?.id)) || episodeGroups[0];
  const episodeSegments = currentEpisode?.segments ?? [];
  const segment = selectedSegment || episodeSegments[0] || project?.segments[0];
  const segmentBoardMode = project?.generationMode === 'segment-board';
  const traditionalVideoMode = project?.videoMode === 'traditional';
  const storyboardVideoMode = segmentBoardMode && !traditionalVideoMode;
  const shotTotal = segment?.shots.length ?? 0;
  const storyboardCurrent = Boolean(segment?.storyboardImage && segment.storyboardImageVersion);
  const selectedShot = segment?.shots.find(item => item.id === shotId) || segment?.shots[0];
  const selectedCharacter = project?.characters.find(item => item.id === characterId) || project?.characters[0];
  const characterDraftKey = `${project?.id}:${selectedCharacter?.id}`;
  const shotDraftKey = `${project?.id}:${selectedShot?.id}`;
  const activeJobs = project?.jobs.filter(isActive) || [];
  const taskProblems = project ? currentProblemJobs(project) : [];
  const selectedView = view === 'history' ? historyView : view === 'projects' ? projectsView : views.find(item => item.id === view)!;
  const hasDrafts = Object.keys(shotDrafts).length + Object.keys(characterDrafts).length + Object.keys(storyDrafts).length + Object.keys(sceneDrafts).length + Object.keys(lookDrafts).length > 0;
  const recovery = [shotRecovery, characterRecovery, storyRecovery, sceneRecovery, lookRecovery];
  const draftStorageFailed = recovery.some(item => item.status === 'unavailable' || item.status === 'skipped');
  const draftStoragePending = recovery.some(item => item.status === 'pending');
  const recoveredDrafts = recovery.flatMap(item => item.recoveredKeys).filter(key => key === project?.id || key.startsWith(`${project?.id}:`)).length;
  const templateId = segment?.boardTemplateId || templateCatalog?.defaultTemplateId || 'classic-nine';
  const boardKey = `${project?.id}:${segment?.id}:${templateId}`;
  activeBoardKey.current = view === 'storyboard' && !modal && !batch ? boardKey : null;
  const preview = previews[boardKey];

  const notify = useCallback((message: string, error = false) => {
    const id = ++toastSequence.current;
    setToasts(previous => [...previous.slice(-2), { id, message, error }]);
    window.setTimeout(() => setToasts(previous => previous.filter(item => item.id !== id)), error ? 9000 : 5500);
  }, []);
  const errorToast = useCallback((message: string) => notify(message, true), [notify]);
  const announceTaskEvents = useCallback((next: Project) => {
    const previous = observedProject.current;
    const events = collectTaskNotifications(previous, next, { notified: taskNotificationKeys.current, activityAt: taskActivityAt.current });
    observedProject.current = next;
    for (const event of events) {
      notify(event.body, event.category === 'failure' || event.category === 'stuck');
      void sendTaskNotification(event);
    }
  }, [notify]);
  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true); setTemplatesError('');
    try {
      const catalog = await api<BoardTemplateCatalog>('/api/board-templates');
      if (!catalog.templates?.length || !catalog.templates.some(template => template.id === catalog.defaultTemplateId)) throw new Error('模板目录暂不可用，请重试。');
      setTemplateCatalog(catalog);
    } catch (error) { setTemplatesError(readableError(error)); }
    finally { setTemplatesLoading(false); }
  }, []);
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true); setHistoryError('');
    try {
      const result = await api<{ records?: HistoryRecord[] } | HistoryRecord[]>('/api/ledger');
      const records = Array.isArray(result) ? result : result.records || [];
      setHistoryRecords(records);
    } catch (error) { setHistoryError(readableError(error)); }
    finally { setHistoryLoading(false); }
  }, []);
  useEffect(() => { void loadTemplates(); }, [loadTemplates]);
  useEffect(() => { if (view === 'history') void loadHistory(); }, [view, loadHistory]);
  const markBusy = (key: string, value: boolean) => {
    if (value) inflight.current.add(key); else inflight.current.delete(key);
    setBusy(new Set(inflight.current));
  };
  const acceptProject = useCallback((next: Project) => {
    projectCache.current.set(next.id, next);
    if (next.id !== activeId.current) return;
    announceTaskEvents(next);
    setProject(previous => !previous || previous.id !== next.id || new Date(next.updatedAt).getTime() >= new Date(previous.updatedAt).getTime() ? next : previous);
    setProjects(previous => [{
      id: next.id,
      title: next.title,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
      segmentCount: next.segments.length,
      characterCount: next.characters.length,
      shotCount: next.segments.reduce((total, item) => total + item.shots.length, 0),
      activeJobCount: next.jobs.filter(job => isActive(job) || job.status === 'unknown').length,
    }, ...previous.filter(item => item.id !== next.id)]);
  }, [announceTaskEvents]);
  const forgetProjectSummary = useCallback((id: string) => {
    projectCache.current.delete(id);
    setProjects(previous => previous.filter(item => item.id !== id));
    setLocalFolders(previous => {
      if (!Object.hasOwn(previous, id)) return previous;
      const next = { ...previous };
      delete next[id];
      return next;
    });
    if (rememberedProject(accountStorage) === id) rememberProject(accountStorage, null);
    if (activeId.current !== id) return;
    activeId.current = null;
    setProject(null);
    setSegmentId(''); setShotId(''); setCharacterId(''); setSceneId(''); setLookId('');
    setSelectedCharacters([]); setSelectedShots([]);
    setView('projects');
  }, [accountStorage]);
  const openProject = useCallback(async (id: string) => {
    const previousId = activeId.current;
    projectRequest.current?.abort();
    const controller = new AbortController();
    projectRequest.current = controller;
    activeId.current = id;
    setMobileNav(false);
    const cached = projectCache.current.get(id);
    const applyProject = (next: Project, restoreNavigation: boolean) => {
      if (activeId.current !== next.id) return false;
      const restore = recoveryPoint?.projectId === next.id ? recoveryPoint : null;
      const segment = next.segments.find(item => item.id === restore?.segmentId) || next.segments[0];
      const shot = segment?.shots.find(item => item.id === restore?.shotId) || segment?.shots[0];
      const character = next.characters.find(item => item.id === restore?.characterId) || next.characters[0];
      const scene = next.scenes?.find(item => item.id === restore?.sceneId) || next.scenes?.[0];
      const look = next.looks?.find(item => item.id === restore?.lookId);
      setProject(next);
      observedProject.current = next;
      if (restoreNavigation) {
        setSegmentId(segment?.id || ''); setShotId(shot?.id || ''); setCharacterId(character?.id || '');
        setSceneId(scene?.id || ''); setLookId(look?.id || '');
        setSelectedCharacters([]); setSelectedShots([]); setTemplatePickerOpen(false);
        const restoredView = restore?.view && (restore.view === 'story' || next.segments.length > 0) && !(next.generationMode === 'segment-board' && restore.view === 'looks') ? restore.view : (next.segments.length ? 'storyboard' : 'story');
        setView(restoredView);
      } else {
        setSegmentId(current => next.segments.some(item => item.id === current) ? current : segment?.id || '');
        setShotId(current => segment?.shots.some(item => item.id === current) ? current : shot?.id || '');
        setCharacterId(current => next.characters.some(item => item.id === current) ? current : character?.id || '');
        setSceneId(current => next.scenes?.some(item => item.id === current) ? current : scene?.id || '');
        setLookId(current => next.looks?.some(item => item.id === current) ? current : look?.id || '');
      }
      setShowInspector(true); setConnectionError('');
      rememberProject(accountStorage, next.id);
      return true;
    };
    if (cached) {
      applyProject(cached, true);
      setInitialLoading(false);
    } else setInitialLoading(true);
    try {
      const next = await api<Project>(`/api/projects/${id}`, 'GET', undefined, controller.signal);
      if (activeId.current !== id) return;
      projectCache.current.set(next.id, next);
      if (cached) acceptProject(next);
      else applyProject(next, true);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      if (isMissingProjectError(error)) {
        activeId.current = previousId;
        forgetProjectSummary(id);
        notify('该项目已被删除，已从项目列表移除。');
      } else if (activeId.current === id && !cached) {
        activeId.current = previousId;
        errorToast(readableError(error));
      } else if (activeId.current === id) setConnectionError(readableError(error));
    }
    finally {
      if (projectRequest.current === controller) projectRequest.current = null;
      if (activeId.current === id) setInitialLoading(false);
    }
  }, [errorToast, notify, accountStorage, recoveryPoint, forgetProjectSummary, acceptProject]);

  const loadState = useCallback(async () => {
    try {
      const state = await api<AppState>('/api/state');
      setProjects(state.projects); setConfig(state.config); setConnectionError('');
    } catch (error) { setConnectionError(readableError(error)); }
    finally { setInitialLoading(false); }
  }, [openProject, accountStorage]);
  useEffect(() => { void loadState(); }, [loadState]);
  useEffect(() => {
    if (!isDesktopRuntime || !window.aiframeDesktop) return;
    let cancelled = false;
    void Promise.all(projects.map(async item => [item.id, await window.aiframeDesktop!.getProjectFolder(account.accountKey, item.id).catch(() => null)] as const))
      .then(entries => { if (!cancelled) setLocalFolders(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [account.accountKey, projects]);
  useEffect(() => {
    if (!isDesktopRuntime || !window.aiframeDesktop || !project || initialLoading || view === 'history' || view === 'projects') return;
    const folder = localFolders[project.id];
    if (!folder) return;
    let fingerprint: string;
    try { fingerprint = localSyncFingerprint(project); } catch { return; }
    const statusKey = `${folder.path}|${fingerprint}`;
    const status = localSyncStatus.current.get(project.id);
    if (status === statusKey || status === `failed:${statusKey}` || localSyncLocks.current.has(`${project.id}:${folder.path}`)) return;
    localSyncStatus.current.set(project.id, statusKey);
    const timer = window.setTimeout(() => {
      void syncProjectToLocal(project, false, true).catch(error => {
        localSyncStatus.current.set(project.id, `failed:${statusKey}`);
        notify(`“${project.title}”自动同步失败：${readableError(error)}`, true);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [project, localFolders, initialLoading, view, notify]);
  useEffect(() => {
    if (!project || initialLoading || view === 'history' || view === 'projects') return;
    writeWorkspaceRecovery(accountStorage, {
      projectId: project.id,
      view,
      ...(segmentId ? { segmentId } : {}),
      ...(shotId ? { shotId } : {}),
      ...(characterId ? { characterId } : {}),
      ...(sceneId ? { sceneId } : {}),
      ...(lookId ? { lookId } : {}),
    });
  }, [accountStorage, project?.id, view, segmentId, shotId, characterId, sceneId, lookId, initialLoading]);
  useEffect(() => {
    if (!project || initialLoading || view === 'history' || view === 'projects') return;
    const id = project.id;
    let stopped = false;
    let pending = false;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      // Keep polling while the window is minimized or the browser tab is in
      // the background so desktop and browser notifications are not missed.
      if (pending || projectRequest.current) return;
      pending = true;
      const version = mutationVersion.current;
      try {
        const next = await api<Project>(`/api/projects/${id}`, 'GET', undefined, controller.signal);
        if (!stopped && version === mutationVersion.current) { acceptProject(next); setConnectionError(''); }
      } catch (error) {
        if (stopped) return;
        if (isMissingProjectError(error)) {
          forgetProjectSummary(id);
          notify('该项目已被删除，已从项目列表移除。');
        } else setConnectionError(readableError(error));
      }
      finally { pending = false; }
    }, activeJobs.length ? 1800 : 6000);
    return () => { stopped = true; controller.abort(); window.clearInterval(timer); };
  }, [project?.id, activeJobs.length, initialLoading, view, acceptProject, forgetProjectSummary, notify]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (hasDrafts && (draftStorageFailed || draftStoragePending)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasDrafts, draftStorageFailed, draftStoragePending]);

  async function act(path: string, body: unknown = {}, method = 'POST', success?: string): Promise<Project | null> {
    if (!activeId.current) return null;
    const id = activeId.current;
    const key = `${id}${path}`;
    if (inflight.current.has(key)) return null;
    markBusy(key, true); mutationVersion.current++;
    try {
      const next = await api<Project>(`/api/projects/${id}${path}`, method, body);
      acceptProject(next);
      if (success) notify(success);
      return next;
    } catch (error) { errorToast(readableError(error)); return null; }
    finally { markBusy(key, false); mutationVersion.current++; }
  }
  function created(next: Project) {
    activeId.current = next.id; observedProject.current = next; setProject(next); acceptProject(next); setModal(null);
    setView(next.segments.length ? 'storyboard' : 'story'); setSegmentId(next.segments[0]?.id || ''); setShotId(next.segments[0]?.shots[0]?.id || ''); setCharacterId(next.characters[0]?.id || ''); setShowInspector(true);
    setSceneId(next.scenes?.[0]?.id || ''); setLookId('');
    setSelectedCharacters([]); setSelectedShots([]); setTemplatePickerOpen(false);
    rememberProject(accountStorage, next.id);
  }
  async function createDemo() {
    if (inflight.current.has('demo')) return;
    markBusy('demo', true);
    try { created(await api<Project>('/api/demo', 'POST', {})); notify('已载入本地示例。示例只有文字规划，不会调用模型。'); }
    catch (error) { errorToast(readableError(error)); }
    finally { markBusy('demo', false); }
  }
  async function requestDeleteProject(target: ProjectSummary) {
    const key = `delete-check:${target.id}`;
    if (inflight.current.has(key)) return;
    markBusy(key, true);
    try {
      await api<Project>(`/api/projects/${target.id}`);
      setDeleteTarget(target); setDeleteForceAvailable(false); setDeleteError(''); setModal('delete-project');
    } catch (error) {
      if (isMissingProjectError(error)) {
        forgetProjectSummary(target.id);
        notify('已从项目列表移除。');
      } else errorToast(readableError(error));
    } finally { markBusy(key, false); }
  }
  async function removeProject(force = false) {
    const target = deleteTarget;
    if (!target || inflight.current.has(`delete-project:${target.id}`)) return;
    const key = `delete-project:${target.id}`;
    markBusy(key, true);
    try {
      try {
        await api<{ id: string; title: string }>(`/api/projects/${target.id}`, 'DELETE', { force });
      } catch (error) {
        if (!isMissingProjectError(error)) throw error;
      }
      forgetProjectSummary(target.id);
      setDeleteTarget(null); setDeleteForceAvailable(false); setDeleteError('');
      setModal(null);
      setView('projects');
      notify(`项目“${target.title}”已删除。`);
    } catch (error) {
      if (!force && typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === 'ACTIVE_JOB') {
        setDeleteForceAvailable(true);
        setDeleteError('项目仍有进行中或待核实任务。强制删除会立即移除项目和服务器媒体，晚到的模型结果不会再写回；已导出的本地 output 副本不受影响。');
      } else errorToast(readableError(error));
    }
    finally { markBusy(key, false); }
  }
  async function checkOrInstallUpdate(forceCheck = false) {
    const bridge = window.aiframeDesktop;
    if (updateState === 'checking' || updateState === 'installing') {
      setModal('update');
      return;
    }
    setModal('update');
    if (!hasDesktopUpdateBridge(bridge)) {
      setUpdateInfo(null);
      setUpdateState('error');
      setUpdateError('客户端更新接口未加载，请完全退出并重新打开客户端后重试。');
      return;
    }
    if (!forceCheck && updateState === 'available' && updateInfo?.available) {
      setUpdateState('installing'); setUpdateError('');
      try { await bridge.installUpdate(); notify('更新安装程序已启动，客户端将退出并完成更新。'); }
      catch (error) { setUpdateState('error'); setUpdateError(readableError(error)); errorToast(readableError(error)); }
      return;
    }
    setUpdateState('checking'); setUpdateError(''); setUpdateInfo(null);
    try {
      const result = await bridge.checkForUpdate();
      setUpdateInfo(result);
      setUpdateState(result.available ? 'available' : 'current');
      notify(result.available ? `发现新版本 v${result.displayVersion || result.version}，请在更新面板中下载并安装。` : `当前已是最新版本 v${window.aiframeDesktop?.displayVersion || result.displayVersion || result.currentVersion}，更新面板已显示。`);
    } catch (error) { setUpdateState('error'); setUpdateError(readableError(error)); errorToast(readableError(error)); }
  }
  async function chooseProjectFolder(target: ProjectSummary) {
    if (!isDesktopRuntime || !window.aiframeDesktop) return;
    try {
      const folder = await window.aiframeDesktop.chooseProjectFolder(account.accountKey, target.id, target.title);
      if (folder) { setLocalFolders(previous => ({ ...previous, [target.id]: folder })); notify(`已为“${target.title}”准备本地项目目录。`); }
    } catch (error) { errorToast(readableError(error)); }
  }
  function openLocalSync(target: ProjectSummary) {
    if (!isDesktopRuntime || !window.aiframeDesktop) return;
    if (!localFolders[target.id]) { void chooseProjectFolder(target); return; }
    setLocalSyncTarget(target); setLocalSyncCleanup(true); setLocalSyncError(''); setModal('local-sync');
  }
  function localSyncFingerprint(full: Project, plan = buildLocalProjectSync(full)) {
    const snapshot = { ...plan.snapshot, jobs: [], updatedAt: '' };
    return JSON.stringify({ snapshot, assets: plan.assets.map(asset => [asset.url, asset.relativePath, asset.kind]) });
  }
  async function syncProjectToLocal(full: Project, cleanup: boolean, silent = false) {
    const bridge = window.aiframeDesktop;
    const folder = localFolders[full.id];
    if (!bridge || !folder) throw new Error('请先选择本地项目文件夹。');
    const plan = buildLocalProjectSync(full);
    const lockKey = `${full.id}:${folder.path}`;
    if (localSyncLocks.current.has(lockKey)) return full;
    localSyncLocks.current.add(lockKey);
    try {
      const synced = await bridge.syncProjectAssets({ accountKey: account.accountKey, projectId: full.id, sessionId: account.sessionId, snapshot: plan.snapshot, assets: plan.assets });
      let latest = full;
      let latestFolder = synced.folder;
      if (cleanup && plan.videoUrls.length) {
        latest = await api<Project>(`/api/projects/${full.id}/cleanup-videos`, 'POST', { confirm: true, urls: plan.videoUrls });
        const marked = await bridge.markProjectCleaned({ accountKey: account.accountKey, projectId: full.id, videoCount: plan.videoUrls.length, snapshot: latest });
        latestFolder = marked.folder;
      }
      localSyncStatus.current.set(full.id, `${folder.path}|${localSyncFingerprint(latest)}`);
      setLocalFolders(previous => ({ ...previous, [full.id]: latestFolder }));
      if (activeId.current === latest.id) acceptProject(latest);
      setProjects(previous => previous.map(item => item.id === latest.id ? { ...item, updatedAt: latest.updatedAt, activeJobCount: latest.jobs.filter(job => isActive(job) || job.status === 'unknown').length } : item));
      if (!silent) notify(cleanup && plan.videoUrls.length ? `“${full.title}”已归档到本地，服务器视频已清理。` : `“${full.title}”的分析、图片和视频已保存到本地。`);
      return latest;
    } finally { localSyncLocks.current.delete(lockKey); }
  }
  async function syncLocalProject() {
    const target = localSyncTarget;
    if (!target || localSyncBusy) return;
    const folder = localFolders[target.id];
    if (!folder) { setLocalSyncError('请先选择本地项目文件夹。'); return; }
    setLocalSyncBusy(true); setLocalSyncError(''); localSyncStatus.current.delete(target.id);
    try {
      const full = await api<Project>(`/api/projects/${target.id}`);
      await syncProjectToLocal(full, localSyncCleanup);
      setModal(null); setLocalSyncTarget(null);
    } catch (error) { setLocalSyncError(readableError(error)); }
    finally { setLocalSyncBusy(false); }
  }
  function changeView(next: View) { setView(next); setMobileNav(false); }
  function selectSegment(id: string) { setSegmentId(id); setShotId(project?.segments.find(item => item.id === id)?.shots[0]?.id || ''); setSelectedShots([]); setTemplatePickerOpen(false); }
  function selectEpisode(key: string) {
    const group = episodeGroups.find(item => item.key === key);
    if (group?.segments[0]) selectSegment(group.segments[0].id);
  }
  function locate(job: Job) {
    if (job.kind === 'analyze') { setView('story'); return; }
    if (job.kind === 'character') { setView('characters'); setCharacterId(job.targetId); return; }
    if (job.kind === 'asset') { setView('assets'); return; }
    if (job.kind === 'look') { const look = project?.looks?.find(item => item.id === job.targetId); setView('looks'); setLookId(job.targetId); setSceneId(look?.sceneId || ''); return; }
    const targetSegment = project?.segments.find(item => item.id === job.targetId || item.shots.some(shot => shot.id === job.targetId));
    if (targetSegment) { setSegmentId(targetSegment.id); setShotId(targetSegment.shots.find(shot => shot.id === job.targetId)?.id || targetSegment.shots[0]?.id || ''); }
    setView(job.kind === 'image' || job.kind === 'storyboard' ? 'storyboard' : 'videos'); setShowInspector(true);
  }
  const selectedVideoModel = videoModelSelection ?? config?.videoModel ?? config?.videoOptions?.[0]?.id ?? 'MiniMax-H3';
  const selectedVideoOption = config?.videoOptions?.find(option => option.id.toLowerCase() === selectedVideoModel.toLowerCase());
  const selectedVideoResolution = videoResolutionSelection ?? selectedVideoOption?.resolutions[0]?.id ?? '720p';
  const selectedVideoResolutionOption = selectedVideoOption?.resolutions.find(option => option.id === selectedVideoResolution);
  const selectedVideoPrice = selectedVideoResolutionOption?.pricePerSecondCny ?? null;
  const selectedVideoPriceRange = selectedVideoResolutionOption?.pricePerSecondCnyRange ?? null;
  const selectedVideoPricePerCallRange = selectedVideoResolutionOption?.pricePerCallCnyRange ?? null;
  const selectedVideoCost = selectedVideoPrice === null || !segment ? null : Math.round(selectedVideoPrice * segment.duration * 100) / 100;
  const selectedVideoCostRange = selectedVideoPricePerCallRange && segment ? selectedVideoPricePerCallRange : selectedVideoPriceRange && segment ? { min: Math.round(selectedVideoPriceRange.min * segment.duration * 100) / 100, max: Math.round(selectedVideoPriceRange.max * segment.duration * 100) / 100 } : null;
  const selectedVideoDurationUnsupported = Boolean(segmentBoardMode && segment && selectedVideoOption && (segment.duration < (selectedVideoOption.minDurationSeconds ?? 4) || segment.duration > selectedVideoOption.maxDurationSeconds || (selectedVideoOption.minDurationSeconds === selectedVideoOption.maxDurationSeconds && segment.duration !== selectedVideoOption.minDurationSeconds)));
  function changeVideoModel(model: string) { setVideoModelSelection(model); setVideoResolutionSelection(config?.videoOptions?.find(option => option.id === model)?.resolutions[0]?.id ?? null); }
  function openBatch(kind: 'images' | 'videos', targetIds: string[] | null = null) { setBatch(kind); setBatchShotIds(kind === 'videos' ? targetIds : null); }
  function closeBatch() { setBatch(null); setBatchShotIds(null); }
  async function confirmBatch(videoModel?: string, videoResolution?: string) {
    if (!segment || !batch) return;
    const model = videoModel || selectedVideoModel;
    const resolution = videoResolution || selectedVideoResolution;
    if (batch === 'videos' && batchShotIds?.length && !segmentBoardMode) {
      const targets = segment.shots.filter(shot => batchShotIds.includes(shot.id));
      const result = await runBatch({ kind: 'shot', action: 'video', targetIds: targets.map(shot => shot.id), expectedVersions: Object.fromEntries(targets.map(shot => [shot.id, shot.version])), videoModel: model, videoResolution: resolution });
      if (result) closeBatch();
      return;
    }
    const next = await act(`/segments/${segment.id}/generate-${batch}`, batch === 'videos' ? { videoModel: model, videoResolution: resolution, reuseExisting: false } : {}, 'POST', segmentBoardMode && batch === 'videos' ? '片段完整视频任务已加入队列，可在任务面板查看进度。' : batch === 'images' && segmentBoardMode ? '整段分镜板任务已加入队列，可在任务面板查看进度。' : '制作任务已加入队列，可在任务面板查看进度。');
    if (next) closeBatch();
  }
  async function requestSegmentExport() {
    if (!segment) return;
    const hasExport = project?.exports.some(record => record.segmentId === segment.id) ?? false;
    await act(`/segments/${segment.id}/export`, {}, 'POST', hasExport ? '片段成片已重新加入导出队列。' : '片段成片已加入导出队列。');
  }
  const batchAct: BatchAction = useCallback(async (request: BatchRequest): Promise<BatchResult | null> => {
    if (!activeId.current) return null;
    const id = activeId.current;
    const key = `${id}/batch/${request.kind}/${request.action}`;
    if (inflight.current.has(key)) return null;
    markBusy(key, true); mutationVersion.current++;
    try {
      const result = await api<BatchResult>(`/api/projects/${id}/batch`, 'POST', request);
      acceptProject(result.project);
      const accepted = result.accepted.length;
      const skipped = result.skipped.length;
      if (skipped) { setBatchResult(result); notify(`${accepted} 项已提交，${skipped} 项未执行，请查看批量结果。`, accepted === 0); }
      else notify(`${accepted} 项批量操作已完成。`);
      return result;
    } catch (error) { errorToast(readableError(error)); return null; }
    finally { markBusy(key, false); mutationVersion.current++; }
  }, [acceptProject, errorToast, notify]);
  async function runBatch(request: BatchRequest) {
    const result = await batchAct(request);
    if (result && request.kind === 'character') setSelectedCharacters(previous => previous.filter(id => !result.accepted.includes(id)));
    if (result && request.kind === 'shot') setSelectedShots(previous => previous.filter(id => !result.accepted.includes(id)));
    return result;
  }
  function clearShotDraft(key: string, savedDraft?: ShotDraft) { setShotDrafts(previous => { if (JSON.stringify(previous[key]) !== JSON.stringify(savedDraft)) return previous; const next = { ...previous }; delete next[key]; return next; }); }
  function clearCharacterDraft(key: string, savedDraft?: CharacterDraft) { setCharacterDrafts(previous => { if (JSON.stringify(previous[key]) !== JSON.stringify(savedDraft)) return previous; const next = { ...previous }; delete next[key]; return next; }); }
  function clearStoryDraft(key: string, savedDraft?: StoryDraft) { setStoryDrafts(previous => { if (JSON.stringify(previous[key]) !== JSON.stringify(savedDraft)) return previous; const next = { ...previous }; delete next[key]; return next; }); }
  function clearSceneDraft(key: string, savedDraft: SceneDraft) { setSceneDrafts(previous => { if (JSON.stringify(previous[key]) !== JSON.stringify(savedDraft)) return previous; const next = { ...previous }; delete next[key]; return next; }); }
  function clearLookDraft(key: string, savedDraft: LookDraft) { setLookDrafts(previous => { if (JSON.stringify(previous[key]) !== JSON.stringify(savedDraft)) return previous; const next = { ...previous }; delete next[key]; return next; }); }
  function showLooks(id?: string) { setSceneId(id || project?.scenes?.[0]?.id || ''); setLookId(''); setView('looks'); }
  async function selectTemplate(nextTemplateId: string) {
    if (!project || !segment || nextTemplateId === templateId || savingTemplate) return;
    const target = `${project.id}:${segment.id}`;
    setSavingTemplate({ target, templateId: nextTemplateId });
    try { await act(`/segments/${segment.id}`, { boardTemplateId: nextTemplateId }, 'PATCH', '审核板模板已保存。重新导出即可应用新排版。'); }
    finally { setSavingTemplate(previous => previous?.target === target && previous.templateId === nextTemplateId ? null : previous); }
  }
  async function createPreview() {
    if (!project || !segment) return;
    const key = boardKey;
    const busyKey = `preview:${key}`;
    if (inflight.current.has(busyKey)) return;
    markBusy(busyKey, true);
    try {
      const result = await api<PreviewRecord>(`/api/projects/${project.id}/segments/${segment.id}/preview`, 'POST', { templateId });
      const next = { ...result, templateId: result.templateId || templateId };
      const resultKey = `${project.id}:${segment.id}:${next.templateId}`;
      setPreviews(previous => ({ ...previous, [resultKey]: next }));
      if (activeId.current === project.id && activeBoardKey.current === resultKey) { setShownPreview(next); setModal('preview'); }
      notify('设定板已导出，图片与三视图仍需人工审核。');
    } catch (error) { errorToast(readableError(error)); }
    finally { markBusy(busyKey, false); }
  }

  const counts = {
    characters: project?.characters.filter(character => identityReady(project, character)).length || 0,
    images: segment?.shots.filter(shot => !!shot.image).length || 0,
    currentImages: segment?.shots.filter(currentImage).length || 0,
    approved: segment?.shots.filter(shot => shot.approved && (traditionalVideoMode || currentImage(shot)) && (segmentBoardMode || shotReferencesReady(project!, shot))).length || 0,
    videos: segmentBoardMode ? (segment && currentSegmentVideo(project!, segment) ? 1 : 0) : segment?.shots.filter(currentVideo).length || 0,
  };
  const currentEpisodeIndex = currentEpisode ? episodeGroups.findIndex(group => group.key === currentEpisode.key) : -1;
  const episodeShotTotal = episodeSegments.reduce((total, item) => total + item.shots.length, 0);
  const episodeApproved = episodeSegments.reduce((total, item) => total + item.shots.filter(shot => shot.approved && (traditionalVideoMode || currentImage(shot)) && (segmentBoardMode || shotReferencesReady(project!, shot))).length, 0);
  const episodeReady = Boolean(episodeSegments.length && episodeSegments.every(item => storyboardVideoMode
    ? Boolean(item.storyboardImage && item.storyboardImageVersion && item.storyboardApproved && item.shots.every(currentImage))
    : traditionalVideoMode
      ? item.shots.length > 0 && item.shots.every(shot => shot.approved)
    : item.shots.length > 0 && item.shots.every(shot => shot.approved && currentImage(shot) && shotReferencesReady(project!, shot))));
  const nextEpisode = currentEpisodeIndex >= 0 ? episodeGroups[currentEpisodeIndex + 1] : undefined;
  const previousEpisode = currentEpisodeIndex > 0 ? episodeGroups[currentEpisodeIndex - 1] : undefined;
  const projectVideosReady = Boolean(project?.segments.length && (segmentBoardMode ? project.segments.every(item => currentSegmentVideo(project, item)) : project.segments.every(item => item.shots.length > 0 && item.shots.every(shot => currentVideo(shot)))));
  const hasProjectExport = Boolean(project?.projectExports?.length || project?.exportHistory?.some(record => record.projectExport));
  const segmentDirty = segment?.shots.some(shot => shotDrafts[`${project?.id}:${shot.id}`] && JSON.stringify(shotDrafts[`${project?.id}:${shot.id}`]) !== JSON.stringify(shotDraft(shot))) || false;
  const charactersDirty = project?.characters.some(character => characterDrafts[`${project?.id}:${character.id}`] && JSON.stringify(characterDrafts[`${project?.id}:${character.id}`]) !== JSON.stringify(characterDraft(character))) || false;
  const looksDirty = !!project && (
    (project.scenes || []).some(scene => { const draft = sceneDrafts[`${project.id}:${scene.id}`]; return draft && JSON.stringify(draft) !== JSON.stringify(sceneDraft(scene)); }) ||
    (project.looks || []).some(look => { const draft = lookDrafts[`${project.id}:${look.id}`]; return draft && JSON.stringify(draft) !== JSON.stringify(lookDraft(look)); })
  );
  const castReady = storyboardVideoMode || (!!project && (segment?.shots.every(shot => shotReferencesReady(project, shot)) ?? false));
  const stage = !project?.segments.length ? 0 : segmentBoardMode ? (counts.approved < shotTotal ? 2 : 3) : counts.characters < project.characters.length ? 1 : !castReady ? 2 : counts.approved < shotTotal ? 3 : 4;
  const totalDuration = segment?.shots.reduce((sum, shot) => sum + shot.duration, 0) || 0;
  const timingValid = !!segment && Math.abs(totalDuration - segment.duration) < 0.05;
  const segmentActive = segment && activeJobs.some(job => isCurrentJob(project!, job) && (job.targetId === segment.id || segment.shots.some(shot => shot.id === job.targetId)));
  const uncertainVideos = segmentBoardMode
    ? Boolean(segment && taskProblems.some(job => job.targetId === segment.id && job.kind === 'segment-video' && ['unknown', 'interrupted'].includes(job.status)))
    : segment?.shots.some(shot => taskProblems.some(job => job.targetId === shot.id && job.kind === 'video' && ['unknown', 'interrupted'].includes(job.status))) || false;
  const uncertainImages = segmentBoardMode
    ? Boolean(segment && taskProblems.some(job => job.targetId === segment.id && job.kind === 'storyboard' && ['unknown', 'interrupted'].includes(job.status)))
    : segment?.shots.some(shot => taskProblems.some(job => job.targetId === shot.id && job.kind === 'image' && ['unknown', 'interrupted'].includes(job.status))) || false;
  const videoConfigured = isArkVideoModel(selectedVideoModel) ? config?.arkConfigured : isXiongmaoVideoModel(selectedVideoModel) ? config?.xiongmaoMinimaxH3Configured : isMiniMaxVideoModel(selectedVideoModel) ? config?.minimaxConfigured : false;

  return <div className="app-shell">
    {mobileNav && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <button className="brand" onClick={() => { setProject(null); activeId.current = null; setMobileNav(false); rememberProject(accountStorage, null); }} aria-label="映序首页"><span className="brand-mark"><Film size={24} strokeWidth={1.8} /></span><span className="brand-name">映序<span>AI FRAME</span></span></button>
      <div className="sidebar-divider" />
      <div className="sidebar-label">创作空间<span>WORKSPACE</span></div>
      <button className="new-project" onClick={() => { setModal('import'); setMobileNav(false); }}><Plus size={17} />新建短剧项目<span>＋</span></button>
      {projects.length > 0 && <div className="project-picker"><FolderOpen size={15} /><select aria-label="切换项目" value={project?.id || ''} onChange={event => event.target.value && void openProject(event.target.value)}><option value="" disabled>选择一个项目</option>{projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><ChevronDown size={13} /></div>}
      <button className={`project-manage-button ${view === 'projects' ? 'active' : ''}`} onClick={() => changeView('projects')}><FolderCog size={15} /><span>项目管理</span><ChevronRight size={13} /></button>
      <div className="sidebar-label production-label">制作流程</div>
      <nav aria-label="制作流程">{views.filter(item => !segmentBoardMode || traditionalVideoMode || item.id !== 'looks').map((item, index) => <button key={item.id} className={`nav-item ${project && view === item.id ? 'active' : ''}`} disabled={!project} onClick={() => changeView(item.id)}><item.icon size={18} strokeWidth={1.6} /><span>{item.name}</span><span className="nav-number">0{index + 1}</span></button>)}</nav>
      <div className="sidebar-label records-label">资料</div>
      <nav aria-label="资料"><button className={`nav-item ${view === 'history' ? 'active' : ''}`} onClick={() => changeView('history')}><History size={18} strokeWidth={1.6} /><span>{historyView.name}</span><span className="nav-number">06</span></button></nav>
      {project && <div className="sidebar-project-info"><span className="eyebrow">CURRENT PROJECT</span><strong>{project.title}</strong><div><span>{project.aspectRatio} 画幅</span><span>{project.segments.length} 个片段</span></div></div>}
      <div className="sidebar-bottom">
        {project && <button className="task-button" onClick={() => setModal('jobs')}>{activeJobs.length ? <Spinner size={16} /> : <Layers3 size={16} />}<span>制作任务</span>{activeJobs.length ? <Badge tone="green">{activeJobs.length}</Badge> : taskProblems.length ? <span className="task-problem-dot" /> : <ChevronRight size={14} />}</button>}
        <button className="settings-button" onClick={() => { setModal('settings'); setMobileNav(false); }}><Settings2 size={17} />模型连接<ChevronRight size={14} /></button>
        {!isDesktopRuntime && <a className="client-download" href={clientDownloadUrl} download aria-label="下载映序客户端" title="下载映序 Windows 客户端"><MonitorDown size={17} /><span>下载客户端</span><Download size={14} /></a>}
    {isDesktopRuntime && <button className="client-update" onClick={() => void checkOrInstallUpdate()} disabled={updateState === 'checking' || updateState === 'installing'} title={updateError || `当前版本 v${window.aiframeDesktop?.displayVersion || window.aiframeDesktop?.version || '未知'}`}><RefreshCw size={17} className={updateState === 'checking' || updateState === 'installing' ? 'spin' : undefined} /><span>{updateState === 'checking' ? '正在检查' : updateState === 'installing' ? '正在更新' : updateState === 'available' && updateInfo ? `更新到 v${updateInfo.displayVersion || updateInfo.version}` : updateState === 'current' ? '已是最新版本' : '检查更新'}</span><ChevronRight size={14} /></button>}
    <div className="local-footer"><span className={`status-dot ${connectionError ? 'warning' : ''}`} /><span>本地创作空间</span><span className="version-label">v{isDesktopRuntime ? window.aiframeDesktop?.displayVersion || window.aiframeDesktop?.version || '2026-10-09-v11' : '2026-10-09-v11'}</span></div>
      </div>
    </aside>

    <div className="main-shell">
      {isDesktopRuntime && <div className="desktop-drag-strip" aria-hidden="true" />}
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="展开导航" onClick={() => setMobileNav(true)}><Menu size={20} /></button><span className="workspace-crumb">创作空间</span><ChevronRight size={13} /><span>{project?.title || (view === 'history' || view === 'projects' ? '作品资料' : '新的故事')}</span>{(project || view === 'history' || view === 'projects') && <><ChevronRight size={13} /><span className="current-crumb">{selectedView.name}</span></>}</div><div className="topbar-right"><span className="local-saved"><ShieldCheck size={14} />{hasDrafts ? draftStorageFailed ? '草稿未暂存' : draftStoragePending ? '正在暂存草稿' : '草稿已暂存本机' : '账号工作区'}</span><div className="account-menu"><span className="user-avatar" aria-hidden="true">{(account.user.displayName || account.user.username).slice(0, 1)}</span><span className="account-name" title={account.user.username}>{account.user.displayName || account.user.username}</span><button className="account-logout" onClick={() => hasDrafts && draftStorageFailed ? setModal('logout') : account.logout()} aria-label="退出登录" title="退出登录；已提交的任务仍在当前账号下继续"><LogOut size={15} /><span>退出</span></button></div></div></header>
      <LegacyImport onImported={loadState} />
      {connectionError && <div className="connection-banner"><span>{connectionError}</span><button className="text-button" onClick={() => void loadState()}><RefreshCw size={14} />重新连接</button></div>}
      {hasDrafts && draftStorageFailed && <div className="connection-banner" role="status"><span>部分修改无法暂存到浏览器。请及时保存到项目，或复制正文备份；含密钥或图片数据的内容不会进入草稿。</span></div>}
      {recoveredDrafts > 0 && <div className="connection-banner" role="status"><span>已恢复本项目 {recoveredDrafts} 处本机草稿，请核对后点击各编辑区的“保存”。草稿保留 7 天。</span></div>}
      {initialLoading ? <div className="app-loading"><Spinner size={27} /><span>正在打开创作空间</span></div> : view === 'history' ? <>
        <div className="page-heading history-page-heading"><div><div className="eyebrow">EXPORT ARCHIVE</div><h1>{historyView.name}<span className="heading-dot">.</span></h1><p>{historyView.subtitle}</p></div><div className="page-heading-actions"><button className="button secondary" onClick={() => void loadHistory()} disabled={historyLoading}><RefreshCw size={15} className={historyLoading ? 'spin' : undefined} />刷新记录</button></div></div>
        <HistoryView records={historyRecords} templates={templateCatalog?.templates || []} loading={historyLoading} error={historyError} retry={() => void loadHistory()} />
      </> : view === 'projects' ? <>
        <div className="page-heading project-management-heading"><div><div className="eyebrow">PROJECT LIBRARY</div><h1>{projectsView.name}<span className="heading-dot">.</span></h1><p>{projectsView.subtitle}</p></div><div className="page-heading-actions"><button className="button primary" onClick={() => setModal('import')}><Plus size={15} />新建项目</button></div></div>
        <ProjectManagementView projects={projects} currentProjectId={project?.id || null} openProject={openProject} onCreate={() => setModal('import')} requestDelete={requestDeleteProject} desktop={isDesktopRuntime} localFolders={localFolders} chooseFolder={chooseProjectFolder} syncLocal={openLocalSync} />
      </> : !project ? <Welcome onImport={() => setModal('import')} onDemo={createDemo} busy={busy.has('demo')} projects={projects} resumeProjectId={recoveryPoint?.projectId || rememberedProject(accountStorage)} openProject={openProject} /> : <>
        <div className="page-heading"><div><div className="eyebrow">{view === 'story' ? 'STORY DEVELOPMENT' : view === 'characters' ? 'CHARACTER BIBLE' : view === 'assets' ? 'CONTINUITY ASSETS' : view === 'looks' ? 'SCENE LOOKBOOK' : view === 'storyboard' ? 'STORYBOARD WORKSPACE' : 'FINAL CUT'}</div><h1>{selectedView.name}<span className="heading-dot">.</span></h1><p>{selectedView.subtitle}</p></div><div className="page-heading-actions">{view === 'characters' && !segmentBoardMode && <button className="button secondary" onClick={() => showLooks()}><Shirt size={15} />场景造型<ArrowRight size={14} /></button>}{view === 'storyboard' && segment && <button className="button secondary" disabled={counts.approved !== shotTotal} title={counts.approved !== shotTotal ? `先审核全部 ${shotTotal} 个分镜` : undefined} onClick={() => setView('videos')}><Video size={16} />制作视频<ArrowRight size={14} /></button>}{view === 'videos' && segment && <button className="button primary" disabled={anyBusy || !projectVideosReady || !config?.ffmpegAvailable || segmentDirty || charactersDirty || looksDirty} title={!projectVideosReady ? '请先为项目所有片段生成当前版本视频' : !config?.ffmpegAvailable ? '视频合成引擎不可用' : undefined} onClick={() => act('/export', { reuseExisting: false }, 'POST', hasProjectExport ? '项目成片已重新加入合成队列。' : '项目成片已加入合成队列。')}><ArrowDownToLine size={16} />{hasProjectExport ? '重新合成项目成片' : '合成项目成片'}</button>}<button className="button secondary icon-label" aria-label="任务记录" onClick={() => setModal('jobs')}><Layers3 size={16} /><span>任务记录</span>{activeJobs.length > 0 && <span className="inline-count">{activeJobs.length}</span>}</button></div></div>
        {view === 'assets' && <AssetsWorkspace project={project} config={config} act={act} busy={anyBusy} onError={errorToast} />}
        {(() => {
          const workflow = segmentBoardMode
            ? [{ name: '解析故事', view: 'story' as View }, { name: '人物资料', view: 'characters' as View }, { name: '整段分镜板', view: 'storyboard' as View }, { name: '制作成片', view: 'videos' as View }]
            : [{ name: '解析故事', view: 'story' as View }, { name: '人物身份', view: 'characters' as View }, { name: '场景造型', view: 'looks' as View }, { name: '分镜审核', view: 'storyboard' as View }, { name: '制作成片', view: 'videos' as View }];
          return <div className="workflow-strip">{workflow.map((item, index) => <button key={item.name} className={`workflow-step ${index < stage ? 'complete' : ''} ${index === stage ? 'current' : ''}`} onClick={() => changeView(item.view)}><span className="step-circle">{index < stage ? <Check size={12} /> : index + 1}</span><span>{item.name}</span>{index < workflow.length - 1 && <div className="step-line" />}</button>)}<span className="workflow-note">人工审核 · 掌控每一帧</span></div>;
        })()}

        {view === 'story' && <StoryView key={project.id} project={project} draft={storyDrafts[project.id] || storyDraft(project)} change={patch => setStoryDrafts(previous => updateDraft(previous, project.id, storyDraft(project), patch))} clear={() => clearStoryDraft(project.id, storyDrafts[project.id])} config={config} busy={anyBusy} act={act} setView={setView} showSettings={() => setModal('settings')} openDurationReset={() => setModal('duration-reset')} />}
        {view === 'characters' && (selectedCharacter ? <div className="characters-workspace"><CharacterLibrary project={project} selectedCharacterId={selectedCharacter.id} selectedCharacters={selectedCharacters} disabled={anyBusy} onSelect={setCharacterId} onSelectionChange={setSelectedCharacters} onPreview={(src, alt) => setImagePreview({ src, alt })} onBatchGenerate={() => void runBatch({ kind: 'character', action: 'generate', targetIds: selectedCharacters, expectedVersions: Object.fromEntries(project.characters.filter(character => selectedCharacters.includes(character.id)).map(character => [character.id, character.version])) })} onBatchApprove={() => void runBatch({ kind: 'character', action: 'approve', targetIds: selectedCharacters, expectedVersions: Object.fromEntries(project.characters.filter(character => selectedCharacters.includes(character.id)).map(character => [character.id, character.version])) })} /><CharacterEditor key={characterDraftKey} project={project} character={selectedCharacter} config={config} draft={characterDrafts[characterDraftKey] || characterDraft(selectedCharacter)} change={patch => setCharacterDrafts(previous => updateDraft(previous, characterDraftKey, characterDraft(selectedCharacter), patch))} clear={() => clearCharacterDraft(characterDraftKey, characterDrafts[characterDraftKey])} act={act} busy={anyBusy} onError={errorToast} showSettings={() => setModal('settings')} onPreview={(src, alt) => setImagePreview({ src, alt })} /></div> : <SectionEmpty title="先认识故事中的人" text="分析小说后，主角、配角和外貌原文依据会出现在角色库。" icon={<Users size={32} strokeWidth={1.3} />}><button className="button primary" onClick={() => setView('story')}><BookOpen size={16} />前往故事原稿</button></SectionEmpty>)}
        {view === 'looks' && <LooksWorkspace project={project} config={config} sceneId={sceneId} setSceneId={setSceneId} lookId={lookId} setLookId={setLookId} sceneDrafts={sceneDrafts} lookDrafts={lookDrafts} changeScene={(scene, patch) => setSceneDrafts(previous => updateDraft(previous, `${project.id}:${scene.id}`, sceneDraft(scene), patch))} changeLook={(look, patch) => setLookDrafts(previous => updateDraft(previous, `${project.id}:${look.id}`, lookDraft(look), patch))} clearScene={(scene, saved) => clearSceneDraft(`${project.id}:${scene.id}`, saved)} clearLook={(look, saved) => clearLookDraft(`${project.id}:${look.id}`, saved)} act={act} batchAct={batchAct} busy={anyBusy} onError={errorToast} showSettings={() => setModal('settings')} showIdentity={id => { if (id) setCharacterId(id); setView('characters'); }} showStory={() => setView('story')} />}
        {(view === 'storyboard' || view === 'videos') && (segment ? <div className={`production-workspace ${showInspector ? '' : 'inspector-hidden'}`}>
          <main className="board-main">
            {episodeGroups.length > 1 && <div className="episode-navigation" aria-label="按集选择分镜"><span className="episode-navigation-label">集数</span><div className="episode-navigation-list">{episodeGroups.map(group => <button key={group.key} type="button" className={`episode-navigation-item ${currentEpisode?.key === group.key ? 'active' : ''}`} onClick={() => selectEpisode(group.key)} aria-current={currentEpisode?.key === group.key ? 'page' : undefined}><strong>{group.episodeNumber === undefined ? '未分集' : `第${group.episodeNumber}集`}</strong><small>{group.segments.length} 段</small></button>)}</div></div>}
            <div className="segment-bar"><div className="segment-picker"><span className="segment-number">{String(segment.number).padStart(3, '0')}</span><select aria-label="选择片段" value={segment.id} onChange={event => selectSegment(event.target.value)}>{(episodeSegments.length ? episodeSegments : project.segments).map(item => <option key={item.id} value={item.id}>{item.episodeNumber ? `第${item.episodeNumber}集 · ` : ''}{item.title}</option>)}</select><ChevronDown size={15} /></div><div className="segment-meta"><span><Clock3 size={13} />{segment.duration}s</span><span>{project.aspectRatio}</span><span>{shotTotal} 镜头{segmentBoardMode ? ' · AI 决定' : ''}</span>{segmentBoardMode && <button type="button" className="text-button segment-duration-toggle" disabled={anyBusy || !!segmentActive || segmentDirty || charactersDirty || looksDirty} onClick={() => void act(`/segments/${segment.id}`, { duration: segment.duration === 30 ? 15 : 30 }, 'PATCH', segment.duration === 30 ? '已恢复为 15 秒并按当前镜头比例重新安排时长。' : '已扩展为 30 秒连续片段，并按当前镜头比例重新安排时长。')}>{segment.duration === 30 ? '恢复15秒' : '扩展至30秒'}</button>}</div></div>
            {episodeGroups.length > 1 && <div className="episode-summary"><span><strong>{currentEpisode?.title}</strong> · 本集 {episodeSegments.length} 个片段</span><span>{episodeApproved} / {episodeShotTotal} 个镜头已审核{episodeReady ? ' · 可以进入下一集' : ' · 完成本集审核后进入下一集'}</span></div>}
            {view === 'storyboard' && storyboardVideoMode && episodeGroups.length > 0 && currentEpisode && <button className="button small secondary episode-generate-button" disabled={anyBusy || !currentEpisode.segments.length} onClick={() => void act(`/episodes/${currentEpisode.episodeNumber === undefined ? 'unassigned' : `episode-${currentEpisode.episodeNumber}`}/generate-storyboards`, { reuseExisting: false }, 'POST', `${currentEpisode.title}的全部分镜任务已加入队列。`)}><Sparkles size={14} />生成本集分镜</button>}
            <p className="segment-summary">{segment.summary}</p>
            <SegmentNavigation position="top" segment={segment} episodeSegments={episodeSegments} episodeGroups={episodeGroups} currentEpisodeIndex={currentEpisodeIndex} previousEpisode={previousEpisode} nextEpisode={nextEpisode} episodeReady={episodeReady} selectEpisode={selectEpisode} selectSegment={selectSegment} />
            <div className="board-toolbar"><div className="board-tabs"><span className="active"><Grid2X2 size={14} />{view === 'storyboard' ? traditionalVideoMode ? '片段镜头计划' : '分镜总览' : segmentBoardMode ? '片段完整视频' : '镜头视频'}</span><span>{view === 'storyboard' ? counts.approved : counts.videos} / {view === 'storyboard' ? shotTotal : segmentBoardMode ? 1 : shotTotal} {view === 'storyboard' ? '已确认' : '已生成'}</span></div><div className="toolbar-actions">{view === 'storyboard' ? <><button className="text-button" disabled={anyBusy || !!segmentActive || (storyboardVideoMode && counts.currentImages !== shotTotal) || counts.approved === shotTotal || segmentDirty || charactersDirty || looksDirty || !timingValid || uncertainImages || (storyboardVideoMode && !storyboardCurrent)} title={storyboardVideoMode && counts.currentImages !== shotTotal ? `请先生成当前版本的整段分镜板和 ${shotTotal} 个裁切画面` : storyboardVideoMode && !storyboardCurrent ? '请先生成整段分镜板' : segmentDirty || charactersDirty || looksDirty ? '请先保存修改' : undefined} onClick={() => act(`/segments/${segment.id}/approve`, {}, 'POST', storyboardVideoMode ? '整段分镜板已审核通过。' : traditionalVideoMode ? '片段素材已确认，可进入传统模式视频生成。' : '这一段的全部分镜已审核通过')}><CheckCheck size={15} />{storyboardVideoMode ? '审核整段分镜板' : traditionalVideoMode ? '片段素材已确认，可进入传统模式视频生成。' : '全部审核'}</button>{!traditionalVideoMode && <button className="button small secondary" disabled={anyBusy || !!segmentActive || (!segmentBoardMode && counts.images === shotTotal) || !config?.grsaiConfigured || !castReady || segmentDirty || charactersDirty || looksDirty || uncertainImages} title={!config?.grsaiConfigured ? '请先配置图片模型' : storyboardVideoMode && storyboardCurrent ? '重新生成当前整段分镜板；完成后需要重新审核' : undefined} onClick={() => openBatch('images')}><Sparkles size={14} />{storyboardVideoMode && storyboardCurrent ? '重新生成整段分镜板' : segmentBoardMode ? '生成整段分镜板' : '生成分镜'}</button>}</> : <><div className="video-toolbar-options"><ModelPicker className="toolbar-model-picker" label="视频模型" value={selectedVideoModel} items={videoPickerItems(config?.videoOptions || [])} onChange={changeVideoModel} aria-label="片段视频模型" /><label className="toolbar-resolution"><span>分辨率</span><select aria-label="视频分辨率" value={selectedVideoResolution} onChange={event => setVideoResolutionSelection(event.target.value)}>{(selectedVideoOption?.resolutions || []).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><span>{selectedVideoCostRange ? `约 ¥${selectedVideoCostRange.min.toFixed(2)}-${selectedVideoCostRange.max.toFixed(2)} / ${selectedVideoPricePerCallRange ? '次' : `${segment.duration} 秒`}` : selectedVideoCost === null ? '价格待确认' : `约 ¥${selectedVideoCost.toFixed(2)} / ${segment.duration} 秒`}</span>{selectedVideoDurationUnsupported && <span className="video-option-warning">支持 {selectedVideoOption?.minDurationSeconds ?? 4}-{selectedVideoOption?.maxDurationSeconds ?? 15} 秒</span>}</div><button className="button small secondary" disabled={anyBusy || !!segmentActive || counts.approved !== shotTotal || (!segmentBoardMode && counts.videos === shotTotal) || !videoConfigured || segmentDirty || charactersDirty || looksDirty || uncertainVideos} title={uncertainVideos ? '请先在任务记录中核实原视频任务' : counts.approved !== shotTotal ? '请先确认全部素材' : !videoConfigured ? '请先配置视频模型' : undefined} onClick={() => openBatch('videos')}><Video size={14} />{segmentBoardMode && counts.videos === 1 ? '重新生成完整片段视频' : '生成完整片段视频'}</button></>}</div></div>
            {!segmentBoardMode && <div className="batch-toolbar board-batch-toolbar"><div className="batch-toolbar-heading"><span>批量处理镜头</span><Badge>{selectedShots.filter(id => segment.shots.some(shot => shot.id === id)).length} 已选</Badge></div><div className="batch-toolbar-actions"><button className="text-button" disabled={anyBusy} onClick={() => setSelectedShots(segment.shots.filter(shot => view === 'storyboard' ? !currentImage(shot) : shot.approved && !currentVideo(shot)).map(shot => shot.id))}>全选待处理</button>{view === 'storyboard' && <button className="text-button" disabled={anyBusy} onClick={() => setSelectedShots(segment.shots.filter(shot => currentImage(shot) && !shot.approved).map(shot => shot.id))}>全选待审核</button>}<button className="text-button" disabled={anyBusy || !selectedShots.length} onClick={() => setSelectedShots([])}>清空</button></div><div className="batch-toolbar-actions">{view === 'storyboard' ? <><button className="button small secondary" disabled={anyBusy || !selectedShots.length || !config?.grsaiConfigured || !!segmentActive || segmentDirty || charactersDirty || looksDirty} onClick={() => void runBatch({ kind: 'shot', action: 'generate', targetIds: selectedShots, expectedVersions: Object.fromEntries(segment.shots.filter(shot => selectedShots.includes(shot.id)).map(shot => [shot.id, shot.version])) })}><Sparkles size={14} />批量生图</button><button className="button small primary" disabled={anyBusy || !selectedShots.length || !!segmentActive || segmentDirty || charactersDirty || looksDirty} onClick={() => void runBatch({ kind: 'shot', action: 'approve', targetIds: selectedShots, expectedVersions: Object.fromEntries(segment.shots.filter(shot => selectedShots.includes(shot.id)).map(shot => [shot.id, shot.version])) })}><CheckCheck size={14} />批量审核</button></> : <button className="button small secondary" disabled={anyBusy || !selectedShots.length || counts.approved !== shotTotal || !videoConfigured || !!segmentActive || segmentDirty || charactersDirty || looksDirty} onClick={() => openBatch('videos', selectedShots)}><Video size={14} />批量生成视频</button>}</div></div>}
            {view === 'videos' && segmentBoardMode && <div className="batch-toolbar board-batch-toolbar"><div className="batch-toolbar-heading"><span>片段完整视频</span><Badge>{counts.videos} / 1 已生成</Badge></div><div className="batch-toolbar-actions"><button className="button small secondary" disabled={anyBusy || counts.approved !== shotTotal || !videoConfigured || !!segmentActive || segmentDirty || charactersDirty || looksDirty || uncertainVideos} onClick={() => setBatch('videos')}><Video size={14} />{counts.videos === 1 ? '重新生成这一段完整视频' : '生成这一段完整视频'}</button></div></div>}
            {view === 'storyboard' && storyboardVideoMode && <BoardTemplatePicker catalog={templateCatalog} loading={templatesLoading} error={templatesError} selectedId={templateId} savingId={savingTemplate?.target === `${project.id}:${segment.id}` ? savingTemplate.templateId : null} disabled={anyBusy || project.jobs.some(job => job.kind === 'export' && job.targetId === segment.id && isActive(job))} shots={segment.shots} segmentBoard={segmentBoardMode} collapsed={storyboardCurrent && !templatePickerOpen} onExpand={() => setTemplatePickerOpen(true)} retry={() => void loadTemplates()} select={id => void selectTemplate(id)} />}
            {view === 'storyboard' && storyboardVideoMode && <section className="segment-storyboard-preview" aria-label="整段分镜板"><div className="segment-storyboard-heading"><div><span className="eyebrow">SEGMENT STORYBOARD</span><strong>整段分镜板 · {shotTotal} 个镜头</strong><p>图片模型一次生成整个小说片段；画布只包含编号镜头和镜头文字，供人工检查。</p></div><Badge tone={storyboardCurrent && segment.storyboardApproved ? 'green' : 'amber'}>{storyboardCurrent ? segment.storyboardApproved ? '已审核' : '待审核' : '待生成'}</Badge></div>{segment.storyboardImage ? <a href={assetUrl(segment.storyboardImage)} target="_blank" rel="noreferrer"><img className="segment-storyboard-image" src={assetUrl(segment.storyboardImage)} alt={`片段 ${String(segment.number).padStart(3, '0')} 的整段分镜板`} /></a> : <EmptyImage label="等待整段分镜板" detail="点击“生成整段分镜板”，图片模型会一次生成全部镜头和镜头文字。" />}</section>}
            {view === 'storyboard' && <div className="board-preview-bar"><div><strong>{segmentBoardMode ? '整段分镜板与镜头裁切' : '分镜与场景造型，一起检查'}</strong><p>{segmentBoardMode ? '模板只决定审核板排版；镜头数量、镜头内容和每镜时长由小说分析与整板图片共同决定。人物参考图会在生成视频时上传。' : '按所选模板导出全部页面，对照镜头文字与角色三视图。'}</p></div><div className="preview-actions">{preview && <button className="text-button" onClick={() => { setShownPreview(preview); setModal('preview'); }}><Eye size={14} />上次导出</button>}<button className="button small secondary" disabled={anyBusy || !!segmentActive || counts.currentImages !== shotTotal || !timingValid || uncertainImages || segmentDirty || charactersDirty || !!looksDirty} title={counts.currentImages !== shotTotal ? `先为全部 ${shotTotal} 个分镜准备当前图片` : segmentDirty || charactersDirty || looksDirty ? '请先保存修改' : undefined} onClick={() => void createPreview()}>{busy.has(`preview:${boardKey}`) ? <Spinner size={14} /> : <Download size={14} />}导出设定板</button></div></div>}
            {view === 'storyboard' && !traditionalVideoMode && counts.images > counts.currentImages && <Notice>{counts.images - counts.currentImages} 张画面属于旧版设定。{storyboardVideoMode ? '请重新生成整段分镜板，系统会同步更新所有镜头裁切图。' : '请逐镜重新生成或上传；“生成分镜”只补充没有图片的镜头。'}</Notice>}
            {view === 'storyboard' && !storyboardVideoMode && !traditionalVideoMode && !castReady && <Notice>分镜会引用所属场景的角色三视图。请先确认人物身份和本场景造型。<button className="text-button" onClick={() => showLooks(selectedShot?.sceneId)}>完善场景造型<ArrowRight size={13} /></button></Notice>}
            {!timingValid && <Notice>镜头总时长为 {totalDuration.toFixed(1)} 秒。请调整为 {segment.duration} 秒后导出。</Notice>}
            {view === 'storyboard' && !config?.grsaiConfigured && <div className="inline-hint"><Sparkles size={15} /><span>{segmentBoardMode ? '连接图片模型，生成整段分镜板。' : '连接图片模型，或为每个镜头上传画面。'}</span><button className="text-button" onClick={() => setModal('settings')}>连接模型<ArrowRight size={13} /></button></div>}
            {view === 'videos' && counts.approved !== shotTotal && <Notice>已有 {counts.approved} / {shotTotal} 格完成确认。先确认{traditionalVideoMode ? '场景、人物和关键物品资料' : '整段分镜板和全部裁切画面'}，才能提交视频。<button className="text-button" onClick={() => setView('storyboard')}>返回片段审核<ArrowRight size={13} /></button></Notice>}
            {!(view === 'videos' && segmentBoardMode) && <div className="shot-grid">{segment.shots.map(shot => <ShotCard key={shot.id} shot={shot} project={project} selected={showInspector && selectedShot?.id === shot.id} bulkSelected={selectedShots.includes(shot.id)} onBulkToggle={checked => setSelectedShots(previous => checked ? [...new Set([...previous, shot.id])] : previous.filter(id => id !== shot.id))} mode={view === 'videos' ? 'video' : 'image'} onClick={() => { setShotId(shot.id); setShowInspector(true); if (window.matchMedia('(max-width: 900px)').matches) requestAnimationFrame(() => document.querySelector('.shot-inspector')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }} />)}</div>}
            {view === 'videos' && segmentBoardMode ? <div className="board-caption"><span><ShieldCheck size={13} />{traditionalVideoMode ? '场景、人物与关键物品参考会按顺序输入这一条片段视频' : `故事板中的 ${shotTotal} 个镜头会按编号连续发生在这一条片段视频中`}</span><button className="text-button" onClick={() => setView('storyboard')}>查看片段计划<ArrowRight size={12} /></button></div> : <div className="board-caption"><span><ShieldCheck size={13} />{view === 'storyboard' ? segmentBoardMode ? '整板一次生成；每格是从整板裁切的竖屏画面' : '每一格都是竖屏原图，人物参考图只在视频阶段上传' : '仅导出当前审核版本，自动按镜头顺序拼接'}</span><span>点击镜头查看与编辑<ArrowRight size={12} /></span></div>}
            {view === 'videos' && segmentBoardMode && <SegmentVideoPanel project={project} segment={segment} busy={anyBusy} onRegenerate={() => openBatch('videos')} />}
            {view === 'videos' && <ExportsView records={project.exports.filter(record => record.segmentId === segment.id)} projectRecords={(project.projectExports || []).slice().reverse()} templates={templateCatalog?.templates || []} currentTemplateId={templateId} exportReady={Boolean(segment.shots.length && segment.shots.every(shot => shot.approved) && (segmentBoardMode ? currentSegmentVideo(project, segment) : segment.shots.every(currentVideo)))} exportBusy={anyBusy} onExport={() => void requestSegmentExport()} />}
            <SegmentNavigation position="bottom" segment={segment} episodeSegments={episodeSegments} episodeGroups={episodeGroups} currentEpisodeIndex={currentEpisodeIndex} previousEpisode={previousEpisode} nextEpisode={nextEpisode} episodeReady={episodeReady} selectEpisode={selectEpisode} selectSegment={selectSegment} />
          </main>
          {selectedShot && showInspector && !(view === 'videos' && segmentBoardMode) && <ShotEditor key={`${selectedShot.id}-${view}`} project={project} shot={selectedShot} config={config} draft={shotDrafts[shotDraftKey] || shotDraft(selectedShot)} change={patch => setShotDrafts(previous => updateDraft(previous, shotDraftKey, shotDraft(selectedShot), patch))} clear={() => clearShotDraft(shotDraftKey, shotDrafts[shotDraftKey])} act={act} busy={anyBusy} onError={errorToast} showSettings={() => setModal('settings')} showLooks={showLooks} close={() => setShowInspector(false)} mode={view === 'videos' ? 'video' : 'image'} segmentBoard={segmentBoardMode} />}
        </div> : <SectionEmpty title="让文字成为镜头" text="先分析小说。系统会按剧情决定每段镜头数量，再生成整段分镜板供你审核。"><button className="button primary" onClick={() => setView('story')}><BookOpen size={16} />前往故事原稿</button></SectionEmpty>)}
      </>}
    </div>
    {imagePreview && <ImageLightbox src={imagePreview.src} alt={imagePreview.alt} close={() => setImagePreview(null)} />}
    {modal === 'import' && <ImportDialog close={() => setModal(null)} created={created} onError={errorToast} config={config} />}
    {modal === 'settings' && <SettingsDialog config={config} close={() => setModal(null)} saved={next => { setConfig(next); notify('模型连接设置已保存。'); }} onError={errorToast} />}
    {modal === 'update' && <UpdateDialog state={updateState} info={updateInfo} error={updateError} currentVersion={window.aiframeDesktop?.displayVersion || window.aiframeDesktop?.version || '未知'} check={() => void checkOrInstallUpdate(true)} install={() => void checkOrInstallUpdate()} close={() => setModal(null)} />}
    {modal === 'duration-reset' && project && <Modal title="重新规划片段时长" subtitle="所有新片段最多 15 秒，AI 会根据对白、动作和节奏灵活分配实际时长。切换后会清理当前角色、场景、分镜、故事板和当前视频，历史台账仍会保留；需要重新分析并重新生成。" close={() => setModal(null)}><div className="duration-reset-options"><button className="button primary full-width" disabled={anyBusy} onClick={() => void act('/reset-duration', { duration: 15, durationMode: 'auto' }, 'POST', '已重置为 15 秒上限并清空当前规划，请重新分析。').then(next => next && setModal(null))}><Clock3 size={16} />重置为 15 秒上限并重新规划</button></div><Notice type="warning">已提交但尚未完成的任务必须先处理；重置后旧故事板和视频不会再作为当前结果导出。</Notice></Modal>}
    {modal === 'preview' && shownPreview && <Modal title={`片段 ${String(shownPreview.number).padStart(3, '0')} · 设定板预览`} subtitle="固定模板按场景和容量分页。逐页对照镜头文字与当前审核素材。" close={() => setModal(null)} wide><BoardPages key={shownPreview.gridUrl} record={shownPreview} templates={templateCatalog?.templates || []} /><Notice>{shownPreview.hasStaleAssets || shownPreview.hasUnverifiedAssets || shownPreview.hasMissingReferences ? '此快照包含缺失、旧版或未经验证的素材，须补齐更新后重新审核。' : '这是用于人工检查的导出快照，生成成功不代表已审核通过。'}修改模板、设定或图片后，请重新导出。</Notice><div className="export-links"><a href={shownPreview.csvUrl} download className="button secondary">镜头文字 CSV</a><a href={shownPreview.manifestUrl} download className="text-button">全部页面与素材映射清单</a></div></Modal>}
    {modal === 'jobs' && project && <JobsDialog project={project} close={() => setModal(null)} act={act} locate={locate} busy={anyBusy} />}
    {modal === 'delete-project' && deleteTarget && <Modal title="删除项目" subtitle="此操作会移除项目记录和项目媒体，不能撤销。" close={() => { setDeleteTarget(null); setDeleteForceAvailable(false); setDeleteError(''); setModal(null); }}><div className="delete-project-dialog"><Trash2 size={27} /><strong>{deleteTarget.title}</strong><p>项目中的人物、造型、分镜、视频和历史台账会一并删除。已导出的本地 output 副本不受影响。</p>{deleteError && <Notice type="warning">{deleteError}</Notice>}</div><div className="modal-footer"><button className="button secondary" onClick={() => { setDeleteTarget(null); setDeleteForceAvailable(false); setDeleteError(''); setModal(null); }}>取消</button>{deleteForceAvailable && <button className="button danger" disabled={busy.has(`delete-project:${deleteTarget.id}`)} onClick={() => void removeProject(true)}>{busy.has(`delete-project:${deleteTarget.id}`) ? <Spinner size={15} /> : <Trash2 size={15} />}强制删除</button>}<button className="button danger" disabled={busy.has(`delete-project:${deleteTarget.id}`)} onClick={() => void removeProject()}>{busy.has(`delete-project:${deleteTarget.id}`) ? <Spinner size={15} /> : <Trash2 size={15} />}删除项目</button></div></Modal>}
    {modal === 'local-sync' && localSyncTarget && <LocalProjectSyncDialog target={localSyncTarget} folder={localFolders[localSyncTarget.id] || null} cleanup={localSyncCleanup} setCleanup={setLocalSyncCleanup} directories={LOCAL_PROJECT_DIRECTORIES} busy={localSyncBusy} error={localSyncError} close={() => { if (!localSyncBusy) { setModal(null); setLocalSyncTarget(null); setLocalSyncError(''); } }} sync={() => void syncLocalProject()} />}
    {batch && segment && <BatchDialog kind={batch} videoModel={selectedVideoModel} videoResolution={selectedVideoResolution} videoOptions={config?.videoOptions || []} duration={batchShotIds?.length ? segment.shots.filter(shot => batchShotIds.includes(shot.id)).reduce((total, shot) => total + shot.duration, 0) : segment.duration} segmentBoard={segmentBoardMode} traditionalVideo={traditionalVideoMode} regenerateStoryboard={batch === 'images' && storyboardVideoMode && storyboardCurrent} regenerateVideo={batch === 'videos' && segmentBoardMode && currentSegmentVideo(project, segment)} count={batchShotIds?.length || (segmentBoardMode ? 1 : segment.shots.filter(shot => batch === 'images' ? !shot.image : !currentVideo(shot)).length)} close={closeBatch} confirm={confirmBatch} loading={anyBusy} />}
    {batchResult && <Modal title="批量操作结果" subtitle={`${batchResult.accepted.length} 项已提交，${batchResult.skipped.length} 项未执行。`} close={() => setBatchResult(null)}><div className="batch-result-list">{batchResult.skipped.map(item => <div className="batch-result-item" key={`${item.targetId}:${item.code}`}><Badge tone="amber">{item.code}</Badge><span>{item.message}</span></div>)}</div><div className="modal-footer"><button className="button primary" onClick={() => setBatchResult(null)}>知道了</button></div></Modal>}
    {modal === 'logout' && <Modal title="仍有无法暂存的修改" subtitle="请先保存到项目，或复制正文备份。" close={() => setModal(null)}><p className="helper">当前浏览器无法保存部分草稿，立即退出可能丢失这些未保存修改。已提交的制作任务仍会在当前账号下继续。</p><div className="modal-footer"><button className="button primary" onClick={() => setModal(null)}>返回并保存</button><button className="button secondary" onClick={account.logout}>仍然退出</button></div></Modal>}
    <ToastRegion modalKey={modal || batch || (batchResult ? 'batch-result' : null)}>{toasts.map(toast => <div key={toast.id} className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <X size={17} /> : <Check size={17} />}<span>{toast.message}</span><button className="icon-button" aria-label="关闭通知" onClick={() => setToasts(previous => previous.filter(item => item.id !== toast.id))}><X size={14} /></button></div>)}</ToastRegion>
  </div>;
}

function UpdateDialog({ state, info, error, currentVersion, check, install, close }: { state: DesktopUpdateState; info: DesktopUpdateInfo | null; error: string; currentVersion: string; check: () => void; install: () => void; close: () => void }) {
  const checking = state === 'checking';
  const installing = state === 'installing';
  const available = state === 'available' && Boolean(info?.available);
  const current = state === 'current';
  const failed = state === 'error';
  const statusIcon = checking || installing ? <RefreshCw size={20} className="spin" /> : available ? <Download size={20} /> : failed ? <X size={20} /> : <Check size={20} />;
  const statusTitle = checking ? '正在检查更新' : installing ? '正在准备安装' : available ? '发现新版本' : failed ? '检查更新失败' : current ? '当前已是最新版本' : '准备检查更新';
  const statusDetail = checking ? '正在读取官方更新清单，请稍候。' : installing ? '安装程序启动后客户端会自动退出，完成安装后可重新打开。' : available ? `可更新到 v${info?.displayVersion || info?.version}` : failed ? error || '暂时无法获取更新信息，请重试。' : current ? '当前版本已经是可用的最新版本。' : '点击检查更新获取最新客户端。';
  return <Modal title="客户端更新" subtitle={`当前版本 v${currentVersion} · 更新清单来自 wsfile.cn`} close={close}>
    <div className={`update-dialog update-dialog-${state}`}>
      <div className="update-status" role="status" aria-live="polite"><span className="update-status-icon">{statusIcon}</span><div><strong>{statusTitle}</strong><p>{statusDetail}</p></div></div>
      {available && info && <>
        <div className="update-version-compare"><div><span>当前版本</span><strong>v{currentVersion}</strong></div><ArrowRight size={17} /><div><span>可用版本</span><strong>v{info.displayVersion || info.version}</strong></div></div>
        <div className="update-notes"><span>更新内容</span><p>{info.releaseNotes || '本次更新包含稳定性和体验改进。'}</p></div>
      </>}
      {current && <div className="update-current-note"><ShieldCheck size={17} /><span>已完成版本检查。以后也可以从左侧“检查更新”随时打开这个面板。</span></div>}
      {failed && <div className="update-error-detail"><p>{error || '更新服务暂时不可用，请稍后重试。'}</p></div>}
      <div className="modal-footer update-footer">
        <button className="button secondary" onClick={close}>{installing ? '后台运行' : '关闭'}</button>
        {(current || failed || state === 'idle') && <button className="button primary" onClick={check} disabled={checking || installing}><RefreshCw size={15} />{failed ? '重试检查' : '重新检查'}</button>}
        {available && <button className="button primary" onClick={install} disabled={checking || installing}><Download size={15} />下载并安装</button>}
        {checking && <button className="button primary" disabled><RefreshCw size={15} className="spin" />正在检查</button>}
        {installing && <button className="button primary" disabled><RefreshCw size={15} className="spin" />正在安装</button>}
      </div>
    </div>
  </Modal>;
}

function LocalProjectSyncDialog({ target, folder, cleanup, setCleanup, directories, busy, error, close, sync }: { target: ProjectSummary; folder: DesktopProjectFolder | null; cleanup: boolean; setCleanup: (value: boolean) => void; directories: readonly string[]; busy: boolean; error: string; close: () => void; sync: () => void }) {
  return <Modal title={`同步“${target.title}”到本地`} subtitle="客户端会把当前账号的原稿、分析快照、人物资料、分镜图片、视频和清单保存到所选项目文件夹。" close={close}>
    <div className="local-sync-dialog">
      <div className="local-sync-root"><FolderOpen size={18} /><div><span>本地项目目录</span><strong title={folder?.path}>{folder?.path || '尚未选择'}</strong></div></div>
      <div className="local-sync-directories"><span>自动维护的固定目录</span><div>{directories.map(directory => <Badge key={directory}>{directory}</Badge>)}</div></div>
      <div className="local-sync-note"><ShieldCheck size={16} /><p>客户端会在生成内容完成后自动同步到本地；这里可立即补齐当前项目。分析快照写入 <strong>Analysis</strong>，图片和视频分别写入对应目录，重复同步会覆盖同名文件。</p></div>
      <label className="local-sync-cleanup"><input type="checkbox" checked={cleanup} onChange={event => setCleanup(event.target.checked)} disabled={busy} /><span><strong>本地写入成功后清理服务器视频</strong><small>只清理本次同步清单中已下载的视频；服务器上的分析、图片和历史资料保留，网页端可继续查看。</small></span></label>
      {cleanup && <Notice type="warning">确认清理后，网页端将不能再播放已删除的云端视频；本地视频文件仍可使用。下载失败或清理失败时不会删除服务器文件。</Notice>}
      {error && <Notice type="warning">{error}</Notice>}
    </div>
    <div className="modal-footer"><button className="button secondary" onClick={close} disabled={busy}>取消</button><button className="button primary" onClick={sync} disabled={busy || !folder}>{busy ? <Spinner size={15} /> : <Download size={15} />}{busy ? '同步中…' : '确认同步'}</button></div>
  </Modal>;
}

function ProjectManagementView({ projects, currentProjectId, openProject, onCreate, requestDelete, desktop, localFolders, chooseFolder, syncLocal }: { projects: ProjectSummary[]; currentProjectId: string | null; openProject: (id: string) => void; onCreate: () => void; requestDelete: (project: ProjectSummary) => void; desktop: boolean; localFolders: Record<string, DesktopProjectFolder | null>; chooseFolder: (project: ProjectSummary) => void; syncLocal: (project: ProjectSummary) => void }) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => normalizedQuery ? projects.filter(project => project.title.toLocaleLowerCase().includes(normalizedQuery)) : projects, [normalizedQuery, projects]);
  const dateLabel = (value?: string) => {
    if (!value) return '时间待记录';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间待记录' : date.toLocaleString('zh-CN', { hour12: false });
  };
  return <main className="project-management-page">
    <div className="project-management-toolbar"><label className="history-search"><Search size={16} /><span className="visually-hidden">搜索项目</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目名称" /></label><span className="project-result-count">显示 {filtered.length} / {projects.length} 个项目</span></div>
    {!projects.length ? <SectionEmpty title="还没有项目" text="新建一个短剧项目，或载入本地示例开始创作。" icon={<FolderOpen size={32} strokeWidth={1.3} />}><button className="button primary" onClick={onCreate}><Plus size={16} />新建项目</button></SectionEmpty> : !filtered.length ? <SectionEmpty title="没有匹配的项目" text="换一个项目名称试试。" icon={<Search size={30} strokeWidth={1.3} />} /> : <div className="project-management-grid">{filtered.map(item => {
      const active = (item.activeJobCount || 0) > 0;
      return <article className="project-management-card" key={item.id}>
        <div className="project-management-card-top"><span className="project-card-icon"><FolderOpen size={20} /></span>{item.id === currentProjectId ? <Badge tone="green">当前项目</Badge> : active ? <Badge tone="amber">任务进行中</Badge> : <Badge>可继续</Badge>}</div>
        <h2 title={item.title}>{item.title}</h2>
        <p className="project-card-updated"><CalendarDays size={13} />更新于 {dateLabel(item.updatedAt)}</p>
        <div className="project-card-stats"><span><strong>{item.segmentCount}</strong> 个片段</span><span><strong>{item.characterCount ?? 0}</strong> 位人物</span><span><strong>{item.shotCount ?? 0}</strong> 个镜头</span></div>
        <div className="project-card-actions"><button className="button small primary" onClick={() => void openProject(item.id)}><ArrowRight size={14} />打开项目</button><button className="button small danger" onClick={() => void requestDelete(item)}><Trash2 size={14} />删除</button></div>
        {desktop && <div className="local-project-card-actions"><div className="local-project-folder-line"><FolderOpen size={14} /><span title={localFolders[item.id]?.path}>{localFolders[item.id] ? `本地目录：${localFolders[item.id]!.path}` : '未选择本地归档目录'}</span></div><div className="project-card-actions"><button className="button small secondary" onClick={() => chooseFolder(item)}><FolderOpen size={14} />{localFolders[item.id] ? '更换文件夹' : '选择文件夹'}</button>{localFolders[item.id] && <button className="button small secondary" disabled={active} onClick={() => syncLocal(item)}><Download size={14} />同步到本地</button>}</div></div>}
      </article>;
    })}</div>}
  </main>;
}

function Welcome({ onImport, onDemo, busy, projects, resumeProjectId, openProject }: { onImport: () => void; onDemo: () => void; busy: boolean; projects: ProjectSummary[]; resumeProjectId: string | null; openProject: (id: string) => void }) {
  const resumeProject = projects.find(item => item.id === resumeProjectId);
  return <main className="welcome">
    <div className="welcome-kicker"><span className="status-dot" />FROM STORY TO SCREEN</div>
    <h1>让内容，<br /><span>一帧帧成真。</span></h1>
    <p className="welcome-description">从小说、剧本到论文和新闻。<br />原文、分镜与成片，在同一个创作空间里完成。</p>
    {resumeProject && <div className="welcome-resume"><div><span className="eyebrow">LAST CREATIVE SESSION</span><strong>{resumeProject.title}</strong><small>{resumeProject.segmentCount} 个片段 · {new Date(resumeProject.updatedAt).toLocaleDateString('zh-CN')}</small></div><button className="button primary" onClick={() => openProject(resumeProject.id)}><ArrowRight size={17} />继续上次创作</button></div>}
    <div className="welcome-actions"><button className="button primary large" onClick={onImport}><Plus size={18} />导入内容<ArrowRight size={17} /></button><button className="button secondary large" disabled={busy} onClick={onDemo}>{busy ? <Spinner /> : <Play size={16} />}体验示例</button></div>
    <p className="welcome-footnote"><ShieldCheck size={13} />同账号共享项目与历史 · 人工审核 · 云端保留素材</p>
    <div className="welcome-workflow"><div className="welcome-workflow-header"><span>从灵感到作品，井然有序</span><span>YOUR CREATIVE FLOW</span></div><div className="welcome-steps">{[{ icon: BookOpen, title: '读懂你的故事', text: '识别人物，拆解情节', number: '01' }, { icon: Users, title: '让角色有迹可循', text: '身份与场景三视图，保持一致', number: '02' }, { icon: Grid2X2, title: '审视每一个镜头', text: '固定模板，逐帧确认', number: '03' }, { icon: Clapperboard, title: '让想象流动起来', text: '生成视频，按序导出', number: '04' }].map(item => <div className="welcome-step" key={item.number}><div><item.icon size={24} strokeWidth={1.4} /><span>{item.number}</span></div><h3>{item.title}</h3><p>{item.text}</p></div>)}</div></div>
    {projects.length > 0 && <div className="recent-projects"><div className="section-label">继续创作<span>{projects.length} 个本地项目</span></div><div className="recent-project-list">{projects.slice(0, 3).map(project => <button className="recent-project" key={project.id} onClick={() => openProject(project.id)}><span className="project-cover"><BookOpen size={23} strokeWidth={1.4} /></span><span><strong>{project.title}</strong><small>{project.segmentCount} 个片段 · {new Date(project.updatedAt).toLocaleDateString('zh-CN')}</small></span><ArrowRight size={17} /></button>)}</div></div>}
  </main>;
}

function StoryView({ project, draft, change, clear, config, busy, act, setView, showSettings, openDurationReset }: { project: Project; draft: StoryDraft; change: (patch: Partial<StoryDraft>) => void; clear: () => void; config: PublicConfig | null; busy: boolean; act: (path: string, body?: unknown, method?: string, success?: string) => Promise<Project | null>; setView: (view: View) => void; showSettings: () => void; openDurationReset: () => void }) {
  const { novel, title, style, sequelNovel = '' } = draft;
  const projectLlmModel = draft.llmModel || project.llmModel || config?.llmModel || 'qwen3.7-plus';
  const selectedLlmModel = config?.llmModels?.find(model => model.id === projectLlmModel);
  const projectModelConfigured = Boolean(selectedLlmModel?.configured);
  const [copyStatus, setCopyStatus] = useState('');
  const analysisJob = project.jobs.filter(job => job.kind === 'analyze').at(-1);
  const retryableAnalysisJob = [...project.jobs].reverse().find(job => job.kind === 'analyze' && job.status === 'failed' && !job.analysisRetryJobId && (job.analysisRetryable === true || /当前分析块校验失败|重试当前分析块/.test(job.error || '')));
  const analyzing = project.jobs.some(job => job.kind === 'analyze' && isActive(job));
  const partialAnalysis = project.analysisReady?.complete === false;
  const analyzed = project.segments.length > 0;
  const analysisComplete = analyzed && !partialAnalysis && (!analysisJob || analysisJob.status === 'completed');
  const uncertainJob = project.jobs.find(job => job.kind === 'analyze' && job.status === 'unknown' && !job.analysisRetryJobId);
  const uncertainAnalysis = Boolean(uncertainJob);
  const failedAnalysis = Boolean((analysisJob && ['failed', 'interrupted'].includes(analysisJob.status)) || retryableAnalysisJob);
  const retryableFailedAnalysis = Boolean(retryableAnalysisJob);
  const dirty = novel !== project.novel || title !== project.title || style !== project.style || projectLlmModel !== (project.llmModel || 'qwen3.7-plus');
  const appendDraft = analysisComplete && style === project.style && novel.startsWith(project.novel) && novel.length > project.novel.length;
  const analyzedSourceLength: number = Number.isInteger(project.analysisSourceLength) ? Number(project.analysisSourceLength) : project.novel.length;
  const appendAvailable = analysisComplete && project.novel.length > analyzedSourceLength;
  const contentConflict = storyDraftContentConflict(project, draft);
  const canSave = analyzed ? title !== project.title || novel !== project.novel : dirty;
  const canSaveSequel = analysisComplete && sequelNovel.trim().length > 0 && !contentConflict && !busy && !analyzing;
  async function saveStory() {
    const next = await act('', analyzed ? { title, ...(novel !== project.novel ? { novel } : {}) } : { title, novel, style, llmModel: projectLlmModel }, 'PATCH', analyzed ? novel !== project.novel ? '新增原稿已保存，请开始增量分析。' : '项目名称已保存。' : '项目原稿与模型已保存。');
    if (next && !storyDraftContentConflict(next, draft)) {
      if (sequelNovel.trim()) change({ title: next.title, novel: next.novel, style: next.style, llmModel: next.llmModel, sequelNovel });
      else clear();
    }
  }
  async function saveSequel() {
    if (!canSaveSequel) return;
    const nextNovel = appendNovelContent(project.novel, sequelNovel);
    const next = await act('', { novel: nextNovel }, 'PATCH', '续集内容已保存到原稿末尾，请点击“分析新增内容”继续。');
    if (next) change({ novel: next.novel, sequelNovel: '' });
  }
  async function copyConflictingDraft() {
    try { await navigator.clipboard.writeText(`${title}\n\n视觉风格：${style}\n\n${novel}`); setCopyStatus('草稿已复制，可粘贴到新项目继续编辑。'); }
    catch { setCopyStatus('复制不可用，请在正文和视觉风格输入框中选中并复制。'); }
  }
  async function continueAnalysis() {
    if (!uncertainJob) return;
    if (!window.confirm(`上次分析未返回结果，服务商可能已经计费。继续会使用 ${selectedLlmModel?.label || config?.llmModel || '当前模型'} 再次请求未完成块；原稿和模型不变时，已保存块将复用。旧请求记录会保留。确认承担可能的重复费用并继续？`)) return;
    await act(`/jobs/${uncertainJob.id}/retry-analysis`, { confirmDuplicateCost: true }, 'POST', '已确认，正在继续未完成的分析块。');
  }
  async function retryFailedAnalysis() {
    if (!retryableAnalysisJob) return;
    if (!window.confirm(`第 ${(retryableAnalysisJob.analysisChunk ?? 0) + 1} 个分析块的结构校验未通过。重试只会重新请求当前块，已保存内容不会重复请求，但模型服务可能再次计费。确认重试？`)) return;
    await act(`/jobs/${retryableAnalysisJob.id}/retry-analysis`, { confirmDuplicateCost: true }, 'POST', '已确认，正在重试当前分析块。');
  }
  async function pauseAnalysis() {
    if (!analysisJob || !isActive(analysisJob)) return;
    await act(`/jobs/${analysisJob.id}/pause`, {}, 'POST', '已请求暂停分析；当前块结束后会保存检查点。');
  }
  async function resumeAnalysis() {
    if (!analysisJob || analysisJob.status !== 'paused') return;
    await act(`/jobs/${analysisJob.id}/resume`, {}, 'POST', '已继续分析，将从最近检查点恢复。');
  }
  const segmentBoardMode = project.generationMode === 'segment-board';
  const sourceLabel = sourceTypeNames[project.sourceType ?? 'auto'] ?? '原始内容';
  const analyzedButton = '确认人物身份';
  return <div className="story-workspace">
    <section className="manuscript">
      <div className="manuscript-header"><div><BookOpen size={17} /><span>{sourceLabel}原稿</span></div><span>{project.novel.length.toLocaleString()} 字</span></div>
      <label className="manuscript-title">项目名称<input value={title} onChange={event => change({ title: event.target.value })} maxLength={120} /></label>
      <label className="manuscript-text">正文<textarea readOnly={analyzing} value={novel} onChange={event => change({ novel: event.target.value })} rows={18} spellCheck={false} /></label>
      {analysisComplete && <div className="sequel-editor">
        <div className="sequel-editor-header"><div><strong>续集内容</strong><span>补充第二季或后续集数，保存后会追加到原稿末尾。</span></div><span>{sequelNovel.length.toLocaleString()} 字</span></div>
        <textarea rows={10} value={sequelNovel} onChange={event => change({ sequelNovel: event.target.value })} disabled={busy || analyzing} maxLength={300000} spellCheck={false} placeholder="例如：第 11 集……第 50 集……" aria-label="续集内容" />
        <div className="sequel-editor-footer"><span>保存不会覆盖前面已分析的内容；保存后再点击右侧“分析新增内容”。</span><button className="button small secondary" disabled={!canSaveSequel} onClick={() => void saveSequel()}><Save size={15} />保存续集内容</button></div>
      </div>}
      <div className="manuscript-footer"><span>{contentConflict && !appendDraft ? '当前草稿不是已分析正文的末尾追加，保存前请核对' : analyzed ? appendAvailable ? `已保存 ${project.novel.length - analyzedSourceLength} 字新增内容，等待增量分析` : '已分析原稿保留为创作依据；可在末尾继续追加' : '分析前可编辑原稿'}</span><button className="button small secondary" disabled={!canSave || busy || analyzing || !title.trim() || (!analyzed && novel.trim().length < 20)} onClick={() => void saveStory()}>保存修改</button></div>
    </section>
    <aside className="story-settings">
      {contentConflict && !appendDraft && <Notice>项目已完成分析，但当前草稿不是已分析正文的末尾追加。请保留旧正文，只在末尾添加新内容；需要改写旧内容时请新建项目。<button className="text-button" onClick={() => void copyConflictingDraft()}>复制草稿，供新项目使用</button>{copyStatus && <p className="helper" role="status">{copyStatus}</p>}</Notice>}
      <div className="story-settings-title"><Sparkles size={18} /><h2>内容制作设定</h2></div>
      <label>视觉风格<textarea rows={3} readOnly={analyzed || analyzing} value={style} onChange={event => change({ style: event.target.value })} /></label>
      <div className="story-specs"><div><span>内容类型</span><strong>{sourceLabel}</strong></div><div><span>叙事视角</span><strong>{project.narrativeMode === 'narrator' ? '旁白视角' : project.narrativeMode === 'protagonist' ? '主角视角' : '自动分析'}</strong></div><div><span>视觉媒介</span><strong>{visualStyleNames[project.visualStyle ?? 'photorealistic']}</strong></div><div><span>成片画幅</span><strong>{project.aspectRatio} {project.aspectRatio === '9:16' ? '竖屏' : '横屏'}</strong></div><div><span>每个片段</span><strong>常规不超过 15 秒 · 30 秒模型仅用于明确 30 秒片段</strong></div><div><span>每集规划</span><strong>{project.segments.some(segment => segment.episodeNumber !== undefined) ? '约 80–120 秒，重要剧情可超出' : '按原文自然分段'}</strong></div><div><span>每段镜头</span><strong>{segmentBoardMode ? 'AI 决定（3–12）' : '9 个'}</strong></div></div>
      <div className="story-model-summary"><div><span>本项目文字分析模型</span><strong>{selectedLlmModel?.label || projectLlmModel}</strong></div>{!analyzed && <ModelPicker label="项目模型" value={projectLlmModel} items={llmPickerItems(config?.llmModels || [])} disabled={busy || analyzing || !(config?.llmModels?.length)} onChange={value => change({ llmModel: value })} aria-label="本项目文字分析模型" />}<button className="text-button" onClick={showSettings}>管理模型连接<ChevronRight size={13} /></button>{selectedLlmModel && <p className="helper">{selectedLlmModel.providerLabel}{selectedLlmModel.recommended ? ' · 速度快，推荐' : ''}{!selectedLlmModel.configured ? ' · 尚未配置' : analyzed ? ' · 本项目已锁定' : ''}</p>}</div>
      <div className="story-analysis-note"><h3>一次分析，搭好视频骨架</h3><ul><li>识别人物和原文依据（没有人物时保留空角色）</li><li>提取场景、物体、图表和过程主体</li><li>按原文事实规划片段与镜头</li><li>{segmentBoardMode ? '按内容决定每段镜头数量和时长' : '按内容规划片段与镜头'}</li><li>{segmentBoardMode ? '整段图片只生成镜头画面和镜头文字；人物参考图在生成视频时上传' : '保留台词、动作和运镜建议'}</li></ul></div>
      {failedAnalysis && <Notice type="warning">新增内容分析在当前分块处停止，已有作品内容保留。{retryableFailedAnalysis && <>系统已自动完成有限次数的结构、视觉和字段级修复，仍未通过校验。<br /></>}{(retryableAnalysisJob?.error || analysisJob?.error) && <><br />原因：{retryableAnalysisJob?.error || analysisJob?.error}</>}{retryableFailedAnalysis && <><br />可以只重试当前失败块。<button className="button small secondary" disabled={busy || analyzing || dirty || !projectModelConfigured} onClick={() => void retryFailedAnalysis()}><RefreshCw size={13} />确认并重试当前块</button></>}</Notice>}
      {analysisComplete && project.analysisWarnings?.length ? <Notice type="warning"><strong>分析已完成，完整内容已保留。</strong> 以下集数超过约 80–120 秒的建议范围，后续可按剧情重要性拆分或保留：{project.analysisWarnings.map(item => item.message).join('；')}</Notice> : null}
      {uncertainAnalysis && <Notice>上次分析请求的结果尚未明确。请查看任务记录；本项目不会自动再次提交，避免重复费用。<button className="button small secondary" disabled={busy || analyzing || dirty || !projectModelConfigured} onClick={() => void continueAnalysis()}><RefreshCw size={13} />确认后继续分析</button></Notice>}
      {analyzed ? <>
        <div className="analysis-complete"><CheckCheck size={18} /><div><strong>{analysisComplete ? '内容已完成拆解' : '分析进行中，已开放前沿内容'}</strong><span>{project.characters.length} 位角色 · {project.segments.length} 个片段{project.segments.some(segment => segment.episodeNumber !== undefined) ? ` · ${new Set(project.segments.map(segment => segment.episodeNumber).filter((value): value is number => value !== undefined)).size} 集` : ''}{appendAvailable ? ` · 待分析 ${project.novel.length - analyzedSourceLength} 字` : ''}</span></div></div>
        {analysisJob?.analysisProgress && <p className="helper" role="status">已保存 {analysisJob.analysisProgress.completedChunks} / {analysisJob.analysisProgress.totalChunks} 块{Number.isInteger(analysisJob.analysisProgress.readyThroughChunk) && analysisJob.analysisProgress.readySegmentCount ? ` · 前 ${analysisJob.analysisProgress.readyThroughChunk} 块可制作 ${analysisJob.analysisProgress.readySegmentCount} 段` : ''}{analyzing && analysisJob.analysisProgress.currentChunk ? ` · 当前第 ${analysisJob.analysisProgress.currentChunk} 块` : ''}{analyzing ? ' · 正在分析新增内容' : ''}</p>}
        {!analysisComplete && <Notice>已完成且校验通过的前沿内容可以先进入分镜、图片和视频流程；后续块会继续追加，不会覆盖已生成素材。</Notice>}
        <button className="button primary full-width" onClick={() => setView('characters')}>{analysisComplete ? analyzedButton : '使用已开放内容制作'}<ArrowRight size={16} /></button>
        {analyzing && <button className="button secondary full-width" disabled={busy} onClick={() => void pauseAnalysis()}><RefreshCw size={16} />暂停分析</button>}
        {analysisJob?.status === 'paused' && <button className="button secondary full-width" disabled={busy} onClick={() => void resumeAnalysis()}><RefreshCw size={16} />继续分析</button>}
        {appendAvailable && <button className="button secondary full-width" disabled={busy || analyzing || !projectModelConfigured} onClick={() => void act('/analyze-append', {}, 'POST', '正在分析新增内容，原有角色、场景和镜头会保留。')}><Sparkles size={16} />分析新增内容</button>}
        {analysisComplete && <button className="button secondary full-width" disabled={busy} onClick={openDurationReset}><Clock3 size={16} />重新规划片段时长</button>}
      </> : <>
        <button className="button primary full-width" disabled={busy || analyzing || uncertainAnalysis || !projectModelConfigured || dirty} onClick={() => void (retryableFailedAnalysis ? retryFailedAnalysis() : act('/analyze', {}, 'POST', failedAnalysis ? '已从已保存进度继续分析。' : '正在分析内容，结果将自动保存。'))}>{analyzing ? <Spinner /> : retryableFailedAnalysis ? <RefreshCw size={16} /> : <Sparkles size={16} />}{analyzing ? '分析内容中…' : uncertainAnalysis ? '分析结果待核实' : retryableFailedAnalysis ? '重试当前分析块' : failedAnalysis ? '从已保存进度继续分析' : '分析内容，规划分镜'}</button>
        {analyzing && <button className="button secondary full-width" disabled={busy} onClick={() => void pauseAnalysis()}><RefreshCw size={16} />暂停分析</button>}
        {analysisJob?.status === 'paused' && <button className="button secondary full-width" disabled={busy} onClick={() => void resumeAnalysis()}><RefreshCw size={16} />继续分析</button>}
        {analysisJob?.analysisProgress && <p className="helper" role="status">已保存 {analysisJob.analysisProgress.completedChunks} / {analysisJob.analysisProgress.totalChunks} 块{analyzing && analysisJob.analysisProgress.currentChunk ? `，当前第 ${analysisJob.analysisProgress.currentChunk} 块` : ''}{analyzing ? analysisJob.analysisProgress.phase === 'correcting' ? '，正在自动修复当前块。' : '，正在继续分析。' : '；原稿和模型不变时，再次分析会复用已完成部分。'}</p>}
        {failedAnalysis && <Notice type="warning">本次分析在已保存的分块处停止，之前完成的内容不会丢失。{retryableFailedAnalysis && <>系统已自动完成多轮结构、视觉和字段级修复。<br /></>}{(retryableAnalysisJob?.error || analysisJob?.error) && <><br />原因：{retryableAnalysisJob?.error || analysisJob?.error}</>}{retryableFailedAnalysis ? <><br />可只重试当前失败块，系统不会重复请求已保存块。<button className="button small secondary" disabled={busy || analyzing || dirty || !projectModelConfigured} onClick={() => void retryFailedAnalysis()}><RefreshCw size={13} />确认并重试当前块</button></> : ' 点击上方按钮会复用已完成块并继续。'}</Notice>}
        {dirty && <p className="helper amber">请先保存原稿修改。</p>}
        {!projectModelConfigured && <button className="text-button centered" onClick={showSettings}>先连接所选文字模型<ArrowRight size={16} /></button>}
        <p className="helper">点击后将原始内容发送给已配置的文字模型，并产生模型费用。分析结果仍需人工确认。</p>
      </>}
    </aside>
  </div>;
}

function ShotCard({ shot, project, selected, bulkSelected, onBulkToggle, mode, onClick }: { shot: Shot; project: Project; selected: boolean; bulkSelected: boolean; onBulkToggle: (checked: boolean) => void; mode: 'image' | 'video'; onClick: () => void }) {
  const segment = project.segments.find(item => item.shots.some(value => value.id === shot.id));
  const segmentBoardMode = project.generationMode === 'segment-board';
  const currentJobs = latestCurrentJobs(project).filter(job => job.targetId === shot.id);
  const working = project.jobs.find(job => isActive(job) && isCurrentJob(project, job) && (job.targetId === shot.id || (segmentBoardMode && ['storyboard', 'segment-video'].includes(job.kind) && job.targetId === segment?.id)));
  const failed = segmentBoardMode && mode === 'image' ? project.jobs.find(job => job.kind === 'storyboard' && job.targetId === segment?.id && ['failed', 'unknown', 'interrupted'].includes(job.status)) : segmentBoardMode && mode === 'video' ? project.jobs.find(job => job.kind === 'segment-video' && job.targetId === segment?.id && ['failed', 'unknown', 'interrupted'].includes(job.status)) : currentJobs.find(job => job.kind === mode);
  const hasVideo = segmentBoardMode && mode === 'video' && segment ? currentSegmentVideo(project, segment) : currentVideo(shot);
  const imageCurrent = currentImage(shot);
  const reviewed = shot.approved && imageCurrent && (segmentBoardMode || shotReferencesReady(project, shot));
  const imageStatus = shot.image && !imageCurrent ? '旧版待更新' : reviewed ? '已审核' : shot.image ? '待审核' : '待生成';
  const names = shot.characterIds.map(id => project.characters.find(character => character.id === id)?.name).filter(Boolean);
  return <article className={`shot-card ${selected ? 'selected' : ''}`}>
    <button className="shot-card-hit" onClick={onClick} aria-label={`镜头 ${pad(shot.number)}，${shot.scene}，${mode === 'video' ? segmentBoardMode ? hasVideo ? '片段完整视频已生成' : '片段完整视频待生成' : hasVideo ? '视频已生成' : '视频待生成' : imageStatus}`} aria-pressed={selected}>
    <div className={`shot-image ratio-${project.aspectRatio.replace(':', '-')}`}>{shot.image ? <img src={assetPreviewUrl(shot.image)} alt={`镜头 ${shot.number}：${shot.scene}`} loading="lazy" /> : <EmptyImage compact label="待生成画面" />}<span className="shot-number">{pad(shot.number)}</span><span className="shot-duration">{shot.duration.toFixed(1)}s</span>{mode === 'image' && reviewed && <span className="approved-tick"><Check size={13} /></span>}{shot.image && !imageCurrent && <span className="shot-stale">旧版</span>}{mode === 'video' && <span className={`video-play ${hasVideo ? 'ready' : 'pending'}`} title={hasVideo ? '打开视频播放器' : '视频待生成'} aria-label={hasVideo ? '打开视频播放器' : '视频待生成'}>{hasVideo ? <Play size={19} fill="currentColor" /> : <Video size={18} />}</span>}{working && <div className="media-working"><Spinner size={21} /><span>{Math.round(working.progress)}%</span></div>}</div>
    <div className="shot-card-details"><div className="shot-title"><h3>{shot.scene}</h3>{mode === 'video' ? <span className={`card-status ${hasVideo ? 'done' : ''}`}>{segmentBoardMode ? hasVideo ? '片段已生成' : '片段待生成' : hasVideo ? '已生成' : '待生成'}</span> : <span className={`card-status ${reviewed ? 'done' : shot.image ? 'review' : ''}`}>{imageStatus}</span>}</div><p>{shot.action}</p><p className="shot-dialogue">{shot.dialogue ? `台词：${shot.dialogue}` : shot.narration ? `旁白：${shot.narration}` : '无台词 / 旁白'}</p>{shot.backgroundActors && <p className="shot-crowd" title={shot.backgroundActors}>群众：{shot.backgroundActors}</p>}<p className="shot-movement" title={shot.movementPlan || shot.camera}>{shot.movementId ? `${shot.movementId} · ` : ''}{shot.movementPlan || shot.camera}</p><div className="shot-card-footer"><span><Users size={11} />{names.join('、') || '空镜'}</span>{!working && failed?.status === 'failed' ? <span className="failed-text">生成失败</span> : <span>{shot.transitionPlan || shot.camera}</span>}</div></div>
    </button>
    <label className="shot-bulk-control"><input className="shot-bulk-checkbox" type="checkbox" checked={bulkSelected} onChange={event => onBulkToggle(event.target.checked)} aria-label={`选择镜头 ${pad(shot.number)} 进行批量操作`} /><span className="visually-hidden">选择镜头 {pad(shot.number)}</span></label>
  </article>;
}

function SegmentNavigation({
  position,
  segment,
  episodeSegments,
  episodeGroups,
  currentEpisodeIndex,
  previousEpisode,
  nextEpisode,
  episodeReady,
  selectEpisode,
  selectSegment,
}: {
  position: 'top' | 'bottom';
  segment: Segment;
  episodeSegments: Segment[];
  episodeGroups: EpisodeGroup[];
  currentEpisodeIndex: number;
  previousEpisode?: EpisodeGroup;
  nextEpisode?: EpisodeGroup;
  episodeReady: boolean;
  selectEpisode: (key: string) => void;
  selectSegment: (id: string) => void;
}) {
  const segmentIndex = episodeSegments.findIndex(item => item.id === segment.id);
  const atFirstSegment = segmentIndex <= 0;
  const atLastSegment = segmentIndex < 0 || segmentIndex === episodeSegments.length - 1;
  return <nav className={`segment-navigation segment-${position}`} aria-label="片段导航">
    <button className="text-button" disabled={!previousEpisode} onClick={() => previousEpisode && selectEpisode(previousEpisode.key)}><ChevronLeft size={15} />上一集</button>
    <button className="text-button" disabled={!episodeSegments.length || atFirstSegment} onClick={() => segmentIndex > 0 && selectSegment(episodeSegments[segmentIndex - 1].id)}><ChevronLeft size={15} />上一段</button>
    <span>{currentEpisodeIndex >= 0 ? `${currentEpisodeIndex + 1} / ${episodeGroups.length} 集 · ` : ''}{segmentIndex + 1} <span>/ {episodeSegments.length} 个片段</span></span>
    <button className="text-button" disabled={!episodeSegments.length || atLastSegment} onClick={() => !atLastSegment && selectSegment(episodeSegments[segmentIndex + 1].id)}>下一段<ChevronRight size={15} /></button>
    <button className="text-button" disabled={!nextEpisode || !episodeReady} title={nextEpisode && !episodeReady ? '请先完成本集所有片段的分镜审核' : undefined} onClick={() => nextEpisode && selectEpisode(nextEpisode.key)}>下一集<ChevronRight size={15} /></button>
  </nav>;
}

function SegmentVideoPanel({ project, segment, busy = false, onRegenerate }: { project: Project; segment: Segment; busy?: boolean; onRegenerate: () => void }) {
  const ready = currentSegmentVideo(project, segment);
  return <section className="exports-section segment-video-panel"><div className="section-label">片段完整视频<span>{segment.duration} 秒 · 故事板按编号连续生成</span></div>{ready && segment.video ? <article className="export-record"><div className="export-record-title"><span className="export-icon"><Film size={20} /></span><div><strong>片段 {String(segment.number).padStart(3, '0')} · 完整视频</strong><small>镜头 1 到 {segment.shots.length} 在同一条视频任务中连续发生</small></div><Badge tone="green">已生成</Badge></div><video src={assetUrl(segment.video)} controls preload="metadata" playsInline /><div className="export-links"><a href={assetUrl(segment.video)} download className="button small primary"><Download size={14} />下载片段视频</a><button type="button" className="button small secondary" disabled={busy} onClick={onRegenerate}><RefreshCw size={14} />重新生成完整片段视频</button></div></article> : segment.remoteVideoDeleted ? <div className="export-empty"><ShieldCheck size={20} strokeWidth={1.4} /><div><strong>视频已归档到本地</strong><p>服务器副本已按本地同步确认清理，请在项目文件夹的 Movie 目录中查看。</p></div></div> : <div className="export-empty"><Video size={20} strokeWidth={1.4} /><div><strong>片段完整视频尚未生成</strong><p>审核全部 {segment.shots.length} 个镜头后，生成一次即可得到一条 {segment.duration} 秒完整视频。</p></div></div>}</section>;
}

function ExportsView({ records, projectRecords = [], templates, currentTemplateId, exportReady = false, exportBusy = false, onExport }: { records: ExportRecord[]; projectRecords?: ExportRecord[]; templates: BoardTemplate[]; currentTemplateId: string; exportReady?: boolean; exportBusy?: boolean; onExport: () => void }) {
  const exportAction = (label: string) => <button type="button" className="button small secondary" disabled={exportBusy || !exportReady} title={!exportReady ? '请先生成并确认当前片段视频' : undefined} onClick={onExport}><RefreshCw size={14} />{label}</button>;
  if (projectRecords.length) return <section className="exports-section"><div className="section-label">项目成片<span>所有片段已按编号合并</span></div>{projectRecords.map(record => <article className="export-record" key={record.id}><div className="export-record-title"><span className="export-icon"><Film size={20} /></span><div><strong>项目成片.mp4</strong><small>{new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></div><Badge tone={record.remoteDeleted ? 'amber' : 'green'}>{record.remoteDeleted ? '已归档到本地' : '已导出'}</Badge></div>{record.remoteDeleted ? <Notice>服务器视频已清理，本地副本仍保存在 Movie 目录。</Notice> : <video src={assetUrl(record.videoUrl)} controls preload="metadata" playsInline />}<div className="export-links">{record.videoUrl && <a href={assetUrl(record.videoUrl)} download className="button small primary"><Download size={14} />下载项目视频</a>}<a href={assetUrl(record.gridUrl)} download className="button small secondary">封面图</a><a href={assetUrl(record.csvUrl)} download className="button small secondary">完整镜头清单</a><a href={assetUrl(record.manifestUrl)} download className="text-button">项目映射清单</a></div></article>)}</section>;
  if (!records.length) return <div className="export-empty"><Download size={20} strokeWidth={1.4} /><div><strong>成片将在这里就绪</strong><p>当前片段视频准备好后，可以直接导出片段成片。</p>{exportAction('导出片段成片')}</div></div>;
  return <section className="exports-section"><div className="section-label"><span>已导出成片</span><span>按剧情顺序编号</span>{exportAction('重新导出片段成片')}</div>{[...records].reverse().map(record => {
    const localCopyFailed = record.localOutput?.status === 'failed';
    const currentTemplate = record.templateId === currentTemplateId;
    return <article className="export-record" key={record.id}><div className="export-record-title"><span className="export-icon"><Film size={20} /></span><div><strong>{String(record.number).padStart(3, '0')}.mp4</strong><small>{new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></div><Badge tone={record.remoteDeleted ? 'amber' : localCopyFailed ? 'amber' : currentTemplate ? 'green' : ''}>{record.remoteDeleted ? '已归档到本地' : localCopyFailed ? '本地副本失败' : currentTemplate ? '已导出' : '历史模板快照'}</Badge></div>{record.remoteDeleted ? <Notice>服务器视频已清理，本地副本仍保存在 Movie 目录。</Notice> : <video src={assetUrl(record.videoUrl)} controls preload="metadata" playsInline />}<BoardPages key={record.gridUrl} record={record} templates={templates} compact /><div className="export-links">{record.videoUrl && <a href={assetUrl(record.videoUrl)} download className="button small primary"><Download size={14} />视频</a>}<a href={assetUrl(record.csvUrl)} download className="button small secondary">分镜清单</a><a href={assetUrl(record.manifestUrl)} download className="text-button">映射清单</a></div></article>;
  })}</section>;
}

function HistoryView({ records, templates, loading, error, retry }: { records: HistoryRecord[]; templates: BoardTemplate[]; loading: boolean; error: string; retry: () => void }) {
  type MediaFilter = 'all' | 'image' | 'video';
  type TimeFilter = 'all' | 'today' | '7d' | '30d' | '90d';
  type HistoryFilters = { projectId: string; media: MediaFilter; recordType: string; segmentKey: string; time: TimeFilter; query: string };
  type HistoryRecordType = NonNullable<HistoryRecord['recordType']>;
  const kindLabel: Record<string, string> = { 'character-image': '人物身份图', 'asset-image': '关键物品图', 'look-image': '场景造型图', 'storyboard-image': '整段分镜板', 'shot-image': '分镜图片', 'shot-video': '镜头视频', 'segment-video': '片段完整视频', 'segment-export': '片段成片', 'project-export': '项目成片' };
  const [filters, setFilters] = useState<HistoryFilters>({ projectId: '', media: 'all', recordType: '', segmentKey: '', time: 'all', query: '' });
  const [page, setPage] = useState(1);
  const [selectedRecord, setSelectedRecord] = useState<HistoryRecord | null>(null);
  const [fullImage, setFullImage] = useState<{ src: string; alt: string } | null>(null);
  const sorted = useMemo(() => [...records].sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()), [records]);
  const projectOptions = useMemo(() => {
    const options = new Map<string, string>();
    records.forEach(record => { if (record.projectId) options.set(record.projectId, record.projectTitle || '未命名项目'); });
    return [...options.entries()].map(([id, title]) => ({ id, title })).sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
  }, [records]);
  const taskOptions = useMemo<HistoryRecordType[]>(() => [...new Set(records.map(record => record.recordType).filter((value): value is HistoryRecordType => Boolean(value)))].sort((left, right) => (kindLabel[left] || left).localeCompare(kindLabel[right] || right, 'zh-CN')), [records]);
  const segmentOptions = useMemo(() => {
    const options = new Map<string, string>();
    records.forEach(record => {
      if (record.segmentId && record.segmentTitle) options.set(`segment:${record.segmentId}`, `分镜：${record.segmentTitle}`);
      if (record.sceneId && record.sceneTitle) options.set(`scene:${record.sceneId}`, `场景：${record.sceneTitle}`);
      if (!record.segmentId && !record.sceneId && record.segmentTitle) options.set(`title:${record.segmentTitle}`, record.segmentTitle);
    });
    return [...options.entries()].map(([key, title]) => ({ key, title })).sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
  }, [records]);
  const mediaKind = (record: HistoryRecord): Exclude<MediaFilter, 'all'> | null => {
    if (record.recordType?.endsWith('image')) return 'image';
    if (record.recordType?.endsWith('video') || record.recordType?.endsWith('export') || record.videoUrl) return 'video';
    return null;
  };
  const filtered = useMemo(() => {
    const query = filters.query.trim().toLocaleLowerCase();
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const rangeStart = filters.time === 'today' ? todayStart.getTime() : filters.time === '7d' ? todayStart.setDate(todayStart.getDate() - 6) : filters.time === '30d' ? todayStart.setDate(todayStart.getDate() - 29) : filters.time === '90d' ? todayStart.setDate(todayStart.getDate() - 89) : null;
    return sorted.filter(record => {
      if (filters.projectId && record.projectId !== filters.projectId) return false;
      if (filters.media !== 'all' && mediaKind(record) !== filters.media) return false;
      if (filters.recordType && record.recordType !== filters.recordType) return false;
      const segmentKeys = [record.segmentId ? `segment:${record.segmentId}` : '', record.sceneId ? `scene:${record.sceneId}` : '', !record.segmentId && !record.sceneId && record.segmentTitle ? `title:${record.segmentTitle}` : ''].filter(Boolean);
      if (filters.segmentKey && !segmentKeys.includes(filters.segmentKey)) return false;
      if (rangeStart !== null) {
        const createdAt = new Date(record.createdAt || '').getTime();
        if (!Number.isFinite(createdAt) || createdAt < rangeStart) return false;
      }
      if (query) {
        const haystack = [record.projectTitle, record.projectId, record.assetTitle, record.segmentTitle, record.segmentId, record.sceneTitle, record.sceneId, record.shotId, record.characterName, record.characterId, record.source, record.recordType ? kindLabel[record.recordType] : '', record.recordType, record.id, record.number ? `镜头 ${record.number}` : '', record.number].filter(Boolean).join(' ').toLocaleLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [filters, sorted]);
  useEffect(() => { setPage(1); }, [filtered]);
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleRecords = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const hasFilters = Boolean(filters.projectId || filters.media !== 'all' || filters.recordType || filters.segmentKey || filters.time !== 'all' || filters.query.trim());
  const clearFilters = () => setFilters({ projectId: '', media: 'all', recordType: '', segmentKey: '', time: 'all', query: '' });
  const dateLabel = (value?: string) => {
    if (!value) return '时间待记录';
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? '时间待记录' : timestamp.toLocaleString('zh-CN', { hour12: false });
  };
  if (loading) return <main className="history-page"><div className="history-state"><Spinner size={26} /><strong>正在加载历史台账</strong><p>正在读取当前账号保留的图片、视频和导出文件。</p></div></main>;
  if (error) return <main className="history-page"><div className="history-state error"><RefreshCw size={25} /><strong>历史台账暂时不可用</strong><p>{error}</p><button className="button secondary" onClick={retry}><RefreshCw size={14} />重新加载</button></div></main>;
  if (!records.length) return <main className="history-page"><SectionEmpty title="还没有制作记录" text="生成图片、视频或完成项目导出后，文件会按账号保留在这里。" icon={<History size={32} strokeWidth={1.3} />} /></main>;
  return <main className="history-page">
    <div className="history-summary"><div className="section-label">制作台账<span>{filtered.length} / {records.length} 条记录 · 当前账号</span></div><p>按项目、媒体、任务、分镜和时间快速定位素材。</p></div>
    <section className="history-filters" aria-label="历史记录筛选">
      <div className="history-filter-grid">
        <label className="history-filter history-filter-search"><Search size={16} /><span className="visually-hidden">关键词</span><input value={filters.query} onChange={event => setFilters(previous => ({ ...previous, query: event.target.value }))} placeholder="搜索项目、镜头或素材" /></label>
        <label className="history-filter"><span>项目</span><select value={filters.projectId} onChange={event => setFilters(previous => ({ ...previous, projectId: event.target.value }))}><option value="">全部项目</option>{projectOptions.map(option => <option value={option.id} key={option.id}>{option.title}</option>)}</select></label>
        <label className="history-filter"><span>媒体</span><select value={filters.media} onChange={event => setFilters(previous => ({ ...previous, media: event.target.value as MediaFilter }))}><option value="all">全部媒体</option><option value="image">图片</option><option value="video">视频</option></select></label>
        <label className="history-filter"><span>任务类型</span><select value={filters.recordType} onChange={event => setFilters(previous => ({ ...previous, recordType: event.target.value }))}><option value="">全部任务</option>{taskOptions.map(value => <option value={value} key={value}>{kindLabel[value] || value}</option>)}</select></label>
        <label className="history-filter"><span>分镜 / 场景</span><select value={filters.segmentKey} onChange={event => setFilters(previous => ({ ...previous, segmentKey: event.target.value }))}><option value="">全部分镜 / 场景</option>{segmentOptions.map(option => <option value={option.key} key={option.key}>{option.title}</option>)}</select></label>
        <label className="history-filter"><span>时间</span><select value={filters.time} onChange={event => setFilters(previous => ({ ...previous, time: event.target.value as TimeFilter }))}><option value="all">不限时间</option><option value="today">今天</option><option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="90d">近 90 天</option></select></label>
      </div>
      <div className="history-filter-status"><span><strong>{filtered.length}</strong> 条匹配记录</span>{hasFilters && <button className="text-button" onClick={clearFilters}><X size={14} />清除筛选</button>}</div>
    </section>
    {filtered.length === 0 ? <div className="history-state filtered-empty"><Search size={28} /><strong>没有匹配记录</strong><p>调整项目、媒体、任务类型、分镜或时间条件后再试。</p><button className="button secondary" onClick={clearFilters}><X size={14} />清除筛选</button></div> : <><div className="history-list">{visibleRecords.map(record => {
      const template = templates.find(item => item.id === record.templateId);
      const isImage = mediaKind(record) === 'image';
      const isVideo = mediaKind(record) === 'video';
      const media = isVideo ? (record.assetUrl || record.videoUrl || '') : (record.assetUrl || record.gridUrl || '');
      const label = kindLabel[record.recordType || ''] || template?.name || record.templateId || '制作记录';
      const context = [record.segmentTitle, record.characterName].filter(Boolean).join(' · ');
      return <article className="history-record" key={record.id}>
        <header className="history-record-header"><div className="history-record-title"><span className="export-icon">{isImage ? <FileImage size={20} /> : isVideo ? <Video size={20} /> : <Film size={20} />}</span><div><h2>{record.projectTitle || '未命名项目'}</h2><p>{record.assetTitle || context || label}</p>{context && record.assetTitle && <small className="history-record-context">{context}</small>}</div></div><div className="history-record-meta"><Badge tone={record.recordType === 'project-export' ? 'green' : ''}>{label}</Badge><time dateTime={record.createdAt}>{dateLabel(record.createdAt)}</time></div></header>
        {record.remoteDeleted && <Notice type="warning">该视频已由客户端确认保存到本地，服务器副本已清理。</Notice>}
        {isImage && media && <button type="button" className="history-preview-trigger" onClick={() => setSelectedRecord(record)} aria-label={`查看${record.assetTitle || '制作图片'}详情`}><img className="history-asset-image" src={assetPreviewUrl(media)} alt={record.assetTitle || '制作图片'} loading="lazy" /></button>}
        {!isImage && isVideo && media && !record.remoteDeleted && <video className="history-video" src={assetUrl(media)} controls preload="metadata" playsInline />}
        {!isImage && record.gridUrl && <div className="history-board"><BoardPages key={record.gridUrl} record={record as ExportRecord} templates={templates} compact /></div>}
        <div className="export-links history-links"><button type="button" className="button small secondary" onClick={() => setSelectedRecord(record)}><Eye size={14} />查看详情</button>{media && <a href={assetUrl(media)} download className="button small primary"><Download size={14} />下载文件</a>}{record.gridUrl && record.gridUrl !== media && <a href={assetUrl(record.gridUrl)} download className="button small secondary">设定板</a>}{record.csvUrl && <a href={assetUrl(record.csvUrl)} download className="button small secondary">清单</a>}{record.manifestUrl && <a href={assetUrl(record.manifestUrl)} download className="text-button">映射清单</a>}</div>
      </article>;
    })}</div><nav className="history-pagination" aria-label="历史记录分页"><span>第 {currentPage} / {pageCount} 页 · 每页 {pageSize} 条</span><div><button className="button small secondary" disabled={currentPage <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}><ChevronLeft size={14} />上一页</button><button className="button small secondary" disabled={currentPage >= pageCount} onClick={() => setPage(value => Math.min(pageCount, value + 1))}>下一页<ChevronRight size={14} /></button></div></nav></>}
    {selectedRecord && (() => {
      const isImage = mediaKind(selectedRecord) === 'image';
      const isVideo = mediaKind(selectedRecord) === 'video';
      const media = isVideo ? (selectedRecord.assetUrl || selectedRecord.videoUrl || '') : (selectedRecord.assetUrl || selectedRecord.gridUrl || '');
      const label = kindLabel[selectedRecord.recordType || ''] || selectedRecord.recordType || '制作记录';
      return <Modal title={selectedRecord.assetTitle || selectedRecord.projectTitle || '制作记录'} subtitle={`${selectedRecord.projectTitle || '未命名项目'} · ${label} · ${dateLabel(selectedRecord.createdAt)}`} close={() => setSelectedRecord(null)} wide>
        {selectedRecord.remoteDeleted && <Notice type="warning">该视频已由客户端确认保存到本地，服务器副本已清理。</Notice>}
        {isImage && media && !selectedRecord.remoteDeleted && <button type="button" className="history-detail-image-trigger" onClick={() => setFullImage({ src: assetUrl(media), alt: selectedRecord.assetTitle || '制作原图' })}><img className="history-detail-image" src={assetUrl(media)} alt={selectedRecord.assetTitle || '制作原图'} /></button>}
        {isVideo && media && !selectedRecord.remoteDeleted && <video className="history-detail-video" src={assetUrl(media)} controls preload="metadata" playsInline />}
        {selectedRecord.prompt ? <section className="history-prompt-section"><h3>生成提示词</h3><pre className="history-prompt">{selectedRecord.prompt}</pre></section> : <section className="history-prompt-section"><h3>生成提示词</h3><p className="helper">{selectedRecord.source === 'upload' ? '用户上传的素材，没有生成提示词。' : '这条较早的记录没有保存生成提示词。'}</p></section>}
        <div className="export-links history-links">{media && !selectedRecord.remoteDeleted && <a href={assetUrl(media)} download className="button small primary"><Download size={14} />下载文件</a>}{selectedRecord.gridUrl && selectedRecord.gridUrl !== media && <a href={assetUrl(selectedRecord.gridUrl)} download className="button small secondary">设定板</a>}{selectedRecord.csvUrl && <a href={assetUrl(selectedRecord.csvUrl)} download className="button small secondary">清单</a>}{selectedRecord.manifestUrl && <a href={assetUrl(selectedRecord.manifestUrl)} download className="text-button">映射清单</a>}</div>
      </Modal>;
    })()}
    {fullImage && <ImageLightbox src={fullImage.src} alt={fullImage.alt} close={() => setFullImage(null)} />}
  </main>;
}
