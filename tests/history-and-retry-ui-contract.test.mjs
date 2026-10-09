import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('history ledger shows eight records per page in a four-column desktop grid', async () => {
  const app = await readFile(path.resolve('src/App.tsx'), 'utf8');
  const styles = await readFile(path.resolve('src/styles.css'), 'utf8');
  assert.match(app, /const pageSize\s*=\s*8/);
  assert.match(styles, /\.history-list\{[^}]*grid-template-columns:\s*repeat\(4\s*,\s*minmax\(0\s*,\s*1fr\)/);
});

test('analysis retry chooses the recoverable failed block instead of blindly starting a new analysis', async () => {
  const source = await readFile(path.resolve('src/App.tsx'), 'utf8');
  assert.match(source, /retryableAnalysisJob\s*=\s*\[\.\.\.project\.jobs\]\s*\.reverse\(\)\s*\.find/);
  assert.match(source, /retryableAnalysisJob\.id/);
  assert.match(source, /retryableAnalysisJob\?\.error/);
});

test('video and export surfaces keep explicit regeneration actions after a completed result', async () => {
  const source = await readFile(path.resolve('src/App.tsx'), 'utf8');
  assert.match(source, /重新生成完整片段视频/);
  assert.match(source, /重新合成项目成片/);
  assert.match(source, /导出片段成片/);
  assert.match(source, /重新导出片段成片/);
  assert.match(source, /segments\/\$\{segment\.id\}\/export/);
  assert.match(source, /reuseExisting:\s*false/);
});

test('continuity asset catalogs keep independent desktop scroll regions and natural mobile flow', async () => {
  const styles = await readFile(path.resolve('src/styles.css'), 'utf8');
  assert.match(styles, /\.assets-list,\.scene-list\{[^}]*max-height:calc\(100vh - 190px\)[^}]*overflow-y:auto/);
  assert.match(styles, /@media\(max-width:860px\)\{\.assets-list,\.scene-list\{max-height:none;overflow:visible;position:static\}\}/);
});
