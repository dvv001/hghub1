/* ============================================================================
   Layer 3: Claw-Code Orchestration Engine (Nexus.engine)
   Trident Compression, Tool Adapters, Pipeline Scheduler & Report Builders.
   ============================================================================ */
(function (global) {
  'use strict';

  const Nexus = (global.Nexus = global.Nexus || {});
  const { CONST, util, state, store, transport, audio } = Nexus;
  const { LB, RB } = CONST;

  const COMPACT_PREAMBLE =
    'This session is being continued from a previous upstream stage that was compacted by Trident. The structured digest below covers earlier agent outputs.\n';
  const COMPACT_RESUME =
    'Resume directly from the upstream digest without repeating boilerplate preambles.';

  /* ===== Trident Three-Stage Context Compression ===== */
  function splitCodeSegments(text) {
    const segments = [];
    const re = /```[^\n]*\n[\s\S]*?(?:```|$)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) segments.push({ code: false, text: text.slice(last, m.index) });
      segments.push({ code: true, text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) segments.push({ code: false, text: text.slice(last) });
    return segments;
  }

  function splitEvidenceSegments(text) {
    const re = new RegExp(LB + '(?:MCP 结果|Kitesurf 抓取|技能：)[\\s\\S]*?' + LB + '/证据' + RB, 'g');
    const segs = [];
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) segs.push({ evidence: false, text: text.slice(last, m.index) });
      segs.push({ evidence: true, text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) segs.push({ evidence: false, text: text.slice(last) });
    return segs;
  }

  function compressProseLines(rawText, maxChars, maxLines = 26, maxLineChars = 170) {
    const cleaned = String(rawText || '').trim();
    if (cleaned.length <= maxChars) return { summary: cleaned, removedDuplicates: 0, omittedLines: 0 };

    const seen = new Set();
    const uniqueLines = [];
    let removedDuplicates = 0;
    for (const line of cleaned.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const normKey = trimmed.toLowerCase().replace(/\s+/g, ' ');
      if (normKey.length > 18 && seen.has(normKey)) {
        removedDuplicates++;
        continue;
      }
      if (normKey.length > 18) seen.add(normKey);
      uniqueLines.push(trimmed.length > maxLineChars ? trimmed.slice(0, maxLineChars) + '...' : trimmed);
    }

    const scored = uniqueLines.map((line, idx) => {
      let priority = 1;
      if (/^(#{1,4}\s|【|1\.|2\.|3\.|\*\s|-\s)/.test(line)) priority += 3;
      if (/(def |class |function |interface |struct |pub fn |P0|P1|漏洞|核心|架构|接口|结论)/.test(line)) priority += 4;
      if (idx < 4 || idx >= uniqueLines.length - 3) priority += 2;
      return { line, idx, priority };
    });

    scored.sort((a, b) => b.priority - a.priority || a.idx - b.idx);
    const picked = [];
    let charCount = 0;
    for (const item of scored) {
      if (picked.length >= maxLines) break;
      if (charCount + item.line.length + 1 > maxChars) continue;
      picked.push(item);
      charCount += item.line.length + 1;
    }
    picked.sort((a, b) => a.idx - b.idx);
    const finalLines = picked.map((p) => p.line);
    const omitted = Math.max(0, uniqueLines.length - finalLines.length);
    if (omitted > 0) {
      finalLines.push(`...[Trident 自动精简 ${omitted} 行次要细节，完整内容保留在节点报告]...`);
    }
    return { summary: finalLines.join('\n'), removedDuplicates, omittedLines: omitted };
  }

  function compressUpstreamOutput(rawText, maxChars, maxLines = 26, maxLineChars = 170) {
    const cleaned = String(rawText || '').replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
    const origChars = cleaned.length;

    if (cleaned.includes(LB)) {
      const evSegs = splitEvidenceSegments(cleaned);
      if (evSegs.some((s) => s.evidence)) {
        let evTotal = 0;
        let evOmitted = 0;
        const evParts = [];
        for (const s of evSegs) {
          if (s.evidence) {
            if (evTotal + s.text.length <= CONST.EVIDENCE_PASS_CAP) {
              evParts.push(s.text);
              evTotal += s.text.length;
            } else {
              const room = Math.max(0, CONST.EVIDENCE_PASS_CAP - evTotal);
              if (room > 200) {
                evParts.push(s.text.slice(0, room) + '\n...[证据过长已截断，完整版保留在该节点报告中]...');
                evTotal += room;
              }
            }
          } else {
            const sub = compressUpstreamOutput(s.text, maxChars, maxLines, maxLineChars);
            evOmitted += sub.omittedLines;
            if (sub.summary && sub.summary.trim()) evParts.push(sub.summary);
          }
        }
        const evSummary = evParts.join('\n\n');
        return {
          summary: evSummary,
          originalChars: origChars,
          compressedChars: evSummary.length,
          removedDuplicates: 0,
          omittedLines: evOmitted,
          truncated: evSummary.length < origChars
        };
      }
    }

    const segments = splitCodeSegments(cleaned);
    if (!segments.some((seg) => seg.code)) {
      if (origChars <= maxChars) {
        return { summary: cleaned, originalChars: origChars, compressedChars: origChars, removedDuplicates: 0, omittedLines: 0, truncated: false };
      }
      const p = compressProseLines(cleaned, maxChars, maxLines, maxLineChars);
      return { summary: p.summary, originalChars: origChars, compressedChars: p.summary.length, removedDuplicates: p.removedDuplicates, omittedLines: p.omittedLines, truncated: true };
    }

    let codeTotal = 0;
    let omittedLines = 0;
    let removedDuplicates = 0;
    const parts = [];
    for (const seg of segments) {
      if (seg.code) {
        if (codeTotal + seg.text.length <= CONST.CODE_PASS_CAP) {
          parts.push(seg.text);
          codeTotal += seg.text.length;
        } else {
          const lines = seg.text.split('\n');
          const headCount = Math.max(10, Math.floor(lines.length * 0.6));
          const head = lines.slice(0, headCount);
          const tail = lines.slice(-12);
          const omitted = Math.max(0, lines.length - head.length - tail.length);
          omittedLines += omitted;
          parts.push(`${head.join('\n')}\n\`\`\`\n...[代码过长，中间省略约 ${omitted} 行，完整版保留在该节点报告中]...\n\`\`\`\n${tail.join('\n')}`);
          codeTotal += seg.text.length;
        }
      } else {
        const prose = seg.text.trim();
        if (!prose) continue;
        if (prose.length <= maxChars) {
          parts.push(prose);
          continue;
        }
        const p = compressProseLines(prose, maxChars, maxLines, maxLineChars);
        omittedLines += p.omittedLines;
        removedDuplicates += p.removedDuplicates;
        parts.push(p.summary);
      }
    }
    const summary = parts.join('\n\n');
    return { summary, originalChars: origChars, compressedChars: summary.length, removedDuplicates, omittedLines, truncated: summary.length < origChars };
  }

  /* ===== Auto Routing & Sandbox Guard ===== */
  function autoRouteTask(promptText) {
    const lower = String(promptText || '').toLowerCase();
    const routes = [];
    if (/(架构|设计|系统|拆解|秒杀|全案)/.test(lower)) routes.push('/plan');
    if (/(代码|python|swift|redis|实现|脚本|函数)/.test(lower)) routes.push('FileEditTool');
    if (/(安全|审计|漏洞|压测|白名单|风险)/.test(lower)) routes.push('/security');
    if (/(调研|对比|选型|分析|量化|回测)/.test(lower)) routes.push('GrepTool');
    if (!routes.length) routes.push('AgentTool', 'QueryEngine');
    const blocked = /(rm\s+-rf\s+\/|mkfs|dd\s+if=|:(){|\/etc\/shadow)/i.test(promptText);
    return { routes, blocked };
  }

  /* ===== Context & Library Injection ===== */
  function buildLibraryContext(forAgentId) {
    let out = '';
    const insts = state.instructions.filter((i) => store.isLibAssigned(i, forAgentId));
    if (insts.length) {
      out += `\n${LB}共享指令${RB}\n${insts.map((i) => i.text).join('\n')}\n`;
    }

    const skills = state.skills.filter((s) => store.isLibAssigned(s, forAgentId));
    const forcedSkills = skills.filter((s) => s.forceLoad);
    const optionalSkills = skills.filter((s) => !s.forceLoad);

    for (const s of forcedSkills) {
      let body = s.body || '';
      if (body.length > CONST.SKILL_BODY_CAP) {
        body = body.slice(0, CONST.SKILL_BODY_CAP) + `\n...（技能正文过长，已截断至 ${CONST.SKILL_BODY_CAP} 字）`;
      }
      out += `\n${LB}必加载技能：${s.name}${RB}（本技能已由系统全文注入，无需再写加载标记；任务涉及本技能时必须严格按此规程执行）\n${body}\n`;
    }

    if (optionalSkills.length) {
      out += `\n${LB}技能库${RB}你可按需加载以下技能：需要某个技能的规程时，在产出中单独一行写 [[SKILL:技能名]]，系统会把技能全文替换到标记处；不要凭空编造技能内容。\n`;
      out += optionalSkills.map((s) => `- ${s.name}：${s.desc || ''}`).join('\n') + '\n';
    }

    const toolLines = [];
    state.mcpServers.filter((sv) => store.isLibAssigned(sv, forAgentId)).forEach((sv) => {
      (state.mcpToolIndex[sv.name] || []).forEach((t) => {
        toolLines.push(`- ${sv.name} / ${t.name}：${t.description || ''}`);
      });
    });
    if (toolLines.length) {
      out += `\n${LB}MCP 工具${RB}需要调用外部工具时，在产出中单独一行写 [[MCP:服务器名:工具名:{"参数名":值}]]，系统会执行并把结果替换到标记处。可用工具：\n${toolLines.join('\n')}\n`;
    }

    out += `\n${LB}工具使用方式${RB}你调用的工具（抓取/技能/MCP）执行后，系统会把结果交回给你，并请你结合结果给出本节点的最终版产出；最终版要真正使用结果中的数据，不要停留在等待或计划。\n`;
    return out;
  }

  function buildAutoClawContext(taskText, completedAgents, forAgentId) {
    let compacted = `${COMPACT_PREAMBLE}\n【用户原始任务】：\n${taskText}\n`;
    let lastCodeAgent = null;

    completedAgents.forEach((ag, index) => {
      const isImmediatePrev = index === completedAgents.length - 1;
      if (/```/.test(ag.output || '') && (!lastCodeAgent || ag.id === 'agent-3')) {
        lastCodeAgent = ag;
      }
      const charBudget = isImmediatePrev ? Math.max(state.api.compactMaxChars * 2, 6000) : 700;
      const comp = compressUpstreamOutput(ag.output, charBudget);
      compacted += `\n--- [上游 ${ag.name} ${isImmediatePrev ? '完整产出' : '核心摘要'}] ---\n${comp.summary}\n`;
    });

    if (forAgentId && forAgentId === state.pipelineFinalAgentId && state.evidenceStore.length) {
      let evBudget = 16000;
      compacted += `\n${LB}原始证据${RB}（工具调用与网页抓取的原文。最终结论中的每个数字必须与此处逐字一致；此处没有的数字不得写入结论）\n`;
      for (const ev of state.evidenceStore) {
        if (evBudget <= 0) break;
        const t = ev.text.length > 8000 ? ev.text.slice(0, 8000) + '\n...[单条证据过长已截断]...' : ev.text;
        if (t.length > evBudget) break;
        compacted += `--- [${ev.kind}] ${ev.label} ---\n${t}\n`;
        evBudget -= t.length;
      }
    }

    if (lastCodeAgent && forAgentId && forAgentId === state.pipelineFinalAgentId) {
      compacted += `\n【产物引用】${lastCodeAgent.name} 的代码原文已由系统存档。整合交付时用单独一行 [[ATTACH_CODE:${lastCodeAgent.id}]] 引用即可，系统会自动附上原文，禁止凭摘要重写代码。\n`;
    }

    if (state.prefetchedPages.length) {
      compacted += '\n【联网抓取 · 任务页面预抓】\n' +
        state.prefetchedPages.map((p) => `--- ${p.url} ---\n${p.text}`).join('\n') + '\n';
    }

    if (transport.kitesurfConfigured()) {
      compacted += '\n【联网抓取】如需读取某个具体网页的正文，在产出中单独一行写 [[FETCH:完整网址]]，系统会用 Kitesurf 渲染该页并把正文替换到标记处；不要凭空编造页面内容。\n';
    }

    compacted += buildLibraryContext(forAgentId);
    compacted += `\n${COMPACT_RESUME}`;
    return compacted;
  }

  /* ===== Marker Resolvers & Tool Registry ===== */
  function extractCodeBlocks(text) {
    const blocks = [];
    const re = /```[^\n]*\n[\s\S]*?```/g;
    const src = String(text || '');
    let m;
    while ((m = re.exec(src)) !== null) blocks.push(m[0]);
    return blocks;
  }

  function resolveAttachMarkers(text) {
    return String(text || '').replace(/\[\[ATTACH_CODE:(agent-\d+)\]\]/g, (whole, agentId) => {
      const stored = state.artifactStore[agentId];
      if (!stored) return whole;
      const blocks = extractCodeBlocks(stored);
      const payload = blocks.length ? blocks.join('\n\n') : stored;
      const srcAgent = state.agents.find((a) => a.id === agentId);
      const srcName = srcAgent ? srcAgent.name : agentId;
      return `\n\n---\n📎 附：最终代码（由系统按引用自动附上 ${srcName} 的原文，未经改写）\n\n${payload}\n`;
    });
  }

  async function resolveFetchMarkers(output, signal) {
    const re = /\[\[FETCH:\s*(https?:\/\/[^\]\s]+)\s*\]\]/g;
    const urls = [...new Set([...String(output || '').matchAll(re)].map((m) => m[1]))];
    if (!urls.length) return output;
    let result = String(output);
    for (const url of urls) {
      const markerRe = new RegExp('\\[\\[FETCH:\\s*' + util.escapeRegExp(url) + '\\s*\\]\\]', 'g');
      if (!transport.kitesurfConfigured()) {
        result = result.replace(markerRe, () => `（未配置 Cloudflare 凭证，未能抓取 ${url}）`);
        continue;
      }
      try {
        const page = await transport.fetchPageViaKitesurf(url, signal);
        if (page) store.recordEvidence('FETCH', url, page);
        result = result.replace(
          markerRe,
          () => page ? `\n${LB}Kitesurf 抓取 ${url}${RB}\n${page}\n${LB}/证据${RB}\n` : '（本次运行抓取次数已达上限，未抓取 ' + url + '）'
        );
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        result = result.replace(markerRe, () => `（抓取 ${url} 失败：${e.message}，已跳过）`);
      }
    }
    return result;
  }

  async function resolveSkillMarkers(output, agentId) {
    const re = /\[\[SKILL:([^\]]+)\]\]/g;
    const names = [...new Set([...String(output || '').matchAll(re)].map((m) => m[1].trim()))];
    if (!names.length) return output;
    let result = String(output);
    for (const name of names) {
      const sk = state.skills.find((s) => s.name === name);
      let replacement;
      if (!sk || sk.enabled === false) {
        replacement = `（技能库中没有已启用的技能「${name}」，已跳过）`;
      } else if (!store.isLibAssigned(sk, agentId)) {
        replacement = `（技能「${name}」未分配给当前智能体，已跳过）`;
      } else if (sk.forceLoad) {
        replacement = `（技能「${name}」已设为必加载，全文已注入你的上下文，无需重复加载）`;
      } else {
        state.libSkillLoads[agentId] = state.libSkillLoads[agentId] || 0;
        if (state.libSkillLoads[agentId] >= CONST.SKILL_PER_AGENT_LIMIT) {
          replacement = `（本次运行该智能体加载技能次数已达上限，未加载「${name}」）`;
        } else {
          state.libSkillLoads[agentId]++;
          let body = sk.body || '';
          if (body.length > CONST.SKILL_BODY_CAP) {
            body = body.slice(0, CONST.SKILL_BODY_CAP) + `\n...（技能正文过长，已截断至 ${CONST.SKILL_BODY_CAP} 字）`;
          }
          replacement = `\n${LB}技能：${sk.name}${RB}\n${body}\n${LB}/证据${RB}\n`;
        }
      }
      result = result.replace(new RegExp('\\[\\[SKILL:\\s*' + util.escapeRegExp(name) + '\\s*\\]\\]', 'g'), () => replacement);
    }
    return result;
  }

  async function resolveMcpMarkers(output, agentId, signal) {
    const re = /\[\[MCP:([\s\S]+?)\]\]/g;
    const inners = [...new Set([...String(output || '').matchAll(re)].map((m) => m[1]))];
    if (!inners.length) return output;
    let result = String(output);
    for (const inner of inners) {
      const marker = '[[MCP:' + inner + ']]';
      let replacement;
      const braceIdx = inner.indexOf('{');
      const head = (braceIdx >= 0 ? inner.slice(0, braceIdx) : inner).replace(/:$/, '');
      const argsStr = braceIdx >= 0 ? inner.slice(braceIdx) : '{}';
      const parts = head.split(':');
      const serverName = (parts[0] || '').trim();
      const toolName = (parts[1] || '').trim();
      const sv = state.mcpServers.find((s) => s.name === serverName);

      if (!sv || sv.enabled === false) {
        replacement = `（未配置已启用的 MCP 服务器「${serverName}」，已跳过）`;
      } else if (!store.isLibAssigned(sv, agentId)) {
        replacement = `（MCP 服务器「${serverName}」未分配给当前智能体，已跳过）`;
      } else if (!toolName) {
        replacement = '（MCP 标记缺少工具名，已跳过）';
      } else if (state.mcpCallCount >= CONST.MCP_RUN_CALL_LIMIT) {
        replacement = '（本次运行 MCP 调用次数已达上限，已跳过）';
      } else {
        state.mcpCallCount++;
        try {
          let args = {};
          try { args = JSON.parse(argsStr); } catch (_) { throw new Error('参数 JSON 解析失败'); }
          const r = await transport.mcpRequest(sv, 'tools/call', { name: toolName, arguments: args }, signal);
          let text = '';
          if (r && Array.isArray(r.content)) text = r.content.map((c) => (c && c.text) || '').join('\n');
          else text = JSON.stringify(r);
          if (text.length > CONST.MCP_RESULT_CAP) {
            text = text.slice(0, CONST.MCP_RESULT_CAP) + `\n...（结果过长，已截断至 ${CONST.MCP_RESULT_CAP} 字）`;
          }
          store.recordEvidence('MCP', `${serverName} / ${toolName}`, text);
          replacement = `\n${LB}MCP 结果 ${serverName} / ${toolName}${RB}\n${text}\n${LB}/证据${RB}\n`;
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          replacement = `（MCP 调用 ${serverName} / ${toolName} 失败：${e.message}，已跳过）`;
        }
      }
      result = result.split(marker).join(replacement);
    }
    return result;
  }

  const toolAdapters = [
    { id: 'fetch', test: (t) => /\[\[FETCH:[^\]]+\]\]/.test(t), resolve: (t, _agId, sig) => resolveFetchMarkers(t, sig) },
    { id: 'skill', test: (t) => /\[\[SKILL:[^\]]+\]\]/.test(t), resolve: (t, agId) => resolveSkillMarkers(t, agId) },
    { id: 'mcp', test: (t) => t.includes('[[MCP:'), resolve: (t, agId, sig) => resolveMcpMarkers(t, agId, sig) }
  ];

  async function runToolResolvers(text, agentId, signal) {
    let out = String(text || '');
    let used = false;
    for (const ad of toolAdapters) {
      if (ad.test(out)) {
        used = true;
        out = await ad.resolve(out, agentId, signal);
      }
    }
    return { text: out, used };
  }

  function stripToolMarkers(text) {
    return String(text || '')
      .replace(/\[\[FETCH:[^\]]+\]\]/g, '（最终交付节点不执行抓取）')
      .replace(/\[\[SKILL:[^\]]+\]\]/g, '（最终交付节点不加载技能）')
      .replace(/\[\[MCP:[\s\S]+?\]\]/g, '（最终交付节点不调用工具）');
  }

  /* ===== Pipeline Execution ===== */
  async function executeSingleAgentNode(ag, hubId, promptForAgent, hooks) {
    const { onUpdate, onLog, onToast } = hooks;
    const signal = state.abortCtrl ? state.abortCtrl.signal : undefined;

    ag.status = 'running';
    const agIdx = Math.max(0, state.agents.findIndex((x) => x.id === ag.id));
    audio.sfx.agentStart(agIdx);
    onUpdate(ag);
    store.spawnPacket(hubId, ag.id, ag.color);
    onLog('CLAW_CALL', `${ag.name} 正在请求 ${state.api.model}...`, ag.color);

    const pktTimer = setInterval(() => {
      if (ag.status === 'running') store.spawnPacket(hubId, ag.id, ag.color);
    }, 850);

    try {
      let res;
      const handleStream = (partial) => {
        ag.output = partial;
        onUpdate(ag);
      };

      try {
        res = await transport.requestLLM({ systemPrompt: ag.systemPrompt, userPrompt: promptForAgent, signal, onStreamUpdate: handleStream });
      } catch (firstErr) {
        if (firstErr && firstErr.name === 'AbortError') throw firstErr;
        audio.sfx.autoHealRetry();
        onLog('AUTO_HEAL', `触发 Claw 自动恢复配方：正在重试 ${ag.shortName}...`, '#FFB800');
        res = await transport.requestLLM({ systemPrompt: ag.systemPrompt, userPrompt: promptForAgent, signal, onStreamUpdate: handleStream });
      }

      ag.output = res.content;
      state.artifactStore[ag.id] = res.content;
      ag.output = (ag.id === state.pipelineFinalAgentId)
        ? resolveAttachMarkers(ag.output)
        : ag.output.replace(/\[\[ATTACH_CODE:agent-\d+\]\]/g, '(代码原文见原节点报告)');

      let extraTokens = 0;
      let extraLatency = 0;

      if (ag.id !== state.pipelineFinalAgentId) {
        let toolPass = await runToolResolvers(ag.output, ag.id, signal);
        ag.output = toolPass.text;
        let toolRound = 0;
        while (toolPass.used && toolRound < CONST.TOOL_LOOP_MAX_ROUNDS && ag.id !== 'agent-1') {
          toolRound++;
          onLog('TOOL_LOOP', `${ag.name} 已收到工具结果，结合结果继续产出（第 ${toolRound} 轮）`, ag.color);
          const prevToolOutput = ag.output;
          try {
            const contPrompt =
              `【工具结果已返回】你上一版产出中调用的工具已经执行完毕，结果已替换到对应标记处。带结果的完整产出如下：\n\n${ag.output}\n\n请基于这些真实结果，给出你本节点的最终版产出：完整替换上一版，真正使用结果中的数据与出处，不要再写等待结果、即将检索之类的话。如确有必要可以再调用工具，但不要重复调用同一个工具或同一个网址。`;
            const contRes = await transport.requestLLM({
              systemPrompt: ag.systemPrompt,
              userPrompt: contPrompt,
              signal,
              onStreamUpdate: handleStream
            });
            extraTokens += contRes.tokens;
            extraLatency += contRes.latencyMs;
            ag.output = contRes.content;
            state.artifactStore[ag.id] = contRes.content;
            ag.output = ag.output.replace(/\[\[ATTACH_CODE:agent-\d+\]\]/g, '(代码原文见原节点报告)');
            toolPass = await runToolResolvers(ag.output, ag.id, signal);
            ag.output = toolPass.text;
          } catch (loopErr) {
            if (loopErr && loopErr.name === 'AbortError') throw loopErr;
            ag.output = prevToolOutput;
            onLog('TOOL_LOOP', `${ag.name} 工具循环续写失败，保留上一版产出：${loopErr.message}`, '#FFB800');
            break;
          }
        }
      } else {
        ag.output = stripToolMarkers(ag.output);
      }

      clearInterval(pktTimer);
      ag.status = 'done';
      ag.latencyMs = res.latencyMs + extraLatency;
      ag.tokens = res.tokens + extraTokens;
      ag.cachedHit = Boolean(res.cachedHit);
      state.cumulativeTokens += ag.tokens;
      state.cumulativeLatencyMs += ag.latencyMs;

      if (ag.output) {
        const comp = compressUpstreamOutput(ag.output, state.api.compactMaxChars);
        state.tridentStats.originalChars += comp.originalChars;
        state.tridentStats.compressedChars += comp.compressedChars;
        state.tridentStats.tokensSavedEstimate += Math.round(Math.max(0, comp.originalChars - comp.compressedChars) / 3);
      }

      audio.sfx.nodeCompleteAndCompact();
      store.spawnPacket(ag.id, hubId, '#00FFA3');
      onLog(res.cachedHit ? 'FNV_HIT' : 'DONE', `${ag.name} 完成 (${(ag.latencyMs / 1000).toFixed(1)}s · ${ag.tokens} tok)`, '#00FFA3');
      onUpdate(ag);
      return true;
    } catch (err) {
      clearInterval(pktTimer);
      if (err && err.name === 'AbortError') {
        ag.status = 'idle';
        audio.sfx.errorOrAbort();
        onLog('ABORT', `已手动中止 ${ag.name}`, '#FFB800');
      } else {
        ag.status = 'error';
        ag.output = `【API 调用失败】：${err.message}`;
        audio.sfx.errorOrAbort();
        onLog('ERROR', `${ag.name} 报错：${err.message}`, '#FF3864');
        if (onToast) onToast(`调用失败：${err.message}`);
      }
      onUpdate(ag);
      return false;
    }
  }

  async function startPipeline({ taskText, mode, hooks }) {
    if (state.isExecuting) return;
    const { onUpdate, onLog, onToast, onNeedKey } = hooks;
    const cleanTask = String(taskText || '').trim();
    if (!cleanTask) {
      onToast('请先输入要执行的真实任务内容');
      return;
    }

    const { routes, blocked } = autoRouteTask(cleanTask);
    if (blocked) {
      audio.sfx.errorOrAbort();
      onLog('SANDBOX', 'Claw 安全沙箱已自动拦截高危系统指令', '#FF3864');
      onToast('安全沙箱拦截：检测到破坏性指令');
      return;
    }

    if (!String(state.api.apiKey || '').trim()) {
      onToast('请先在「API设置」中填写 API Key');
      if (onNeedKey) onNeedKey();
      return;
    }

    let runList = state.agents.filter((a) => a.enabled);
    if (!runList.length) {
      onToast('请至少启用 1 个智能体节点');
      return;
    }
    if (mode === 'fast' && runList.length > 3) {
      runList = runList.slice(0, 3);
    }

    // Lock execution BEFORE any async prefetch so double-clicks cannot spawn duplicate runs
    state.isExecuting = true;
    state.abortCtrl = new AbortController();
    const signal = state.abortCtrl.signal;

    state.agents.forEach((a) => {
      a.status = 'idle';
      a.output = '';
      a.latencyMs = 0;
      a.tokens = 0;
      a.cachedHit = false;
    });
    state.tridentStats.tokensSavedEstimate = 0;
    state.tridentStats.originalChars = 0;
    state.tridentStats.compressedChars = 0;
    state.artifactStore = {};
    state.prefetchedPages = [];
    state.kitesurfCache = {};
    state.kitesurfFetchCount = 0;
    state.activePackets = [];
    onUpdate(null);

    let allOk = false;
    try {
      await transport.prefetchMcpTools(onLog, signal);

      if (transport.kitesurfConfigured()) {
        const taskUrls = util.extractUrls(cleanTask).slice(0, 3);
        for (const u of taskUrls) {
          if (signal.aborted) break;
          try {
            const page = await transport.fetchPageViaKitesurf(u, signal);
            if (page) {
              state.prefetchedPages.push({ url: u, text: page });
              store.recordEvidence('FETCH', u, page);
              onLog('KITESURF', `已抓取任务页面：${u}（${page.length} 字）`, '#00F0FF');
            }
          } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            onLog('KITESURF', `抓取 ${u} 失败：${e.message}（已跳过，不影响运行）`, '#FFB800');
          }
        }
      } else if (util.extractUrls(cleanTask).length) {
        onLog('KITESURF', '任务含网址但未配置 Cloudflare 凭证，智能体将看不到页面内容（可在 API设置 中填入）', '#FFB800');
      }

      if (!state.isExecuting || signal.aborted) return;

      audio.sfx.missionLaunch();
      onLog('CLAW_AUTO', `已挂载 [${routes.join(' + ')}] 路由与 Trident 省Token引擎 v3`, '#00F0FF');

      const hubId = runList[0].id;
      state.pipelineFinalAgentId = runList[runList.length - 1].id;
      const completedAgents = [];

      if (mode === 'parallel_fork' && runList.length >= 3) {
        const coordPrompt = `请针对以下用户任务，输出清晰的全局拆解方案与各子模块分工：\n\n${cleanTask}` + buildLibraryContext(runList[0].id);
        const ok0 = await executeSingleAgentNode(runList[0], hubId, coordPrompt, hooks);
        if (ok0 && state.isExecuting) {
          completedAgents.push(runList[0]);
          const middleAgents = runList.slice(1, runList.length - 1);
          const finalAgent = runList[runList.length - 1];
          audio.sfx.parallelFork();
          onLog('FORK', `自动并发调度子智能体：${middleAgents.map((a) => a.shortName).join(' + ')}`, '#9D4EDD');

          await Promise.all(
            middleAgents.map((ag) => {
              // Fix v19 bug: build per-agent context so each middle agent gets its own assigned skills/MCP/instructions
              const agentCtx = buildAutoClawContext(cleanTask, completedAgents, ag.id);
              const p = `以下是用户原始任务及总控拆解方案，请以你的专业身份（${ag.name} - ${ag.role}）并行输出核心交付成果：\n\n${agentCtx}`;
              return executeSingleAgentNode(ag, hubId, p, hooks).then((ok) => {
                if (ok) completedAgents.push(ag);
              });
            })
          );

          completedAgents.sort((a, b) => runList.indexOf(a) - runList.indexOf(b));
          if (state.isExecuting && finalAgent) {
            const finalContext = buildAutoClawContext(cleanTask, completedAgents, finalAgent.id);
            const finalPrompt = `以下是用户原始任务及各并行智能体已完成的产出，请以你的专业身份（${finalAgent.name}）整合为完整的最终落地蓝图：\n\n${finalContext}`;
            const okFinal = await executeSingleAgentNode(finalAgent, hubId, finalPrompt, hooks);
            if (okFinal) {
              completedAgents.push(finalAgent);
              allOk = true;
            }
          }
        }
      } else {
        let chainOk = true;
        for (let i = 0; i < runList.length; i++) {
          if (!state.isExecuting) { chainOk = false; break; }
          const ag = runList[i];
          const promptForAgent = i === 0
            ? `请针对以下用户任务，输出清晰的全局拆解方案与核心技术路线：\n\n${cleanTask}` + buildLibraryContext(ag.id)
            : `以下是用户原始任务及上游智能体核心产出（已由 Claw-Code Trident 引擎自动压缩去噪），请以你的专业身份（${ag.name} - ${ag.role}）继续推进并输出核心交付成果：\n\n${buildAutoClawContext(cleanTask, completedAgents, ag.id)}`;
          const ok = await executeSingleAgentNode(ag, hubId, promptForAgent, hooks);
          if (!ok) { chainOk = false; break; }
          completedAgents.push(ag);
        }
        allOk = chainOk && completedAgents.length > 0;
      }

      if (allOk && state.isExecuting) {
        audio.sfx.pipelineSuccess();
      }
    } finally {
      state.isExecuting = false;
      state.abortCtrl = null;
      onUpdate(null);
    }
  }

  function abortPipeline() {
    if (state.abortCtrl) state.abortCtrl.abort();
    state.isExecuting = false;
  }

  /* ===== Report Builders ===== */
  function buildCombinedReport(missionTitle) {
    const title = String(missionTitle || '').trim() || '多智能体协同任务';
    const chunks = [
      `# NexusAI 多智能体真实交付报告\n\n` +
      `**任务**：${title}\n` +
      `**模型**：${state.api.model}\n` +
      `**总计消耗**：${state.cumulativeTokens} Tokens (Claw-Code 自动省流 ~${state.tridentStats.tokensSavedEstimate} Tokens)\n`
    ];
    state.agents.forEach((ag) => {
      if (ag.output) chunks.push(`## ${ag.icon} ${ag.name} (${ag.role})\n\n${ag.output}\n`);
    });
    if (chunks.length === 1) return '暂无产出记录。请先配置 API Key 并在工作台启动真实任务。';
    return chunks.join('\n---\n\n');
  }

  function buildClawReportV1Json(missionTitle) {
    const title = String(missionTitle || '').trim() || '多智能体协同任务';
    return JSON.stringify({
      schema: 'claw.report.v1',
      generated_at: new Date().toISOString(),
      objective: title,
      model: state.api.model,
      usage: {
        total_tokens: state.cumulativeTokens,
        saved_tokens: state.tridentStats.tokensSavedEstimate,
        latency_ms: state.cumulativeLatencyMs
      },
      claims: state.agents.filter((a) => a.output).map((ag, idx) => ({
        id: `claim-${idx + 1}`,
        agent: ag.name,
        role: ag.role,
        tokens: ag.tokens,
        fingerprint: util.fnv1a(ag.output),
        text: ag.output
      }))
    }, null, 2);
  }

  Nexus.engine = {
    compressUpstreamOutput,
    autoRouteTask,
    buildLibraryContext,
    buildAutoClawContext,
    resolveAttachMarkers,
    resolveFetchMarkers,
    resolveSkillMarkers,
    resolveMcpMarkers,
    stripToolMarkers,
    startPipeline,
    abortPipeline,
    buildCombinedReport,
    buildClawReportV1Json
  };
})(window);
