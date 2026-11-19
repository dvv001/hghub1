/* ============================================================================
   Layer 2: Transport & Protocol Adapters (Nexus.transport)
   Handles OpenAI-compat, Anthropic native, Reasoning models, Kitesurf, MCP, GitHub.
   ============================================================================ */
(function (global) {
  'use strict';

  const Nexus = (global.Nexus = global.Nexus || {});
  const { CONST, util, state, store } = Nexus;

  function getCanonicalModelName(model) {
    const lowered = String(model || '').toLowerCase().trim();
    const parts = lowered.split('/');
    return parts[parts.length - 1] || lowered;
  }

  function isReasoningModel(model) {
    const c = getCanonicalModelName(model);
    return (
      c === 'o1' || c.startsWith('o1-') ||
      c === 'o3' || c.startsWith('o3-') ||
      c === 'o4' || c.startsWith('o4-') ||
      c === 'grok-3-mini' || c.startsWith('qwq-') || c.startsWith('qwen-qwq-') ||
      (c.startsWith('qwen3-') && c.includes('-thinking')) ||
      c.includes('deepseek-reasoner') || c.includes('deepseek-r1')
    );
  }

  function usesMaxCompletionTokens(model) {
    const c = getCanonicalModelName(model);
    return (
      c.startsWith('gpt-5') ||
      c === 'o1' || c.startsWith('o1-') ||
      c === 'o3' || c.startsWith('o3-') ||
      c === 'o4' || c.startsWith('o4-')
    );
  }

  function isAnthropicNativeEndpoint(url) {
    return String(url || '').toLowerCase().includes('/v1/messages');
  }

  function resolveTemperature() {
    const n = Number(state.api.temperature);
    return Number.isFinite(n) ? Math.min(2, Math.max(0, n)) : 0.3;
  }

  function wrapWithReasoning(reasoning, answer) {
    return reasoning ? `<analysis>\n${reasoning}\n</analysis>\n\n${answer}` : answer;
  }

  /* ===== Unified LLM Request ===== */
  async function requestLLM({ systemPrompt, userPrompt, onStreamUpdate, signal }) {
    const endpoint = String(state.api.baseUrl || '').trim();
    const key = String(state.api.apiKey || '').trim();
    const model = String(state.api.model || '').trim();

    if (!key) throw new Error('未填写 API Key，请先在「API设置」中配置密钥');
    if (!endpoint) throw new Error('未填写接口地址 (Endpoint URL)');

    const finalUserPrompt =
      `${userPrompt}\n\n<system-reminder>\n请严格遵守当前角色职责，直接输出专业、完整、可落地的架构、代码或审计结论，禁止使用空洞套话。\n</system-reminder>`;

    const cacheKey = util.fnv1a(`${model}|${systemPrompt}|${finalUserPrompt}`);
    if (state.promptCache.has(cacheKey)) {
      const hit = state.promptCache.get(cacheKey);
      if (Date.now() - hit.ts < CONST.PROMPT_CACHE_TTL_MS) {
        if (onStreamUpdate) onStreamUpdate(hit.content);
        return { content: hit.content, latencyMs: 10, tokens: hit.tokens, cachedHit: true };
      }
      state.promptCache.delete(cacheKey);
    }

    const startTime = performance.now();
    const useStream = Boolean(state.api.stream && onStreamUpdate);
    const isAnthropic = isAnthropicNativeEndpoint(endpoint);
    const headers = { 'Content-Type': 'application/json' };
    let bodyPayload;

    if (isAnthropic) {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      bodyPayload = {
        model,
        max_tokens: 4096,
        system: systemPrompt,
        stream: useStream,
        messages: [{ role: 'user', content: finalUserPrompt }]
      };
      if (!isReasoningModel(model)) bodyPayload.temperature = resolveTemperature();
    } else {
      headers['Authorization'] = `Bearer ${key}`;
      bodyPayload = {
        model,
        stream: useStream,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: finalUserPrompt }
        ]
      };
      if (!isReasoningModel(model)) bodyPayload.temperature = resolveTemperature();
      if (usesMaxCompletionTokens(model)) bodyPayload.max_completion_tokens = 4096;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      signal
    });

    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      try {
        const errData = await response.json();
        errMsg = errData?.error?.message || JSON.stringify(errData);
      } catch (_) {
        try { errMsg = (await response.text()) || errMsg; } catch (__) {}
      }
      throw new Error(errMsg);
    }

    if (useStream && response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let answerContent = '';
      let reasoningContent = '';
      let fullContent = '';
      let streamTokens = 0;
      let anthropicInTok = 0;
      let anthropicOutTok = 0;
      let streamError = '';
      let buffer = '';

      const processLine = (raw) => {
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload);
          if (parsed?.error?.message) {
            streamError = parsed.error.message;
            return;
          }
          if (parsed?.usage?.total_tokens) streamTokens = parsed.usage.total_tokens;
          if (parsed?.message?.usage?.input_tokens) anthropicInTok = parsed.message.usage.input_tokens;
          if (parsed?.usage?.output_tokens) anthropicOutTok = parsed.usage.output_tokens;

          const cDelta = parsed?.choices?.[0]?.delta?.content || parsed?.delta?.text || '';
          const rDelta = parsed?.choices?.[0]?.delta?.reasoning_content || parsed?.delta?.thinking || '';
          if (cDelta || rDelta) {
            if (cDelta) answerContent += cDelta;
            if (rDelta) reasoningContent += rDelta;
            fullContent = wrapWithReasoning(reasoningContent, answerContent);
            Nexus.audio.sfx.streamTick();
            onStreamUpdate(fullContent);
          }
        } catch (_) {}
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) buffer.split('\n').forEach(processLine);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const raw of lines) processLine(raw);
      }

      if (!fullContent && streamError) throw new Error(streamError);
      const elapsed = Math.round(performance.now() - startTime);
      const totalTokens =
        streamTokens ||
        (anthropicInTok + anthropicOutTok) ||
        Math.max(1, Math.ceil((systemPrompt.length + finalUserPrompt.length + fullContent.length) / 3));

      if (fullContent) {
        state.promptCache.set(cacheKey, { content: fullContent, tokens: totalTokens, ts: Date.now() });
      }
      return { content: fullContent, latencyMs: elapsed, tokens: totalTokens, cachedHit: false };
    }

    // Non-streaming path (supports OpenAI reasoning_content & Anthropic multi-block content)
    const data = await response.json();
    let answer = '';
    let reasoning = '';

    if (data?.choices?.[0]?.message) {
      answer = data.choices[0].message.content || '';
      reasoning = data.choices[0].message.reasoning_content || '';
    } else if (Array.isArray(data?.content)) {
      for (const blk of data.content) {
        if (!blk) continue;
        if (blk.type === 'thinking' && blk.thinking) reasoning += blk.thinking;
        else if (blk.text) answer += blk.text;
      }
    }

    const content = wrapWithReasoning(reasoning, answer);
    if (onStreamUpdate) onStreamUpdate(content);
    const elapsed = Math.round(performance.now() - startTime);
    const tokens =
      data?.usage?.total_tokens ||
      ((data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0)) ||
      Math.max(1, Math.ceil((systemPrompt.length + finalUserPrompt.length + content.length) / 3));

    if (content) {
      state.promptCache.set(cacheKey, { content, tokens, ts: Date.now() });
    }
    return { content, latencyMs: elapsed, tokens, cachedHit: false };
  }

  /* ===== Kitesurf Web Browse Relay ===== */
  function kitesurfConfigured() {
    return Boolean((state.api.cfAccountId || '').trim() && (state.api.cfToken || '').trim());
  }

  async function fetchPageViaKitesurf(url, signal) {
    const cached = state.kitesurfCache[url];
    if (cached) {
      if (cached.error) throw new Error(cached.error);
      return cached.text;
    }
    if (state.kitesurfFetchCount >= CONST.KITESURF_RUN_FETCH_LIMIT) return null;
    state.kitesurfFetchCount++;
    try {
      const resp = await fetch(CONST.BROWSE_RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: state.api.cfAccountId.trim(),
          token: state.api.cfToken.trim(),
          url
        }),
        signal
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data || data.success === false) {
        const msg = (data && data.errors && data.errors[0] && data.errors[0].message) || ('HTTP ' + resp.status);
        throw new Error(msg);
      }
      let text = '';
      const r = data.result;
      if (typeof r === 'string') text = r;
      else if (r && typeof r === 'object') text = r.markdown || r.content || r.html || '';
      const cleanedText = util.cleanNavMarkdown(text);
      if (cleanedText.trim().length >= 800 || cleanedText.length >= text.length * 0.25) text = cleanedText;
      if (text.length > CONST.KITESURF_PAGE_CAP) {
        text = text.slice(0, CONST.KITESURF_PAGE_CAP) + `\n...（正文过长，已截断至 ${CONST.KITESURF_PAGE_CAP} 字）`;
      }
      state.kitesurfCache[url] = { text };
      return text;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      state.kitesurfCache[url] = { error: e.message };
      throw e;
    }
  }

  /* ===== MCP Streamable HTTP Relay ===== */
  function mcpParseBody(text, contentType) {
    const t = String(text || '');
    if ((contentType || '').includes('text/event-stream') || /^data:/m.test(t)) {
      let last = null;
      t.split(/\r?\n/).forEach((line) => {
        if (line.startsWith('data:')) {
          try { last = JSON.parse(line.slice(5).trim()); } catch (_) {}
        }
      });
      return last;
    }
    try { return JSON.parse(t); } catch (_) { return null; }
  }

  async function mcpRelayCall(server, rpcPayload, sessionId, signal) {
    const headers = {};
    if (server.token) headers['Authorization'] = 'Bearer ' + server.token;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const resp = await fetch(CONST.MCP_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: server.url, headers, body: rpcPayload }),
      signal
    });
    const data = await resp.json().catch(() => null);
    if (!data) throw new Error(`MCP 中转无响应（HTTP ${resp.status}），请确认已部署含 /mcp 的 Worker`);
    if (data.error) throw new Error(data.error);
    return data;
  }

  async function mcpInitSession(server, signal) {
    state.mcpSessions[server.name] = null;
    try {
      const init = await mcpRelayCall(
        server,
        {
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'NexusAI', version: '20' } }
        },
        null,
        signal
      );
      if (init.sessionId) state.mcpSessions[server.name] = init.sessionId;
      try {
        await mcpRelayCall(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, state.mcpSessions[server.name], signal);
      } catch (_) {}
    } catch (_) {}
  }

  async function mcpRequest(server, method, params, signal, allowRetry = true) {
    if (!(server.name in state.mcpSessions)) {
      await mcpInitSession(server, signal);
    }
    const rpc = {
      jsonrpc: '2.0',
      id: 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      method,
      params: params || {}
    };
    const data = await mcpRelayCall(server, rpc, state.mcpSessions[server.name], signal);
    if (data.status === 404 && data.sessionId === '') {
      delete state.mcpSessions[server.name];
      if (allowRetry) return mcpRequest(server, method, params, signal, false);
    }
    const msg = mcpParseBody(data.body, data.contentType);
    if (!msg) throw new Error(`MCP 服务器返回无法解析（HTTP ${data.status}）`);
    if (msg.error) throw new Error('MCP 错误：' + (msg.error.message || JSON.stringify(msg.error)));
    return msg.result;
  }

  async function prefetchMcpTools(onLog, signal) {
    state.mcpToolIndex = {};
    state.mcpSessions = {};
    state.evidenceStore = [];
    state.mcpCallCount = 0;
    state.libSkillLoads = {};

    const active = state.mcpServers.filter((sv) => sv.enabled !== false);
    for (const sv of active) {
      if (signal && signal.aborted) break;
      try {
        const result = await mcpRequest(sv, 'tools/list', {}, signal);
        const tools = (result && result.tools) || [];
        state.mcpToolIndex[sv.name] = tools.map((t) => ({
          name: t.name,
          description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 120)
        }));
        if (onLog) onLog('MCP', `服务器「${sv.name}」已连接，${tools.length} 个工具可用`, '#00F0FF');
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        state.mcpToolIndex[sv.name] = [];
        if (onLog) onLog('MCP', `服务器「${sv.name}」连接失败：${e.message}（已跳过，不影响运行）`, '#FFB800');
      }
    }
  }

  /* ===== GitHub SKILL.md Importers ===== */
  async function importSkillFromUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const md = await resp.text();
    const parsed = util.parseSkillMarkdown(md);
    if (!parsed.name) {
      const seg = String(url).split('/').filter(Boolean);
      parsed.name = seg.length >= 2 ? seg[seg.length - 2] : 'imported-skill';
    }
    if (!parsed.body) throw new Error('文件内容为空');
    store.upsertSkill(parsed);
    return parsed.name;
  }

  async function importSkillsFromRepo(repoUrl) {
    const m = String(repoUrl || '').match(/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^/\s]+)(?:\/([^\s#?]*))?)?/);
    if (!m) throw new Error('无法识别 GitHub 仓库地址');
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '');
    let branch = m[3] || '';
    const sub = (m[4] || '').replace(/\/$/, '');

    if (!branch) {
      const infoResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
      if (!infoResp.ok) throw new Error('仓库读取失败 HTTP ' + infoResp.status);
      const info = await infoResp.json();
      branch = info.default_branch || 'main';
    }
    const treeResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (!treeResp.ok) throw new Error('仓库文件树读取失败 HTTP ' + treeResp.status);
    const tj = await treeResp.json();
    const paths = (tj.tree || [])
      .filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path) && (!sub || t.path.startsWith(sub)))
      .map((t) => t.path);

    if (!paths.length) throw new Error('仓库里没找到 SKILL.md');
    let ok = 0;
    for (const p of paths) {
      try {
        await importSkillFromUrl(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`);
        ok++;
      } catch (_) {}
    }
    if (!ok) throw new Error(`找到 ${paths.length} 个 SKILL.md，但全部导入失败`);
    return ok;
  }

  Nexus.transport = {
    isReasoningModel,
    usesMaxCompletionTokens,
    isAnthropicNativeEndpoint,
    requestLLM,
    kitesurfConfigured,
    fetchPageViaKitesurf,
    mcpRequest,
    prefetchMcpTools,
    importSkillFromUrl,
    importSkillsFromRepo
  };
})(window);
