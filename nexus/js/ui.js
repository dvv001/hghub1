/* ============================================================================
   Layer 6: UI Views, Modals & Event Orchestration (Nexus.ui)
   Clean single-pass event binding, rAF-throttled streaming, full HTML escaping.
   ============================================================================ */
(function (global) {
  'use strict';

  const Nexus = (global.Nexus = global.Nexus || {});
  const { CONST, util, state, store, transport, engine, audio, topology } = Nexus;

  const $ = (id) => document.getElementById(id);
  let squadModalCb = null;
  let streamRafPending = false;

  /* ===== Toast & Clipboard ===== */
  function showToast(msg) {
    const banner = $('toastBanner');
    const txt = $('toastText');
    if (!banner || !txt) return;
    txt.textContent = msg;
    banner.classList.remove('hidden');
    clearTimeout(banner._timer);
    banner._timer = setTimeout(() => banner.classList.add('hidden'), 2500);
  }

  function copyText(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast(msg)).catch(() => fallbackCopy(text, msg));
    } else {
      fallbackCopy(text, msg);
    }
  }

  function fallbackCopy(text, msg) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast(msg); } catch (_) {}
    document.body.removeChild(ta);
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ===== Bus Log ===== */
  function appendLog(tag, text, color) {
    const box = $('busLogBox');
    if (!box) return;
    if (box.children.length === 1 && box.children[0].classList.contains('log-empty')) {
      box.innerHTML = '';
    }
    const time = new Date().toTimeString().slice(0, 8);
    const item = document.createElement('div');
    item.className = 'log-entry safe-wrap';
    item.style.borderLeftColor = color || '#00F0FF';
    item.innerHTML = `<span class="log-tag">[${time}] ${util.escHtml(tag)}</span> ${util.escHtml(text)}`;
    box.prepend(item);
  }

  /* ===== Header & Telemetry Sync ===== */
  function syncHeaderAndMetrics() {
    const hasKey = Boolean((state.api.apiKey || '').trim());
    const alertBanner = $('apiAlertBanner');
    const island = $('dynamicIslandBtn');
    const dot = $('islandDot');
    const islandTxt = $('islandText');
    const subStatus = $('subHeaderStatus');

    if (alertBanner) alertBanner.classList.toggle('hidden', hasKey);

    if (state.isExecuting) {
      island.classList.add('active-api');
      dot.className = 'island-dot running';
      const running = state.agents.filter((a) => a.status === 'running');
      islandTxt.textContent = running.length > 1
        ? `量子并发 (${running.map((a) => a.shortName).join('+')})...`
        : running[0] ? `${running[0].shortName} 正在请求 API...` : '正在调用 API...';
    } else if (hasKey) {
      island.classList.remove('active-api');
      dot.className = 'island-dot ready';
      islandTxt.textContent = `已就绪 · ${state.api.model}`;
    } else {
      island.classList.remove('active-api');
      dot.className = 'island-dot warn';
      islandTxt.textContent = '待配置模型 API';
    }

    subStatus.textContent = hasKey
      ? `当前引擎: ${state.api.model} · Claw 全自动压缩已激活`
      : '全自动三阶压缩 · 智能路由 · 零感自愈';

    $('headerTokens').textContent = `${state.cumulativeTokens} tok`;
    $('kpiRealTokens').textContent = state.cumulativeTokens.toLocaleString();
    $('kpiSavedTokens').textContent = `(省${state.tridentStats.tokensSavedEstimate})`;
    $('kpiRealLatency').textContent = `${(state.cumulativeLatencyMs / 1000).toFixed(1)}s`;

    const enabledList = state.agents.filter((a) => a.enabled);
    const doneList = enabledList.filter((a) => a.status === 'done');
    $('kpiDoneAgents').textContent = String(doneList.length);
    $('kpiEnabledAgents').textContent = String(enabledList.length);

    $('runMissionBtn').classList.toggle('hidden', state.isExecuting);
    $('abortMissionBtn').classList.toggle('hidden', !state.isExecuting);
  }

  function syncSfxBtnUI() {
    const btn = $('sfxToggleBtn');
    if (!btn) return;
    if (audio.enabled) {
      btn.textContent = '🔊 音效';
      btn.className = 'btn btn-ghost btn-sm';
    } else {
      btn.textContent = '🔇 静音';
      btn.className = 'btn btn-muted btn-sm';
    }
  }

  /* ===== Workspace Pipeline Cards (rAF-throttled in-place stream update) ===== */
  function updateStreamingAgentInPlace(ag) {
    if (!ag) {
      renderPipelineCards();
      syncHeaderAndMetrics();
      return;
    }
    if (streamRafPending) return;
    streamRafPending = true;
    requestAnimationFrame(() => {
      streamRafPending = false;
      const card = document.querySelector(`[data-card-agent="${ag.id}"]`);
      if (!card || ag.status !== 'running') {
        renderPipelineCards();
      } else {
        let snip = card.querySelector('.agent-snippet');
        const text = ag.output ? ag.output.slice(0, 160) + (ag.output.length > 160 ? '...' : '') : '';
        if (text) {
          if (!snip) {
            snip = document.createElement('div');
            snip.className = 'agent-snippet safe-wrap';
            card.appendChild(snip);
          }
          snip.textContent = text;
        }
      }
      if (state.inspectedAgentId === ag.id && !$('agentInspectorModal').classList.contains('hidden')) {
        $('modalAgOutput').textContent = ag.output;
      }
      syncHeaderAndMetrics();
    });
  }

  function renderPipelineCards() {
    const container = $('pipelineAgentCards');
    if (!container) return;
    const enabledList = state.agents.filter((a) => a.enabled);

    container.innerHTML = enabledList.map((ag, idx) => {
      let badge = '<span class="status-pill status-idle">待命</span>';
      let stateCls = '';
      if (ag.status === 'running') {
        badge = '<span class="status-pill status-running">● 推理中...</span>';
        stateCls = 'is-running';
      } else if (ag.status === 'done') {
        const cacheTag = ag.cachedHit ? ' · ⚡秒回' : '';
        badge = `<span class="status-pill status-done">✔ ${(ag.latencyMs / 1000).toFixed(1)}s · ${ag.tokens}tok${cacheTag}</span>`;
        stateCls = 'is-done';
      } else if (ag.status === 'error') {
        badge = '<span class="status-pill status-error">✕ 异常</span>';
        stateCls = 'is-error';
      }

      const snippet = ag.output
        ? util.escHtml(ag.output.slice(0, 160)) + (ag.output.length > 160 ? '...' : '')
        : '';

      return `
        <div data-card-agent="${util.escHtml(ag.id)}" class="agent-card ${stateCls}">
          <div class="row-between">
            <div class="row flex-1">
              <div class="agent-avatar" style="background:${util.escHtml(ag.color)}22; border:1px solid ${util.escHtml(ag.color)}66;">
                ${util.escHtml(ag.icon)}
              </div>
              <div class="flex-1">
                <div class="agent-name truncate">${idx + 1}. ${util.escHtml(ag.name)}</div>
                <div class="agent-role truncate">${util.escHtml(ag.role)}</div>
              </div>
            </div>
            ${badge}
          </div>
          ${snippet ? `<div class="agent-snippet safe-wrap">${snippet}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  /* ===== Squads & Agent Settings ===== */
  function renderSquadBar() {
    const bar = $('squadBar');
    if (!bar) return;
    bar.innerHTML = state.squads.map((sq) => `
      <button type="button" data-squad-id="${util.escHtml(sq.id)}" class="squad-btn ${sq.id === state.activeSquadId ? 'active' : ''}">
        ${util.escHtml(sq.name)}
      </button>
    `).join('');
  }

  function renderAgentSettings() {
    const container = $('agentConfigContainer');
    if (!container) return;
    container.innerHTML = state.agents.map((ag) => `
      <div class="cyber-panel stack-sm">
        <div class="row-between">
          <div class="row flex-1">
            <span style="font-size: 18px;">${util.escHtml(ag.icon)}</span>
            <div class="flex-1">
              <div class="agent-name truncate">${util.escHtml(ag.name)}</div>
              <div class="agent-role truncate">${util.escHtml(ag.role)}</div>
            </div>
          </div>
          <button type="button" data-toggle-id="${util.escHtml(ag.id)}" class="btn btn-xs ${ag.enabled ? 'btn-ghost' : 'btn-muted'}">
            ${ag.enabled ? '已启用' : '已停用'}
          </button>
        </div>
        <div class="field-group">
          <label class="field-label">System Prompt（真实请求时注入该角色系统指令）</label>
          <textarea data-prompt-id="${util.escHtml(ag.id)}" rows="2" class="field-textarea">${util.escHtml(ag.systemPrompt)}</textarea>
        </div>
      </div>
    `).join('');
  }

  function refreshAfterSquadChange() {
    topology.rebuildPlanes();
    renderSquadBar();
    renderAgentSettings();
    renderPipelineCards();
    renderLibrary();
    syncHeaderAndMetrics();
  }

  function switchSquad(id) {
    if (state.isExecuting) {
      showToast('任务执行中，请先停止任务再切换编队');
      return;
    }
    const sq = state.squads.find((s) => s.id === id);
    if (!sq || id === state.activeSquadId) return;
    store.persistActiveSquad();
    store.loadSquadIntoRuntime(sq);
    store.saveSquads();
    refreshAfterSquadChange();
    showToast(`已切换为「${sq.name}」`);
  }

  /* ===== Shared Library UI ===== */
  function renderAgentChecks(containerId, selected) {
    const box = $(containerId);
    if (!box) return;
    const sel = (selected && selected.length) ? selected : ['all'];
    let html = `<label class="agent-check-pill"><input type="checkbox" value="all"${sel.includes('all') ? ' checked' : ''}> 全部</label>`;
    state.agents.forEach((ag) => {
      html += `<label class="agent-check-pill"><input type="checkbox" value="${util.escHtml(ag.id)}"${sel.includes(ag.id) ? ' checked' : ''}> ${util.escHtml(ag.name)}</label>`;
    });
    box.innerHTML = html;
  }

  function readAgentChecks(containerId) {
    const box = $(containerId);
    if (!box) return ['all'];
    const vals = [...box.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
    return vals.length ? vals : ['all'];
  }

  function bindMutualExclusionChecks(containerId) {
    const box = $(containerId);
    if (!box) return;
    box.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!t || t.type !== 'checkbox') return;
      const allBox = box.querySelector('input[value="all"]');
      const others = [...box.querySelectorAll('input[type="checkbox"]:not([value="all"])')];
      if (t.value === 'all' && t.checked) {
        others.forEach((cb) => { cb.checked = false; });
      } else if (t.value !== 'all' && t.checked && allBox) {
        allBox.checked = false;
      }
      if (allBox && !allBox.checked && others.every((cb) => !cb.checked)) {
        allBox.checked = true;
      }
    });
  }

  function libItemRow(kind, item) {
    const on = item.enabled !== false;
    const desc = kind === 'inst' ? String(item.text || '').slice(0, 60) : (item.desc || (kind === 'mcp' ? item.url : ''));
    return `
      <div class="lib-item-row">
        <div class="flex-1">
          <div class="agent-name truncate">
            ${util.escHtml(item.name)}
            ${on ? '' : ' <span class="lib-badge-off">（已停用）</span>'}
            ${kind === 'skill' && item.forceLoad ? ' <span class="lib-badge-force">· 必加载</span>' : ''}
          </div>
          <div class="agent-role truncate">${util.escHtml(desc)}</div>
          <div class="agent-role truncate">分配：${util.escHtml(store.getAssignSummary(item))}</div>
        </div>
        <div class="row" style="gap: 4px; flex-shrink: 0;">
          <button type="button" data-libact="edit" data-kind="${kind}" data-id="${util.escHtml(item.id)}" class="btn btn-ghost btn-xs">编辑</button>
          <button type="button" data-libact="toggle" data-kind="${kind}" data-id="${util.escHtml(item.id)}" class="btn btn-muted btn-xs">${on ? '停用' : '启用'}</button>
          <button type="button" data-libact="del" data-kind="${kind}" data-id="${util.escHtml(item.id)}" class="btn btn-danger-soft btn-xs">删</button>
        </div>
      </div>
    `;
  }

  function renderLibrary() {
    const counts = $('libCounts');
    if (!counts) return;
    counts.textContent = `${state.skills.length} 技能 · ${state.mcpServers.length} MCP · ${state.instructions.length} 指令`;
    $('libSkillList').innerHTML = state.skills.length
      ? state.skills.map((s) => libItemRow('skill', s)).join('')
      : '<p class="panel-subtitle">还没有技能，在下面添加或导入。</p>';
    $('libMcpList').innerHTML = state.mcpServers.length
      ? state.mcpServers.map((s) => libItemRow('mcp', s)).join('')
      : '<p class="panel-subtitle">还没有 MCP 服务器，在下面添加。</p>';
    $('libInstList').innerHTML = state.instructions.length
      ? state.instructions.map((s) => libItemRow('inst', s)).join('')
      : '<p class="panel-subtitle">还没有指令，在下面添加。</p>';

    if (!$('libSkillEditId').value) renderAgentChecks('libSkillAgents', ['all']);
    if (!$('libMcpEditId').value) renderAgentChecks('libMcpAgents', ['all']);
    if (!$('libInstEditId').value) renderAgentChecks('libInstAgents', ['all']);
  }

  function fillLibForm(kind, item) {
    if (kind === 'skill') {
      $('libSkillEditId').value = item.id;
      $('libSkillName').value = item.name || '';
      $('libSkillDesc').value = item.desc || '';
      $('libSkillBody').value = item.body || '';
      $('libSkillForce').checked = !!item.forceLoad;
      renderAgentChecks('libSkillAgents', item.agents);
      $('libSkillCancelBtn').classList.remove('hidden');
    } else if (kind === 'mcp') {
      $('libMcpEditId').value = item.id;
      $('libMcpName').value = item.name || '';
      $('libMcpUrl').value = item.url || '';
      $('libMcpToken').value = item.token || '';
      renderAgentChecks('libMcpAgents', item.agents);
      $('libMcpCancelBtn').classList.remove('hidden');
    } else {
      $('libInstEditId').value = item.id;
      $('libInstName').value = item.name || '';
      $('libInstText').value = item.text || '';
      renderAgentChecks('libInstAgents', item.agents);
      $('libInstCancelBtn').classList.remove('hidden');
    }
  }

  function clearLibForm(kind) {
    if (kind === 'skill') {
      $('libSkillEditId').value = '';
      $('libSkillName').value = '';
      $('libSkillDesc').value = '';
      $('libSkillBody').value = '';
      $('libSkillForce').checked = false;
      renderAgentChecks('libSkillAgents', ['all']);
      $('libSkillCancelBtn').classList.add('hidden');
    } else if (kind === 'mcp') {
      $('libMcpEditId').value = '';
      $('libMcpName').value = '';
      $('libMcpUrl').value = '';
      $('libMcpToken').value = '';
      renderAgentChecks('libMcpAgents', ['all']);
      $('libMcpCancelBtn').classList.add('hidden');
    } else {
      $('libInstEditId').value = '';
      $('libInstName').value = '';
      $('libInstText').value = '';
      renderAgentChecks('libInstAgents', ['all']);
      $('libInstCancelBtn').classList.add('hidden');
    }
  }

  function switchLibrarySubTab(tab) {
    const panes = {
      skills: $('libPaneSkills'),
      mcp: $('libPaneMcp'),
      inst: $('libPaneInst'),
      io: $('libPaneIo')
    };
    Object.keys(panes).forEach((k) => {
      if (panes[k]) panes[k].classList.toggle('hidden', k !== tab);
    });
    document.querySelectorAll('[data-libtab]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-libtab') === tab);
    });
  }

  /* ===== Navigation ===== */
  function switchNavTab(tab) {
    const views = {
      workspace: $('tabViewWorkspace'),
      topology: $('tabViewTopology'),
      agents: $('tabViewAgents'),
      settings: $('tabViewSettings'),
      library: $('tabViewLibrary')
    };
    Object.keys(views).forEach((k) => {
      if (views[k]) views[k].classList.toggle('hidden', k !== tab);
    });
    document.querySelectorAll('.dock-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-nav') === tab);
    });

    const hdr = $('mainAppHeader');
    if (tab === 'topology') {
      if (hdr) hdr.classList.add('hidden');
      topology.setVisible(true);
    } else {
      if (topology.isImmersion()) topology.exitImmersion();
      if (hdr) hdr.classList.remove('hidden');
      topology.setVisible(false);
    }
    if (tab === 'library') renderLibrary();
  }

  /* ===== Modals ===== */
  function openAgentModal(agentId) {
    const ag = state.agents.find((a) => a.id === agentId);
    if (!ag) return;
    state.inspectedAgentId = ag.id;
    $('modalAgIcon').textContent = ag.icon;
    $('modalAgName').textContent = ag.name;
    $('modalAgRole').textContent = ag.role;
    $('modalAgOutput').textContent =
      ag.output || '该智能体当前处于待命状态，尚无输出。\n\n您可以在「工作台」启动全局任务，或直接在下方输入框向该 Agent 发送真实指令。';
    $('agentInspectorModal').classList.remove('hidden');
  }

  function closeAgentModal() {
    $('agentInspectorModal').classList.add('hidden');
  }

  function openSquadModal(opts) {
    $('squadModalTitle').textContent = opts.title || '';
    const txt = $('squadModalText');
    if (opts.text) {
      txt.textContent = opts.text;
      txt.classList.remove('hidden');
    } else {
      txt.classList.add('hidden');
    }
    const inp = $('squadModalInput');
    if (opts.input) {
      inp.classList.remove('hidden');
      inp.value = opts.value || '';
      inp.placeholder = opts.placeholder || '';
    } else {
      inp.classList.add('hidden');
    }
    $('squadModalOk').textContent = opts.okText || '确定';
    squadModalCb = opts.onOk || null;
    $('squadModal').classList.remove('hidden');
    if (opts.input) setTimeout(() => { try { inp.focus(); } catch (_) {} }, 50);
  }

  function closeSquadModal() {
    $('squadModal').classList.add('hidden');
    squadModalCb = null;
  }

  function syncApiFormFromState() {
    $('cfgBaseUrl').value = state.api.baseUrl;
    $('cfgApiKey').value = state.api.apiKey;
    $('cfgModel').value = state.api.model;
    $('cfgTemp').value = String(state.api.temperature);
    $('cfgStream').checked = state.api.stream;
    $('cfgCfAccountId').value = state.api.cfAccountId || '';
    $('cfgCfToken').value = state.api.cfToken || '';

    document.querySelectorAll('.preset-btn').forEach((btn) => {
      const p = CONST.PROVIDER_PRESETS[btn.getAttribute('data-preset')];
      const match = p && p.baseUrl === state.api.baseUrl && p.model === state.api.model;
      btn.classList.toggle('active', Boolean(match));
    });
  }

  function saveApiFromForm() {
    state.api.baseUrl = $('cfgBaseUrl').value.trim();
    state.api.apiKey = $('cfgApiKey').value.trim();
    state.api.model = $('cfgModel').value.trim();
    const parsedTemp = parseFloat($('cfgTemp').value);
    state.api.temperature = Number.isFinite(parsedTemp) ? Math.min(2, Math.max(0, parsedTemp)) : 0.3;
    state.api.stream = $('cfgStream').checked;
    state.api.cfAccountId = $('cfgCfAccountId').value.trim();
    state.api.cfToken = $('cfgCfToken').value.trim();
    store.saveApi();
    syncHeaderAndMetrics();
  }

  /* ===== Event Binding (Single-Pass, Delegated, Zero Duplicates) ===== */
  function bindEvents() {
    document.addEventListener('pointerdown', () => audio.ensureContext(), { once: true, passive: true });

    $('bottomNavBar').addEventListener('click', (e) => {
      const btn = e.target.closest('.dock-btn');
      if (!btn) return;
      audio.sfx.uiClick();
      switchNavTab(btn.getAttribute('data-nav'));
    });

    $('topConfigApiBtn').addEventListener('click', () => switchNavTab('settings'));
    $('dynamicIslandBtn').addEventListener('click', () => switchNavTab('settings'));
    $('bannerConfigBtn').addEventListener('click', () => switchNavTab('settings'));

    $('sfxToggleBtn').addEventListener('click', () => {
      audio.setEnabled(!audio.enabled);
      syncSfxBtnUI();
      if (audio.enabled) {
        audio.sfx.nodeCompleteAndCompact();
        showToast('已开启工作流实时音效');
      } else {
        showToast('已切换为静音模式');
      }
    });

    $('sampleTaskSelect').addEventListener('change', (e) => {
      if (e.target.value) {
        $('missionTextarea').value = e.target.value;
        e.target.value = '';
      }
    });

    $('runMissionBtn').addEventListener('click', () => {
      if (state.isDirectChatting) {
        showToast('正在进行单节点追问，请稍候完成后再启动全局协同');
        return;
      }
      engine.startPipeline({
        taskText: $('missionTextarea').value,
        mode: $('execModeSelect').value,
        hooks: {
          onUpdate: (ag) => {
            if (ag && ag.status === 'running' && ag.output) {
              updateStreamingAgentInPlace(ag);
            } else {
              renderPipelineCards();
              syncHeaderAndMetrics();
              if (ag && state.inspectedAgentId === ag.id && !$('agentInspectorModal').classList.contains('hidden')) {
                $('modalAgOutput').textContent = ag.output;
              }
            }
          },
          onLog: appendLog,
          onToast: showToast,
          onNeedKey: () => {
            switchNavTab('settings');
            $('cfgApiKey').focus();
          }
        }
      });
    });

    $('abortMissionBtn').addEventListener('click', () => {
      engine.abortPipeline();
      syncHeaderAndMetrics();
    });

    $('pipelineAgentCards').addEventListener('click', (e) => {
      const card = e.target.closest('[data-card-agent]');
      if (card) openAgentModal(card.getAttribute('data-card-agent'));
    });

    $('clearLogBtn').addEventListener('click', () => {
      $('busLogBox').innerHTML = '<div class="log-empty">日志已清空。等待真实 API 调用...</div>';
    });

    $('spawnSlipBurstBtn').addEventListener('click', () => {
      topology.burstSlips();
      showToast('🕷️ 已飘出新工作流字条');
    });
    $('toggleFullImmersionBtn').addEventListener('click', () => topology.toggleImmersion());

    $('squadBar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-squad-id]');
      if (!btn) return;
      audio.sfx.uiClick();
      switchSquad(btn.getAttribute('data-squad-id'));
    });

    $('agentConfigContainer').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-toggle-id]');
      if (!btn) return;
      const ag = state.agents.find((a) => a.id === btn.getAttribute('data-toggle-id'));
      if (!ag) return;
      if (ag.enabled && state.agents.filter((a) => a.enabled).length <= 1) {
        showToast('至少需保留 1 个启用的智能体');
        return;
      }
      ag.enabled = !ag.enabled;
      store.persistActiveSquad();
      refreshAfterSquadChange();
    });

    $('agentConfigContainer').addEventListener('change', (e) => {
      const area = e.target.closest('[data-prompt-id]');
      if (!area) return;
      const ag = state.agents.find((a) => a.id === area.getAttribute('data-prompt-id'));
      if (!ag) return;
      ag.systemPrompt = area.value.trim();
      store.persistActiveSquad();
      showToast(`已更新 ${ag.shortName} 的系统提示词`);
    });

    $('newSquadBtn').addEventListener('click', () => {
      if (state.isExecuting) { showToast('任务执行中，请先停止任务再新建编队'); return; }
      openSquadModal({
        title: '＋ 新建编队',
        input: true,
        value: '',
        placeholder: '编队名称（例如：猜生肖小队）',
        okText: '创建',
        onOk: (val) => {
          const name = (val || '').trim();
          if (!name) { showToast('编队名称不能为空'); return; }
          store.persistActiveSquad();
          const sq = {
            id: util.uid('sq'),
            name,
            agents: [{
              id: 'agent-1', code: 'A-01', name: '新成员-01', shortName: '成员',
              role: '待配置角色', icon: '🤖', color: '#00F0FF',
              systemPrompt: '（待配置）请把这里改成这个成员的角色、方法与输出格式。', enabled: true
            }]
          };
          state.squads.push(sq);
          store.loadSquadIntoRuntime(sq);
          store.saveSquads();
          refreshAfterSquadChange();
          showToast(`已新建编队「${name}」`);
        }
      });
    });

    $('dupSquadBtn').addEventListener('click', () => {
      if (state.isExecuting) { showToast('任务执行中，请先停止任务再复制编队'); return; }
      store.persistActiveSquad();
      const cur = state.squads.find((s) => s.id === state.activeSquadId);
      if (!cur) return;
      const copy = {
        id: util.uid('sq'),
        name: cur.name + ' 副本',
        agents: JSON.parse(JSON.stringify(cur.agents || []))
      };
      state.squads.push(copy);
      store.loadSquadIntoRuntime(copy);
      store.saveSquads();
      refreshAfterSquadChange();
      showToast(`已复制为「${copy.name}」`);
    });

    $('renameSquadBtn').addEventListener('click', () => {
      const cur = state.squads.find((s) => s.id === state.activeSquadId);
      if (!cur) return;
      openSquadModal({
        title: '重命名编队',
        input: true,
        value: cur.name,
        okText: '保存',
        onOk: (val) => {
          const name = (val || '').trim();
          if (!name || name === cur.name) return;
          cur.name = name;
          store.saveSquads();
          renderSquadBar();
          showToast(`编队已改名为「${name}」`);
        }
      });
    });

    $('delSquadBtn').addEventListener('click', () => {
      if (state.isExecuting) { showToast('任务执行中，请先停止任务再删除编队'); return; }
      if (state.squads.length <= 1) { showToast('至少保留一个编队，不能删除'); return; }
      const cur = state.squads.find((s) => s.id === state.activeSquadId);
      if (!cur) return;
      const doomedName = cur.name;
      openSquadModal({
        title: '删除编队',
        text: `确定删除当前编队「${doomedName}」？该编队的成员与提示词将一并删除，此操作不可恢复。`,
        okText: '删除',
        onOk: () => {
          state.squads = state.squads.filter((s) => s.id !== cur.id);
          store.loadSquadIntoRuntime(state.squads[0]);
          store.saveSquads();
          refreshAfterSquadChange();
          showToast(`已删除编队「${doomedName}」`);
        }
      });
    });

    $('squadModalCancel').addEventListener('click', closeSquadModal);
    $('squadModalOk').addEventListener('click', () => {
      const cb = squadModalCb;
      const v = $('squadModalInput').value;
      closeSquadModal();
      if (cb) cb(v);
    });
    $('squadModalInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !$('squadModal').classList.contains('hidden')) {
        e.preventDefault();
        $('squadModalOk').click();
      }
    });

    $('openNewAgentBtn').addEventListener('click', () => $('newAgentModal').classList.remove('hidden'));
    $('closeNewAgentModalBtn').addEventListener('click', () => $('newAgentModal').classList.add('hidden'));
    $('cancelNewAgentBtn').addEventListener('click', () => $('newAgentModal').classList.add('hidden'));
    $('newAgentForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('addAgName').value.trim();
      const role = $('addAgRole').value.trim();
      const prompt = $('addAgPrompt').value.trim();
      if (!name || !role || !prompt) return;
      const icons = ['🚀', '🧬', '🛰️', '🔮'];
      const usedNums = state.agents.map((a) => {
        const m = /(\d+)$/.exec(a.id || '');
        return m ? parseInt(m[1], 10) : 0;
      });
      const nextNum = (usedNums.length ? Math.max(...usedNums) : 0) + 1;
      state.agents.push(store.defToRuntime({
        id: 'agent-' + nextNum,
        code: 'A-' + String(nextNum).padStart(2, '0'),
        name,
        shortName: name.slice(0, 4),
        role,
        icon: icons[(nextNum - 1) % icons.length],
        color: CONST.NEON_PALETTE[(nextNum - 1) % CONST.NEON_PALETTE.length],
        systemPrompt: prompt,
        enabled: true
      }));
      store.persistActiveSquad();
      $('newAgentForm').reset();
      $('newAgentModal').classList.add('hidden');
      refreshAfterSquadChange();
      showToast(`已添加智能体：${name}`);
    });

    document.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        audio.sfx.uiClick();
        const p = CONST.PROVIDER_PRESETS[btn.getAttribute('data-preset')];
        if (!p) return;
        $('cfgBaseUrl').value = p.baseUrl;
        $('cfgModel').value = p.model;
        document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        showToast(`已切换为 ${p.name} 预设`);
      });
    });

    $('saveCfgBtn').addEventListener('click', () => {
      saveApiFromForm();
      showToast('API 配置已保存');
    });

    $('testCfgBtn').addEventListener('click', async () => {
      saveApiFromForm();
      const banner = $('testResultBanner');
      banner.className = 'test-banner info safe-wrap';
      banner.textContent = `正在向 ${state.api.baseUrl} 发送真实连通性测试...`;
      try {
        const res = await transport.requestLLM({
          systemPrompt: 'You are a concise assistant.',
          userPrompt: '请简短回复：NexusAI 真实 API 连通正常！'
        });
        banner.className = 'test-banner ok safe-wrap';
        banner.textContent = `✔ 连通成功！耗时 ${res.latencyMs}ms · 消耗 ${res.tokens} tokens\n回复：${res.content}`;
        appendLog('API_TEST', `连通性测试通过 (${res.latencyMs}ms)`, '#00FFA3');
        showToast('API 连通测试成功！');
      } catch (err) {
        banner.className = 'test-banner err safe-wrap';
        banner.textContent = `✕ 连接失败：${err.message}`;
        appendLog('API_ERR', `连通测试失败：${err.message}`, '#FF3864');
      }
    });

    document.querySelectorAll('[data-libtab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        audio.sfx.uiClick();
        switchLibrarySubTab(btn.getAttribute('data-libtab'));
      });
    });

    ['libSkillAgents', 'libMcpAgents', 'libInstAgents'].forEach(bindMutualExclusionChecks);

    $('tabViewLibrary').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-libact]');
      if (!btn) return;
      const kind = btn.getAttribute('data-kind');
      const id = btn.getAttribute('data-id');
      const col = kind === 'skill' ? state.skills : (kind === 'mcp' ? state.mcpServers : state.instructions);
      const item = col.find((x) => x.id === id);
      if (!item) return;
      const act = btn.getAttribute('data-libact');
      if (act === 'edit') {
        fillLibForm(kind, item);
      } else if (act === 'toggle') {
        item.enabled = item.enabled === false;
        store.saveLibrary();
        renderLibrary();
      } else if (act === 'del') {
        const idx = col.indexOf(item);
        if (idx >= 0) col.splice(idx, 1);
        const editInputId = kind === 'skill' ? 'libSkillEditId' : (kind === 'mcp' ? 'libMcpEditId' : 'libInstEditId');
        if ($(editInputId) && $(editInputId).value === id) clearLibForm(kind);
        store.saveLibrary();
        renderLibrary();
        showToast('已删除：' + item.name);
      }
    });

    $('libSkillSaveBtn').addEventListener('click', () => {
      const name = $('libSkillName').value.trim();
      const body = $('libSkillBody').value;
      if (!name) { showToast('技能名不能为空'); return; }
      if (!body.trim()) { showToast('技能正文不能为空'); return; }
      const editId = $('libSkillEditId').value;
      const data = {
        name,
        desc: $('libSkillDesc').value.trim(),
        body,
        agents: readAgentChecks('libSkillAgents'),
        forceLoad: $('libSkillForce').checked
      };
      const existing = editId ? state.skills.find((s) => s.id === editId) : null;
      if (existing) Object.assign(existing, data);
      else state.skills.push({ id: util.uid('sk'), enabled: true, ...data });
      store.saveLibrary();
      clearLibForm('skill');
      renderLibrary();
      showToast('技能已保存：' + name);
    });

    $('libSkillPasteBtn').addEventListener('click', () => {
      const raw = $('libSkillBody').value;
      if (!raw.trim()) { showToast('先把 SKILL.md 粘到正文框里'); return; }
      const p = util.parseSkillMarkdown(raw);
      if (p.name) $('libSkillName').value = p.name;
      if (p.desc) $('libSkillDesc').value = p.desc;
      $('libSkillBody').value = p.body;
      showToast(p.name ? '已拆出技能：' + p.name : '没读到 frontmatter，请手动填名字');
    });

    $('libSkillCancelBtn').addEventListener('click', () => clearLibForm('skill'));

    $('libSkillImportBtn').addEventListener('click', async () => {
      const url = $('libSkillImportUrl').value.trim();
      const msg = $('libSkillMsg');
      if (!url) { showToast('先填 SKILL.md 的 raw 链接'); return; }
      msg.textContent = '正在导入…';
      try {
        const n = await transport.importSkillFromUrl(url);
        msg.textContent = '已导入技能：' + n;
        renderLibrary();
      } catch (err) {
        msg.textContent = '导入失败：' + err.message;
      }
    });

    $('libRepoImportBtn').addEventListener('click', async () => {
      const url = $('libRepoUrl').value.trim();
      const msg = $('libSkillMsg');
      if (!url) { showToast('先填 GitHub 仓库地址'); return; }
      msg.textContent = '正在扫描仓库并批量导入…';
      try {
        const n = await transport.importSkillsFromRepo(url);
        msg.textContent = `已从仓库导入 ${n} 个技能`;
        renderLibrary();
      } catch (err) {
        msg.textContent = '批量导入失败：' + err.message;
      }
    });

    $('libMcpSaveBtn').addEventListener('click', () => {
      const name = $('libMcpName').value.trim();
      const url = $('libMcpUrl').value.trim();
      if (!name) { showToast('服务器名不能为空'); return; }
      if (!/^https:\/\//i.test(url)) { showToast('服务器地址必须是 https:// 开头'); return; }
      const editId = $('libMcpEditId').value;
      const data = {
        name,
        url,
        token: $('libMcpToken').value.trim(),
        agents: readAgentChecks('libMcpAgents')
      };
      const existing = editId ? state.mcpServers.find((s) => s.id === editId) : null;
      if (existing) Object.assign(existing, data);
      else state.mcpServers.push({ id: util.uid('mcp'), enabled: true, ...data });
      store.saveLibrary();
      clearLibForm('mcp');
      renderLibrary();
      showToast('MCP 服务器已保存：' + name);
    });

    $('libMcpTestBtn').addEventListener('click', async () => {
      const msg = $('libMcpMsg');
      const name = $('libMcpName').value.trim();
      const url = $('libMcpUrl').value.trim();
      if (!name || !/^https:\/\//i.test(url)) { showToast('先填好服务器名和 https 地址'); return; }
      const sv = { name, url, token: $('libMcpToken').value.trim() };
      msg.textContent = '正在连接…';
      try {
        delete state.mcpSessions[name];
        const result = await transport.mcpRequest(sv, 'tools/list', {});
        const tools = (result && result.tools) || [];
        msg.textContent = `连接成功：${tools.length} 个工具` +
          (tools.length ? `（${tools.slice(0, 5).map((t) => t.name).join('、')}${tools.length > 5 ? '…' : ''}）` : '');
      } catch (err) {
        msg.textContent = '连接失败：' + err.message;
      }
    });

    $('libMcpCancelBtn').addEventListener('click', () => clearLibForm('mcp'));

    $('libInstSaveBtn').addEventListener('click', () => {
      const name = $('libInstName').value.trim();
      const text = $('libInstText').value;
      if (!name) { showToast('指令名不能为空'); return; }
      if (!text.trim()) { showToast('指令正文不能为空'); return; }
      const editId = $('libInstEditId').value;
      const data = { name, text, agents: readAgentChecks('libInstAgents') };
      const existing = editId ? state.instructions.find((s) => s.id === editId) : null;
      if (existing) Object.assign(existing, data);
      else state.instructions.push({ id: util.uid('in'), enabled: true, ...data });
      store.saveLibrary();
      clearLibForm('inst');
      renderLibrary();
      showToast('指令已保存：' + name);
    });

    $('libInstCancelBtn').addEventListener('click', () => clearLibForm('inst'));

    $('libExportBtn').addEventListener('click', () => {
      $('libIoText').value = store.exportLibraryJson();
      showToast('已生成配置 JSON');
    });

    $('libImportBtn').addEventListener('click', () => {
      $('libIoText').focus();
    });

    $('libIoDoImportBtn').addEventListener('click', () => {
      try {
        const res = store.importLibraryJson($('libIoText').value);
        clearLibForm('skill');
        clearLibForm('mcp');
        clearLibForm('inst');
        if (res.squadUpdated) refreshAfterSquadChange();
        else renderLibrary();
        showToast('配置已导入');
      } catch (err) {
        showToast('导入失败：' + err.message);
      }
    });

    $('libIoCopyBtn').addEventListener('click', () => {
      copyText($('libIoText').value, '已复制配置 JSON');
    });

    $('closeAgModalBtn').addEventListener('click', closeAgentModal);
    $('copyAgOutBtn').addEventListener('click', () => {
      const ag = state.agents.find((a) => a.id === state.inspectedAgentId);
      if (!ag || !ag.output) { showToast('暂无可复制的产出'); return; }
      copyText(ag.output, `已复制 ${ag.shortName} 的产出内容`);
    });

    $('directChatForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const inp = $('directChatInput');
      const submitBtn = $('directChatSubmitBtn');
      const q = inp.value.trim();
      if (!q) return;
      if (!String(state.api.apiKey || '').trim()) {
        showToast('请先在「API设置」填写 API Key');
        closeAgentModal();
        switchNavTab('settings');
        return;
      }
      if (state.isExecuting) {
        showToast('全局流水线正在运行，请等待完成或停止后再单独追问');
        return;
      }
      const ag = state.agents.find((a) => a.id === state.inspectedAgentId);
      if (!ag || ag.status === 'running') return;

      inp.value = '';
      submitBtn.disabled = true;
      state.isDirectChatting = true;
      const prevOutput = ag.output || '';
      const prefix = prevOutput ? `${prevOutput}\n\n--- [追问：${q}] ---\n` : `--- [指令：${q}] ---\n`;
      ag.status = 'running';
      renderPipelineCards();
      syncHeaderAndMetrics();

      try {
        const prompt = prevOutput ? `你之前的输出如下：\n${prevOutput}\n\n现在用户的补充指令/追问是：\n${q}` : q;
        const res = await transport.requestLLM({
          systemPrompt: ag.systemPrompt,
          userPrompt: prompt,
          onStreamUpdate: (partial) => {
            ag.output = prefix + partial;
            $('modalAgOutput').textContent = ag.output;
          }
        });
        ag.status = 'done';
        ag.output = prefix + res.content;
        state.artifactStore[ag.id] = ag.output;
        ag.latencyMs += res.latencyMs;
        ag.tokens += res.tokens;
        state.cumulativeTokens += res.tokens;
        state.cumulativeLatencyMs += res.latencyMs;
        $('modalAgOutput').textContent = ag.output;
        appendLog('DIRECT_OK', `${ag.name} 完成定向回复 (${res.tokens} tok)`, ag.color);
      } catch (err) {
        ag.status = prevOutput ? 'done' : 'error';
        ag.output = prevOutput;
        $('modalAgOutput').textContent = `${prefix}\n[调用失败]：${err.message}`;
      } finally {
        state.isDirectChatting = false;
        submitBtn.disabled = false;
        renderPipelineCards();
        syncHeaderAndMetrics();
      }
    });

    $('showReportModalBtn').addEventListener('click', () => {
      $('reportModalContent').textContent = engine.buildCombinedReport($('missionTextarea').value);
      $('reportModal').classList.remove('hidden');
    });
    $('closeReportModalBtn').addEventListener('click', () => $('reportModal').classList.add('hidden'));
    $('copyReportBtn').addEventListener('click', () => {
      copyText(engine.buildCombinedReport($('missionTextarea').value), '已复制完整报告全文');
    });
    $('downloadReportBtn').addEventListener('click', () => {
      const md = engine.buildCombinedReport($('missionTextarea').value);
      downloadFile(md, `NexusAI_Report_${Date.now()}.md`, 'text/markdown;charset=utf-8');
      showToast('已触发 .md 报告下载');
    });
    $('downloadJsonReportBtn').addEventListener('click', () => {
      const jsonStr = engine.buildClawReportV1Json($('missionTextarea').value);
      downloadFile(jsonStr, `NexusAI_claw_report_v1_${Date.now()}.json`, 'application/json;charset=utf-8');
      showToast('已导出 claw.report.v1 JSON');
    });

    const modalIds = ['agentInspectorModal', 'reportModal', 'squadModal', 'newAgentModal'];
    modalIds.forEach((id) => {
      const modal = $(id);
      if (!modal) return;
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        modalIds.forEach((id) => { const m = $(id); if (m) m.classList.add('hidden'); });
      }
    });

    const resetHorizontalScroll = () => {
      if (window.scrollX !== 0) window.scrollTo(0, window.scrollY);
      if (document.documentElement.scrollLeft !== 0) document.documentElement.scrollLeft = 0;
      if (document.body.scrollLeft !== 0) document.body.scrollLeft = 0;
    };
    window.addEventListener('scroll', resetHorizontalScroll, { passive: true });
    document.addEventListener('focusout', () => setTimeout(resetHorizontalScroll, 60));
  }

  /* ===== Boot ===== */
  function init() {
    if (init._done) return;
    init._done = true;

    syncApiFormFromState();
    syncSfxBtnUI();
    renderSquadBar();
    renderAgentSettings();
    renderPipelineCards();
    renderLibrary();
    syncHeaderAndMetrics();

    const updateClock = () => {
      const el = $('iosClock');
      if (el) el.textContent = new Date().toTimeString().slice(0, 5);
    };
    updateClock();
    setInterval(updateClock, 30000);

    topology.init(openAgentModal);
    bindEvents();
    switchNavTab('topology');

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  Nexus.ui = {
    switchNavTab,
    openAgentModal,
    showToast
  };
})(window);
