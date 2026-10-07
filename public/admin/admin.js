(() => {
  const root = window.location.pathname.replace(/\/admin\/?$/, '');
  const endpoint = path => `${root}${path}`;
  const $ = id => document.getElementById(id);
  const loginPanel = $('login-panel'), dashboard = $('dashboard'), notice = $('notice');
  let snapshot = null;
  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
  function setNotice(message, error = false) { notice.textContent = message; notice.className = `notice${error ? ' error' : ''}`; notice.hidden = !message; }
  async function request(path, options = {}) {
    const response = await fetch(endpoint(path), { credentials: 'same-origin', cache: 'no-store', headers: {'Content-Type':'application/json','X-Local-Client':'aiframe', ...(options.headers || {})}, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }
  function showDashboard() { loginPanel.hidden = true; dashboard.hidden = false; $('refresh-button').hidden = false; $('logout-button').hidden = false; $('session-label').textContent = '管理员已登录'; }
  function showLogin() { loginPanel.hidden = false; dashboard.hidden = true; $('refresh-button').hidden = true; $('logout-button').hidden = true; $('session-label').textContent = '未登录'; }
  function renderSummary(totals) {
    const items = [['账号', totals.accounts], ['项目', totals.projects], ['云端媒体', `${totals.mediaFiles} 个 · ${formatBytes(totals.mediaBytes)}`], ['分析数据', `${totals.analysisFiles} 个 · ${formatBytes(totals.analysisBytes)}`]];
    $('summary').innerHTML = items.map(([label, value]) => `<div class="summary-card"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('');
  }
  function renderAccounts() {
    const query = ($('search').value || '').trim().toLowerCase();
    let visible = 0;
    $('accounts').innerHTML = (snapshot?.accounts || []).map(account => {
      const projects = account.projects.filter(project => !query || `${project.title} ${account.accountRef}`.toLowerCase().includes(query));
      if (!projects.length) return '';
      visible += projects.length;
      const rows = projects.map(project => `<tr><td><div class="project-title">${escapeHtml(project.title)}</div><div class="project-meta">${escapeHtml(project.id)}</div></td><td class="numbers">${project.segmentCount} 段 · ${project.shotCount} 镜</td><td class="numbers">${project.activeTaskCount ? `${project.activeTaskCount} 个任务` : '无活动任务'}</td><td><button class="button danger delete-project" data-account="${escapeHtml(account.accountRef)}" data-project="${escapeHtml(project.id)}" type="button">删除项目</button></td></tr>`).join('');
      return `<section class="account"><div class="account-head"><div><strong>账号 ${escapeHtml(account.accountRef)}</strong><small>${account.projectCount} 个项目 · ${account.mediaFiles} 个媒体文件</small></div><div class="account-size">媒体 ${formatBytes(account.mediaBytes)}<br />分析 ${formatBytes(account.analysisBytes)}</div></div><div class="table-wrap"><table class="project-table"><thead><tr><th>项目</th><th>内容规模</th><th>任务</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
    }).join('') || '<div class="empty">没有匹配的项目</div>';
    $('project-count').textContent = `显示 ${visible} 个项目`;
    document.querySelectorAll('.delete-project').forEach(button => button.addEventListener('click', () => deleteProject(button.dataset.account, button.dataset.project)));
  }
  async function loadProjects() {
    setNotice('正在读取云端台账…');
    try { snapshot = await request('/api/admin/projects'); renderSummary(snapshot.totals); renderAccounts(); $('last-updated').textContent = `最近刷新：${new Date().toLocaleString('zh-CN')}`; setNotice(''); }
    catch (error) { setNotice(error.message, true); }
  }
  async function deleteProject(accountRef, projectId) {
    if (!window.confirm('确认删除这个项目的原稿、图片、视频、分析结果和供应商回执吗？此操作不可恢复。')) return;
    try { await request('/api/admin/projects', {method:'DELETE', body:JSON.stringify({confirm:true,accountRef,projectId})}); setNotice('项目数据已删除。'); await loadProjects(); }
    catch (error) { setNotice(error.message, true); }
  }
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); setNotice(''); const button = event.submitter; button.disabled = true;
    try { await request('/api/admin/auth/login', {method:'POST', body:JSON.stringify({password:$('password').value})}); $('password').value = ''; showDashboard(); await loadProjects(); }
    catch (error) { setNotice(error.message, true); }
    finally { button.disabled = false; }
  });
  $('logout-button').addEventListener('click', async () => { try { await request('/api/admin/auth/logout', {method:'POST', body:'{}'}); showLogin(); setNotice(''); } catch (error) { setNotice(error.message, true); } });
  $('refresh-button').addEventListener('click', loadProjects);
  $('search').addEventListener('input', renderAccounts);
  $('cleanup-button').addEventListener('click', async () => {
    if (!window.confirm('确认清理所有账号的云端图片、视频、分析结果、分析检查点和供应商回执吗？账号身份、项目标题与原始内容会保留；此操作不可恢复。')) return;
    const button = $('cleanup-button'); button.disabled = true;
    try { await request('/api/admin/cleanup', {method:'POST', body:JSON.stringify({confirm:true,scope:'media-analysis'})}); setNotice('全局媒体与分析数据已清理。'); await loadProjects(); }
    catch (error) { setNotice(error.message, true); }
    finally { button.disabled = false; }
  });
  request('/api/admin/auth/status').then(state => state.authenticated ? (showDashboard(), loadProjects()) : showLogin()).catch(() => showLogin());
})();
