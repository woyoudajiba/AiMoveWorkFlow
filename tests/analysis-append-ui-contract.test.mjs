import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('workbench exposes append-analysis controls without locking the analyzed manuscript', async () => {
  const source = await readFile(path.resolve('src/App.tsx'), 'utf8');
  assert.match(source, /analysisSourceLength/);
  assert.match(source, /analyze-append/);
  assert.match(source, /novel\.startsWith\(project\.novel\)/);
  assert.match(source, /分析新增内容/);
  assert.match(source, /重试当前分析块/);
  assert.match(source, /analysisRetryable/);
  assert.match(source, /pauseAnalysis/);
  assert.match(source, /继续分析/);
  assert.match(source, /前 \$\{analysisJob\.analysisProgress\.readyThroughChunk\}/);
});

test('unknown analysis recovery stays visible after a partial result and in task history', async () => {
  const app = await readFile(path.resolve('src/App.tsx'), 'utf8');
  const dialogs = await readFile(path.resolve('src/dialogs.tsx'), 'utf8');
  const partialBranch = app.indexOf('{analyzed ? <>');
  const recoveryNotice = app.indexOf('{uncertainAnalysis && <Notice');
  assert.ok(partialBranch >= 0, 'story page should have the analyzed branch');
  assert.ok(recoveryNotice >= 0 && recoveryNotice < partialBranch, 'unknown recovery must be rendered before the analyzed branch');
  assert.match(dialogs, /job\.kind === 'analyze' && job\.status === 'unknown'/);
  assert.match(dialogs, /retry-analysis/);
  assert.match(dialogs, /confirmDuplicateCost: true/);
});

test('workbench provides a separate sequel editor that appends only after explicit save', async () => {
  const source = await readFile(path.resolve('src/App.tsx'), 'utf8');
  const drafts = await readFile(path.resolve('src/drafts.ts'), 'utf8');
  assert.match(source, /续集内容/);
  assert.match(source, /保存续集内容/);
  assert.match(source, /appendNovelContent\(project\.novel, sequelNovel\)/);
  assert.match(source, /change\(\{ novel: next\.novel, sequelNovel: '' \}\)/);
  assert.match(source, /分析新增内容/);
  assert.match(drafts, /sequelNovel\?: string/);
  assert.match(drafts, /function appendNovelContent/);
});

test('hidden Electron titlebar has a draggable topbar and interactive no-drag controls', async () => {
  const source = await readFile(path.resolve('src/styles.css'), 'utf8');
  const app = await readFile(path.resolve('src/App.tsx'), 'utf8');
  assert.match(app, /className="desktop-drag-strip"/);
  assert.match(source, /\.desktop-drag-strip\{[^}]*-webkit-app-region:drag/);
  assert.match(source, /\.topbar\{[^}]*-webkit-app-region:drag/);
  assert.match(source, /\.topbar button,\.topbar a,\.topbar input,\.topbar select,\.topbar-right\{[^}]*-webkit-app-region:no-drag/);
});
