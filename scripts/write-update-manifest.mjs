import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const installerName = `YingXu-${pkg.version}-win-x64-setup.exe`;
const publicVersion = typeof pkg.clientVersion === 'string' && pkg.clientVersion.trim() ? pkg.clientVersion.trim() : pkg.version;
const publicInstallerName = `YingXu-${publicVersion}-win-x64-setup.exe`;
const installerPath = path.join(root, 'release', installerName);
const publicInstallerPath = path.join(root, 'release', publicInstallerName);
const installer = await readFile(installerPath);
const sha256 = createHash('sha256').update(installer).digest('hex');
if (publicInstallerName !== installerName) await copyFile(installerPath, publicInstallerPath);
const manifest = {
  version: pkg.version,
  // Older clients only accept semantic-looking display values. Keep the
  // date-based clientVersion in the installed app and download filename, but
  // use the package version here so v5 clients can bootstrap to this release.
  displayVersion: pkg.version,
  url: `https://wsfile.cn/workf/downloads/${publicInstallerName}`,
  sha256,
  releaseNotes: `修复长篇分集剧本开头的作品设定和目录被误判为分镜内容，导致分析无法从第一集继续的问题。`,
};
await writeFile(path.join(root, 'client', 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ path: path.join(root, 'client', 'latest.json'), ...manifest }, null, 2));
