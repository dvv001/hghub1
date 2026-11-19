/* ============================================================================
   Layer 5: Holographic 5-Plane Cyber-Spider Topology (Nexus.topology)
   Vibrant Sci-Fi Canvas with true rAF pause/resume, clipped text & live packets.
   ============================================================================ */
(function (global) {
  'use strict';

  const Nexus = (global.Nexus = global.Nexus || {});
  const { state, audio } = Nexus;

  const AGENT_WORKFLOW_KEYWORDS = [
    ['任务意图解析', '/plan 架构拆解', '核心模块边界', 'Claw 路由分配', 'Token 预算设定', '子智能体调度', '系统拓扑建模', '接口契约对齐'],
    ['GrepTool 检索', '技术选型对比', '延迟基准测算', '算法复杂度分析', '行业方案对标', '依赖兼容核验', '吞吐瓶颈定位', '协议开销评估'],
    ['FileEditTool 编码', '核心数据结构', '异步协程实现', 'Redis Lua 脚本', '零拷贝缓冲区', '接口异常处理', '核心模块封装', '类型安全校验'],
    ['/security 审计', '并发竞态排查', '注入漏洞扫描', '白名单沙箱加固', '高并发压测断言', '内存泄漏检测', '异常熔断兜底', '零信任权限校验'],
    ['Trident 三阶压缩', 'FNV-1a 指纹缓存', '上游摘要去噪', 'claw.report.v1', '全局蓝图整合', 'Token 省流审计', 'Markdown 导出', '最终交付签发']
  ];

  const SLOT_COORDS = [
    { rx: 0.22, ry: 0.36 },
    { rx: 0.52, ry: 0.33 },
    { rx: 0.80, ry: 0.38 },
    { rx: 0.24, ry: 0.73 },
    { rx: 0.54, ry: 0.75 },
    { rx: 0.80, ry: 0.71 }
  ];

  let canvas = null;
  let ctx = null;
  let cw = 380;
  let ch = 640;
  let tick = 0;
  let rafId = 0;
  let isActiveView = false;
  let fullImmersionMode = false;
  let agentPlanes = [];
  let onOpenAgentCallback = null;

  function extractLiveKeywords(ag, fallbackIdx) {
    const pool = [...(AGENT_WORKFLOW_KEYWORDS[fallbackIdx % AGENT_WORKFLOW_KEYWORDS.length] || AGENT_WORKFLOW_KEYWORDS[0])];
    if (ag && ag.output) {
      const cleaned = ag.output.replace(/[#*`>-]/g, ' ');
      const matches = cleaned.match(/[A-Za-z0-9_/.:-]{3,14}|[\u4e00-\u9fa5]{3,8}/g) || [];
      matches.slice(0, 10).forEach((m) => {
        if (!pool.includes(m)) pool.unshift(m);
      });
    }
    return pool;
  }

  function createSpider(color) {
    return {
      rx: 0.52,
      ry: 0.33,
      angle: 0,
      targetSlot: 1,
      currentSlot: 0,
      waitTicks: 0,
      color,
      legPhase: Math.random() * 6.28
    };
  }

  function rebuildPlanes() {
    const enabled = state.agents.filter((a) => a.enabled);
    const list = enabled.length > 0 ? enabled : state.agents.slice(0, 5);
    agentPlanes = list.map((ag, pIdx) => {
      const kwPool = extractLiveKeywords(ag, pIdx);
      const slips = SLOT_COORDS.map((slot, sIdx) => ({
        slotIdx: sIdx,
        baseRx: slot.rx,
        baseRy: slot.ry,
        rx: slot.rx,
        ry: slot.ry,
        floatOffsetY: 0,
        text: kwPool[sIdx % kwPool.length],
        stepped: sIdx < 2,
        activeNow: sIdx === 1,
        scale: sIdx === 1 ? 1.35 : (sIdx < 2 ? 1.12 : 0.95),
        targetScale: sIdx === 1 ? 1.35 : (sIdx < 2 ? 1.12 : 0.95),
        pulse: sIdx === 1 ? 1.0 : 0,
        phase: pIdx * 1.3 + sIdx * 0.9,
        box: { x: 0, y: 0, w: 72, h: 22 }
      }));
      return {
        pIdx,
        agent: ag,
        kwCursor: 6,
        rect: { x: 0, y: 0, w: 160, h: 120 },
        detailBtnRect: { x: 0, y: 0, w: 44, h: 20 },
        slips,
        webChain: [0, 1],
        spider: createSpider(ag.color || '#00F0FF')
      };
    });
    layoutPlanes();
  }

  function layoutPlanes() {
    const n = agentPlanes.length;
    if (!n) return;
    const padX = 3;
    const padY = 3;
    const gapX = 6;
    const gapY = 6;
    const isWide = cw >= 680;

    if (isWide && n === 5) {
      const topH = (ch - padY * 2 - gapY) * 0.52;
      const botH = (ch - padY * 2 - gapY) * 0.48;
      const w3 = (cw - padX * 2 - gapX * 2) / 3;
      const w2 = (cw - padX * 2 - gapX) / 2;
      for (let i = 0; i < 3; i++) {
        agentPlanes[i].rect = { x: padX + i * (w3 + gapX), y: padY, w: w3, h: topH };
      }
      for (let i = 3; i < 5; i++) {
        agentPlanes[i].rect = { x: padX + (i - 3) * (w2 + gapX), y: padY + topH + gapY, w: w2, h: botH };
      }
    } else {
      const rows = Math.ceil(n / 2);
      const cellH = (ch - padY * 2 - gapY * (rows - 1)) / rows;
      const halfW = (cw - padX * 2 - gapX) / 2;
      const fullW = cw - padX * 2;
      agentPlanes.forEach((pl, idx) => {
        const r = Math.floor(idx / 2);
        const isLastOdd = idx === n - 1 && n % 2 === 1;
        const c = idx % 2;
        pl.rect = {
          x: isLastOdd ? padX : padX + c * (halfW + gapX),
          y: padY + r * (cellH + gapY),
          w: isLastOdd ? fullW : halfW,
          h: cellH
        };
      });
    }
  }

  function resize() {
    if (!canvas || !ctx) return;
    const wrap = document.getElementById('stageCanvasWrap');
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const nextW = Math.round(rect.width * dpr);
    const nextH = Math.round(rect.height * dpr);
    if (canvas.width === nextW && canvas.height === nextH && cw === rect.width && ch === rect.height) return;
    cw = rect.width;
    ch = rect.height;
    canvas.width = nextW;
    canvas.height = nextH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layoutPlanes();
  }

  function stepOnSlip(plane, slipIdx, playAudio = false) {
    const slip = plane.slips[slipIdx];
    if (!slip) return;
    plane.slips.forEach((s, idx) => {
      if (idx === slipIdx) {
        s.stepped = true;
        s.activeNow = true;
        s.targetScale = 1.36;
        s.pulse = 1.0;
      } else {
        s.activeNow = false;
        s.targetScale = s.stepped ? 1.10 : 0.94;
      }
    });
    if (!plane.webChain.includes(slipIdx)) {
      plane.webChain.push(slipIdx);
      if (plane.webChain.length > 5) plane.webChain.shift();
    }
    if (playAudio) audio.sfx.spiderStep(true);
  }

  function floatNewKeyword(plane) {
    const kwPool = extractLiveKeywords(plane.agent, plane.pIdx);
    plane.kwCursor = (plane.kwCursor + 1) % kwPool.length;
    const nextWord = kwPool[plane.kwCursor];
    const candidateIdx = (plane.spider.targetSlot + 1 + Math.floor(Math.random() * 4)) % plane.slips.length;
    const targetSlip = plane.slips[candidateIdx];
    if (targetSlip && !targetSlip.activeNow) {
      targetSlip.text = nextWord;
      targetSlip.stepped = false;
      targetSlip.targetScale = 0.95;
      targetSlip.pulse = 0.65;
      targetSlip.floatOffsetY = 0.09;
    }
    return candidateIdx;
  }

  function drawRoundedRect(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function drawSpider(cx, cy, angle, legPhase, color, activeSlipBox, isStepping) {
    ctx.save();
    for (let side = -1; side <= 1; side += 2) {
      for (let l = 0; l < 4; l++) {
        const spread = (l - 1.5) * 0.38;
        const wave = isStepping
          ? Math.sin(legPhase * 0.3 + l) * 0.05
          : Math.sin(legPhase + l * 1.5 + (side > 0 ? Math.PI : 0)) * 0.28;
        const a = angle + side * (Math.PI * 0.48 + spread * side) + wave;
        const shX = cx + Math.cos(angle + side * Math.PI * 0.5) * 4;
        const shY = cy + Math.sin(angle + side * Math.PI * 0.5) * 4;
        let footX = cx + Math.cos(a) * (15 + (l === 0 || l === 3 ? 4 : 0));
        let footY = cy + Math.sin(a) * (15 + (l === 0 || l === 3 ? 4 : 0));

        if (isStepping && activeSlipBox) {
          const bx = activeSlipBox.x + ((l + 0.5) / 4) * activeSlipBox.w * 0.45 * side + activeSlipBox.w * 0.5;
          const by = side < 0 ? activeSlipBox.y + 1 : activeSlipBox.y + activeSlipBox.h - 1;
          footX = footX * 0.35 + bx * 0.65;
          footY = footY * 0.35 + by * 0.65;
        }

        const midX = (shX + footX) * 0.5;
        const midY = (shY + footY) * 0.5;
        const kneeX = midX + side * 4;
        const kneeY = midY - 6.5;

        ctx.strokeStyle = '#FFFFFF';
        ctx.shadowColor = color;
        ctx.shadowBlur = 7;
        ctx.lineWidth = 1.45;
        ctx.beginPath();
        ctx.moveTo(shX, shY);
        ctx.lineTo(kneeX, kneeY);
        ctx.lineTo(footX, footY);
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(kneeX, kneeY, 1.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = isStepping ? '#FFB800' : color;
        ctx.beginPath();
        ctx.arc(footX, footY, 1.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = '#0B0624';
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(-4, 0, 5.8, 4.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(3, 0, 3.0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(4.7, -1.1, 0.9, 0, Math.PI * 2);
    ctx.arc(4.7, 1.1, 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawActivePackets() {
    if (!state.activePackets.length) return;
    const centerMap = {};
    agentPlanes.forEach((pl) => {
      centerMap[pl.agent.id] = { x: pl.rect.x + pl.rect.w * 0.5, y: pl.rect.y + pl.rect.h * 0.5 };
    });

    for (let i = state.activePackets.length - 1; i >= 0; i--) {
      const pkt = state.activePackets[i];
      pkt.progress += pkt.speed;
      if (pkt.progress >= 1) {
        state.activePackets.splice(i, 1);
        continue;
      }
      const from = centerMap[pkt.fromId];
      const to = centerMap[pkt.toId];
      if (!from || !to) continue;
      const px = from.x + (to.x - from.x) * pkt.progress;
      const py = from.y + (to.y - from.y) * pkt.progress;

      ctx.save();
      ctx.strokeStyle = pkt.color;
      ctx.globalAlpha = 0.45 * (1 - Math.abs(pkt.progress - 0.5) * 1.4);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(px, py);
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.fillStyle = '#FFFFFF';
      ctx.shadowColor = pkt.color;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(px, py, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function renderFrame() {
    if (!isActiveView || document.hidden) {
      rafId = 0;
      return;
    }

    tick++;
    const enabledNow = state.agents.filter((a) => a.enabled);
    const mismatch =
      enabledNow.length !== agentPlanes.length ||
      enabledNow.some((ag, i) => !agentPlanes[i] || agentPlanes[i].agent !== ag);
    if (mismatch && enabledNow.length > 0) rebuildPlanes();

    // Cosmic void backdrop
    ctx.fillStyle = '#03020E';
    ctx.fillRect(0, 0, cw, ch);

    agentPlanes.forEach((plane, pIdx) => {
      const { x, y, w, h } = plane.rect;
      const ag = plane.agent;
      const isRunning = ag.status === 'running';
      const isDone = ag.status === 'done';
      const themeColor = ag.color || '#00F0FF';

      ctx.save();
      const bgGrad = ctx.createLinearGradient(x, y, x + w, y + h);
      bgGrad.addColorStop(0, isRunning ? `${themeColor}2A` : '#110B30');
      bgGrad.addColorStop(1, '#060418');
      ctx.fillStyle = bgGrad;
      ctx.strokeStyle = isRunning ? themeColor : `${themeColor}77`;
      ctx.lineWidth = isRunning ? 2.1 : 1.15;
      if (isRunning) {
        ctx.shadowColor = themeColor;
        ctx.shadowBlur = 12;
      }
      drawRoundedRect(x, y, w, h, 10);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Subtle holographic grid lines
      ctx.strokeStyle = `${themeColor}14`;
      ctx.lineWidth = 0.7;
      for (let gx = 1; gx < 4; gx++) {
        ctx.beginPath();
        ctx.moveTo(x + (w * gx) / 4, y + 25);
        ctx.lineTo(x + (w * gx) / 4, y + h);
        ctx.stroke();
      }
      for (let gy = 1; gy < 3; gy++) {
        ctx.beginPath();
        ctx.moveTo(x, y + 25 + ((h - 25) * gy) / 3);
        ctx.lineTo(x + w, y + 25 + ((h - 25) * gy) / 3);
        ctx.stroke();
      }

      // Plane Header Bar
      const hdrH = 25;
      ctx.fillStyle = 'rgba(9, 6, 30, 0.92)';
      ctx.fillRect(x + 1, y + 1, w - 2, hdrH);
      ctx.strokeStyle = `${themeColor}55`;
      ctx.beginPath();
      ctx.moveTo(x + 1, y + hdrH);
      ctx.lineTo(x + w - 1, y + hdrH);
      ctx.stroke();

      const btnW = 40;
      const btnH = 17;
      const btnX = x + w - btnW - 5;
      const btnY = y + (hdrH - btnH) * 0.5;
      plane.detailBtnRect = { x: btnX, y: btnY, w: btnW, h: btnH };

      // Clipped header title so long names never collide with button
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 5, y + 1, Math.max(20, btnX - x - 9), hdrH - 2);
      ctx.clip();
      ctx.font = '700 10.5px -apple-system, Inter, sans-serif';
      ctx.fillStyle = '#F4F7FF';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${ag.icon} ${ag.name}`, x + 7, y + hdrH * 0.52);
      ctx.restore();

      // Detail / Status button
      ctx.fillStyle = isRunning ? themeColor : isDone ? 'rgba(0, 255, 163, 0.18)' : 'rgba(22, 16, 56, 0.92)';
      ctx.strokeStyle = isDone ? '#00FFA3' : themeColor;
      ctx.lineWidth = 0.9;
      drawRoundedRect(btnX, btnY, btnW, btnH, 5);
      ctx.fill();
      ctx.stroke();
      ctx.font = '700 9px -apple-system, Inter, sans-serif';
      ctx.fillStyle = isRunning ? '#050314' : isDone ? '#00FFA3' : '#E2E8F0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(isRunning ? '执行中' : isDone ? '✔完成' : '详情 ›', btnX + btnW * 0.5, btnY + btnH * 0.52);
      ctx.restore();

      // Animate floating keyword slips
      plane.slips.forEach((slip) => {
        const floatX = Math.sin(tick * 0.025 + slip.phase) * 0.018;
        const floatY = Math.cos(tick * 0.022 + slip.phase * 1.3) * 0.022;
        if (slip.floatOffsetY) slip.floatOffsetY *= 0.91;
        slip.rx = slip.baseRx + floatX;
        slip.ry = slip.baseRy + floatY + (slip.floatOffsetY || 0);
        slip.scale += (slip.targetScale - slip.scale) * 0.16;
        if (slip.pulse > 0) slip.pulse = Math.max(0, slip.pulse - 0.025);
      });

      // Glowing plasma web chain
      if (plane.webChain.length > 1) {
        ctx.save();
        for (let i = 1; i < plane.webChain.length; i++) {
          const sA = plane.slips[plane.webChain[i - 1]];
          const sB = plane.slips[plane.webChain[i]];
          if (!sA || !sB) continue;
          const x1 = x + sA.rx * w;
          const y1 = y + sA.ry * h;
          const x2 = x + sB.rx * w;
          const y2 = y + sB.ry * h;
          ctx.strokeStyle = themeColor;
          ctx.globalAlpha = 0.6;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          ctx.setLineDash([3, 5]);
          ctx.lineDashOffset = -tick * 0.9;
          ctx.strokeStyle = '#FFFFFF';
          ctx.globalAlpha = 0.8;
          ctx.lineWidth = 0.85;
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      }

      // Draw keyword slips
      plane.slips.forEach((slip) => {
        const sx = x + slip.rx * w;
        const sy = y + slip.ry * h;
        const sc = slip.scale;
        const isAct = slip.activeNow;
        const isStep = slip.stepped;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(sc, sc);

        const fontSize = cw < 440 ? 9.5 : 10.5;
        ctx.font = `${isAct || isStep ? '700' : '500'} ${fontSize}px -apple-system, Inter, sans-serif`;
        const textW = ctx.measureText(slip.text).width;
        const padH = isAct ? 11 : 8;
        const bw = Math.min(w * 0.44, Math.max(50, textW + padH * 2));
        const bh = isAct ? 21 : 18;

        slip.box = {
          x: sx - (bw * sc) * 0.5,
          y: sy - (bh * sc) * 0.5,
          w: bw * sc,
          h: bh * sc
        };

        if (slip.pulse > 0.02) {
          const ringPad = (1 - slip.pulse) * 14;
          ctx.strokeStyle = themeColor;
          ctx.globalAlpha = slip.pulse * 0.85;
          ctx.lineWidth = 1.6;
          drawRoundedRect(-bw * 0.5 - ringPad, -bh * 0.5 - ringPad * 0.6, bw + ringPad * 2, bh + ringPad * 1.2, 6);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        drawRoundedRect(-bw * 0.5, -bh * 0.5, bw, bh, 6);
        if (isAct) {
          ctx.fillStyle = themeColor;
          ctx.shadowColor = themeColor;
          ctx.shadowBlur = 16;
          ctx.fill();
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else if (isStep) {
          ctx.fillStyle = `${themeColor}3A`;
          ctx.shadowColor = themeColor;
          ctx.shadowBlur = 7;
          ctx.fill();
          ctx.strokeStyle = themeColor;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(14, 10, 40, 0.86)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(130, 150, 255, 0.4)';
          ctx.lineWidth = 0.85;
          ctx.stroke();
        }

        ctx.shadowBlur = 0;
        ctx.fillStyle = isAct ? '#050314' : isStep ? '#FFFFFF' : '#A5B4D4';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(slip.text, 0, 0.5, bw - 8);
        ctx.restore();
      });

      // Spider kinematics
      const sp = plane.spider;
      const targetSlip = plane.slips[sp.targetSlot] || plane.slips[0];
      const tx = targetSlip.rx;
      const ty = targetSlip.ry - 0.055;
      const dx = tx - sp.rx;
      const dy = ty - sp.ry;
      const dist = Math.hypot(dx, dy);

      let isPerched = false;
      if (dist < 0.025) {
        isPerched = true;
        sp.rx = tx;
        sp.ry = ty;
        if (!targetSlip.activeNow) stepOnSlip(plane, sp.targetSlot, isRunning);
        sp.waitTicks++;
        const holdLimit = isRunning ? 26 : 58 + pIdx * 11;
        if (sp.waitTicks >= holdLimit) {
          sp.waitTicks = 0;
          const nextSlot = floatNewKeyword(plane);
          sp.currentSlot = sp.targetSlot;
          sp.targetSlot = nextSlot;
        }
      } else {
        const moveSpd = isRunning ? 0.022 : 0.012;
        sp.angle = Math.atan2(dy * h, dx * w);
        sp.rx += (dx / dist) * Math.min(moveSpd, dist);
        sp.ry += (dy / dist) * Math.min(moveSpd, dist);
        sp.legPhase += 0.42;
      }

      drawSpider(x + sp.rx * w, y + sp.ry * h, isPerched ? 0 : sp.angle, sp.legPhase, themeColor, targetSlip.box, isPerched);
    });

    // Render live inter-agent energy packets during pipeline execution
    drawActivePackets();

    rafId = requestAnimationFrame(renderFrame);
  }

  function startLoop() {
    if (!rafId && isActiveView && !document.hidden) {
      rafId = requestAnimationFrame(renderFrame);
    }
  }

  function stopLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function setVisible(visible) {
    isActiveView = Boolean(visible);
    if (isActiveView) {
      resize();
      startLoop();
    } else {
      stopLoop();
    }
  }

  function handleTap(clientX, clientY) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    for (const plane of agentPlanes) {
      const r = plane.rect;
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        const db = plane.detailBtnRect;
        if (px >= db.x - 6 && px <= db.x + db.w + 6 && py >= db.y - 6 && py <= db.y + db.h + 6) {
          if (onOpenAgentCallback) onOpenAgentCallback(plane.agent.id);
          return;
        }
        let bestSlipIdx = -1;
        let bestDist = Infinity;
        plane.slips.forEach((slip, sIdx) => {
          const b = slip.box;
          const d = Math.hypot(px - (b.x + b.w * 0.5), py - (b.y + b.h * 0.5));
          if (d < bestDist) {
            bestDist = d;
            bestSlipIdx = sIdx;
          }
        });
        if (bestSlipIdx >= 0) {
          audio.sfx.spiderZap();
          plane.spider.targetSlot = bestSlipIdx;
          plane.spider.waitTicks = 0;
          stepOnSlip(plane, bestSlipIdx, true);
        }
        return;
      }
    }
  }

  function burstSlips() {
    audio.sfx.parallelFork();
    agentPlanes.forEach((pl) => {
      const nextIdx = floatNewKeyword(pl);
      pl.spider.targetSlot = nextIdx;
      pl.spider.waitTicks = 0;
    });
  }

  function toggleImmersion() {
    fullImmersionMode = !fullImmersionMode;
    const topoSec = document.getElementById('tabViewTopology');
    const navBar = document.getElementById('bottomNavBar');
    const btn = document.getElementById('toggleFullImmersionBtn');
    if (topoSec) topoSec.classList.toggle('immersion', fullImmersionMode);
    if (navBar) navBar.classList.toggle('hidden', fullImmersionMode);
    if (btn) btn.textContent = fullImmersionMode ? '⛶ 退出全屏' : '⛶ 全屏';
    setTimeout(resize, 35);
    return fullImmersionMode;
  }

  function init(onOpenAgent) {
    onOpenAgentCallback = onOpenAgent;
    canvas = document.getElementById('stageCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    rebuildPlanes();

    canvas.addEventListener('click', (e) => handleTap(e.clientX, e.clientY));
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopLoop();
      else startLoop();
    });

    if (typeof ResizeObserver !== 'undefined') {
      const wrap = document.getElementById('stageCanvasWrap');
      if (wrap) new ResizeObserver(resize).observe(wrap);
    }
  }

  function isImmersion() {
    return fullImmersionMode;
  }

  function exitImmersion() {
    if (fullImmersionMode) toggleImmersion();
  }

  Nexus.topology = {
    init,
    rebuildPlanes,
    resize,
    setVisible,
    burstSlips,
    toggleImmersion,
    isImmersion,
    exitImmersion
  };
})(window);
