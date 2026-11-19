/* ============================================================================
   Layer 1: State, Constants, Utilities & Persistence (Nexus.store)
   100% backward-compatible with v19 localStorage keys.
   ============================================================================ */
(function (global) {
  'use strict';

  const Nexus = (global.Nexus = global.Nexus || {});

  const KEYS = {
    API_CFG: 'nexusai_ios_real_cfg',
    SQUADS: 'nexusai_squads',
    ACTIVE_SQUAD: 'nexusai_active_squad',
    SKILLS: 'nexusai_skills',
    MCP: 'nexusai_mcp_servers',
    INSTRUCTIONS: 'nexusai_instructions',
    SFX: 'nexusai_sfx_enabled'
  };

  const CONST = {
    KEYS,
    LB: '\u3010',
    RB: '\u3011',
    BROWSE_RELAY_URL: 'https://hghub-proxy.liguohao770801114.workers.dev/browse',
    MCP_RELAY_URL: 'https://hghub-proxy.liguohao770801114.workers.dev/mcp',
    KITESURF_PAGE_CAP: 12000,
    KITESURF_RUN_FETCH_LIMIT: 5,
    SKILL_BODY_CAP: 9000,
    SKILL_PER_AGENT_LIMIT: 2,
    MCP_RESULT_CAP: 8000,
    MCP_RUN_CALL_LIMIT: 5,
    TOOL_LOOP_MAX_ROUNDS: 2,
    CODE_PASS_CAP: 9000,
    EVIDENCE_PASS_CAP: 9000,
    PROMPT_CACHE_TTL_MS: 300000,
    PROVIDER_PRESETS: {
      deepseek: { name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
      deepseek_r1: { name: 'DeepSeek R1 (推理)', baseUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-reasoner' },
      claude: { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1/messages', model: 'claude-3-7-sonnet-latest' },
      siliconflow: { name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1/chat/completions', model: 'deepseek-ai/DeepSeek-V3' },
      qwen: { name: '阿里百炼 (通义千问)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
      openai: { name: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
      kimi: { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-32k' },
      gemini: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash' }
    },
    SQUAD_SEED_NAMES: {
      engineering: '💻 核心研发编队',
      secops: '🛡️ 深度安全审计',
      product: '📈 产品商业全案'
    },
    NEON_PALETTE: ['#00F0FF', '#FFB800', '#9D4EDD', '#00FFA3', '#FF2E93', '#3A86FF', '#FF6B35']
  };

  const SQUAD_TEMPLATES = {
    engineering: [
      {
        id: 'agent-1', code: 'N-01', name: 'Nexus-01 架构总控', shortName: '总控',
        role: '全局任务拆解与技术纲要', icon: '🧠', color: '#00F0FF',
        systemPrompt: '你是 Nexus-01 架构总控智能体。请针对用户提交的任务，输出清晰的结构化拆解方案、核心架构设计原则以及各子模块的协作边界。请直接给出专业干货。【职责约束】你只负责拆解、架构与接口约定，禁止输出完整代码实现，代码由研发节点编写。（禁回填）你只做拆解与约定，禁止在产出中回填或宣布任何检索结果、数据或核验结论；即使你调用了工具，数据与结论也一律由执行节点产出，你的产出只含方案、约定与验收标准。'
      },
      {
        id: 'agent-2', code: 'R-02', name: 'Research-02 深度调研', shortName: '调研',
        role: '技术选型对比与行业基准', icon: '🔎', color: '#FFB800',
        systemPrompt: '你是 Research-02 深度调研智能体。请结合用户的原始需求与总控架构方案，给出具体的技术栈选型对比、核心算法/协议分析及行业最佳实践参数。【省Token协议】只给选型结论与关键参数，不要复述任务原文。'
      },
      {
        id: 'agent-3', code: 'C-03', name: 'Coder-03 核心研发', shortName: '研发',
        role: '核心模块代码与接口实现', icon: '💻', color: '#9D4EDD',
        systemPrompt: '你是 Coder-03 核心研发智能体。请根据上游的总控架构与技术选型，编写关键生产级代码实现（含清晰注释、数据结构定义与核心处理逻辑）。【省Token协议】完整代码只在本节点输出一次且用代码块包裹；说明文字从简，不要在代码块之外重复粘贴代码。'
      },
      {
        id: 'agent-4', code: 'S-04', name: 'SecOps-04 安全与压测', shortName: '安全',
        role: '漏洞审计、并发瓶颈与加固', icon: '🛡️', color: '#00FFA3',
        systemPrompt: '你是 SecOps-04 安全审计与高并发压测智能体。请严格审查上游的架构与代码，指出潜在的并发竞争、安全漏洞或异常边界，并提供具体的修复加固方案与验证清单。【省Token协议】只输出问题清单：每条含编号、级别(P0/P1/P2)、位置(函数名或行号)、问题一句话、修法一句话；禁止复述或重写完整代码，必须给修复代码时只给最小改动片段；没有问题就写「未发现问题」并列出已核查项。'
      },
      {
        id: 'agent-5', code: 'M-05', name: 'Memory-05 交付中枢', shortName: '汇总',
        role: '全局整合与落地执行蓝图', icon: '📑', color: '#FF2E93',
        systemPrompt: '你是 Memory-05 交付汇总智能体。请将前面所有智能体的关键结论、核心架构、代码要点与安全准则汇总为一份条理清晰、可立即落地的执行蓝图。【省Token协议】禁止凭摘要重写或复述上游代码；（数据保真协议）最终结论中的每个数字、限额与事实都必须能在上游产出或系统原始证据中逐字找到；上游标注为未确认、MISSING 或未找到的，必须原样保留为未确认，禁止用常识或推测补全；上游互相矛盾时必须明确指出矛盾并以原始证据为准，不得自行调和；最终交付中的完整代码用单独一行 [[ATTACH_CODE:agent-3]] 引用，系统会自动附上 Coder-03 的代码原文，你只需写结论、要点、安全清单落实情况与使用说明；仅当安全清单含 P0 且必须改代码时，才亲自输出修正后的完整代码且不使用引用标记。'
      }
    ],
    secops: [
      {
        id: 'agent-1', code: 'T-01', name: 'Threat-01 威胁建模总控', shortName: '建模',
        role: '攻击面梳理与权限边界定义', icon: '🎯', color: '#00F0FF',
        systemPrompt: '你是 Threat-01 威胁建模总控智能体。请采用 STRIDE 模型梳理目标系统的攻击面、信任边界与高危风险点。【职责约束】你只负责威胁建模与边界定义，禁止输出完整代码实现，代码由补丁节点编写。（禁回填）你只做建模与边界定义，禁止在产出中回填或宣布任何检索结果、数据或核验结论；即使你调用了工具，数据与结论也一律由执行节点产出，你的产出只含模型、边界与验收标准。'
      },
      {
        id: 'agent-2', code: 'A-02', name: 'Audit-02 静态代码审计', shortName: '审计',
        role: '注入漏洞、越权与竞态排查', icon: '🔍', color: '#FFB800',
        systemPrompt: '你是 Audit-02 静态代码审计智能体。请深度排查目标逻辑中的路径遍历、注入风险、竞态条件与未授权访问漏洞。【省Token协议】只输出问题清单：每条含编号、级别、位置、问题一句话、修法一句话；禁止复述被审计代码全文。'
      },
      {
        id: 'agent-3', code: 'P-03', name: 'Patch-03 加固补丁研发', shortName: '补丁',
        role: '零信任沙箱与防御代码编写', icon: '🔒', color: '#9D4EDD',
        systemPrompt: '你是 Patch-03 安全加固研发智能体。请针对上游发现的所有安全隐患，编写带白名单校验、最小权限控制与异常隔离的加固代码。【省Token协议】完整代码只在本节点输出一次且用代码块包裹；说明文字从简，不要在代码块之外重复粘贴代码。'
      },
      {
        id: 'agent-4', code: 'X-04', name: 'Chaos-04 混沌与回归验证', shortName: '混沌',
        role: '极端并发、畸形输入与逃逸测试', icon: '⚡', color: '#00FFA3',
        systemPrompt: '你是 Chaos-04 混沌压测智能体。请编写针对性的边界测试用例、并发重入压测断言与安全合规检查表。【省Token协议】只输出测试清单与断言要点，禁止复述被测代码。'
      },
      {
        id: 'agent-5', code: 'C-05', name: 'Cert-05 合规签发中枢', shortName: '签发',
        role: '安全审计报告与最终修复版汇总', icon: '📜', color: '#FF2E93',
        systemPrompt: '你是 Cert-05 合规签发智能体。请汇总所有漏洞修复记录、最终安全代码与合规审计结论，输出完整交付报告。【省Token协议】禁止凭摘要重写或复述上游代码；（数据保真协议）最终结论中的每个数字、限额与事实都必须能在上游产出或系统原始证据中逐字找到；上游标注为未确认、MISSING 或未找到的，必须原样保留为未确认，禁止用常识或推测补全；上游互相矛盾时必须明确指出矛盾并以原始证据为准，不得自行调和；最终交付中的完整代码用单独一行 [[ATTACH_CODE:agent-3]] 引用，系统会自动附上 Patch-03 的代码原文，你只需写结论、要点、安全清单落实情况与使用说明；仅当安全清单含 P0 且必须改代码时，才亲自输出修正后的完整代码且不使用引用标记。'
      }
    ],
    product: [
      {
        id: 'agent-1', code: 'P-01', name: 'PM-01 产品战略总控', shortName: '产品',
        role: '用户痛点拆解与 MVP 核心功能定义', icon: '🧭', color: '#00F0FF',
        systemPrompt: '你是 PM-01 产品战略总控。请明确目标用户画像、核心痛点、MVP 功能矩阵与核心差异化壁垒。【职责约束】你只负责产品定义与功能矩阵，禁止输出完整代码实现，代码由原型节点编写。（禁回填）你只做产品定义与功能矩阵，禁止在产出中回填或宣布任何检索结果、数据或核验结论；即使你调用了工具，数据与结论也一律由执行节点产出，你的产出只含定义、矩阵与验收标准。'
      },
      {
        id: 'agent-2', code: 'U-02', name: 'UX-02 交互与视觉架构', shortName: '交互',
        role: '核心页面流转与高转化交互设计', icon: '🎨', color: '#FFB800',
        systemPrompt: '你是 UX-02 交互设计专家。请输出关键界面布局结构、用户首屏体验动线与零摩擦交互细节。'
      },
      {
        id: 'agent-3', code: 'D-03', name: 'Tech-03 全栈原型实现', shortName: '原型',
        role: '核心业务代码与数据存储实现', icon: '💻', color: '#9D4EDD',
        systemPrompt: '你是 Tech-03 全栈研发专家。请根据产品与交互方案编写关键前端/后端实现代码与核心数据结构。【省Token协议】完整代码只在本节点输出一次且用代码块包裹；说明文字从简，不要在代码块之外重复粘贴代码。'
      },
      {
        id: 'agent-4', code: 'G-04', name: 'Growth-04 定价与商业化', shortName: '商业',
        role: 'BYOK/订阅定价模型与获客漏斗', icon: '💰', color: '#00FFA3',
        systemPrompt: '你是 Growth-04 商业化增长专家。请制定精准的定价策略、付费解锁点、回本测算与冷启动推广渠道方案。【省Token协议】只输出定价与策略结论，不要复述上游代码或方案全文。'
      },
      {
        id: 'agent-5', code: 'L-05', name: 'Launch-05 发布交付中枢', shortName: '发布',
        role: '完整产品白皮书与上线清单汇总', icon: '🚀', color: '#FF2E93',
        systemPrompt: '你是 Launch-05 发布交付中枢。请将产品定义、交互设计、核心代码与商业化方案整合为可直接执行的上线蓝图。【省Token协议】禁止凭摘要重写或复述上游代码；（数据保真协议）最终结论中的每个数字、限额与事实都必须能在上游产出或系统原始证据中逐字找到；上游标注为未确认、MISSING 或未找到的，必须原样保留为未确认，禁止用常识或推测补全；上游互相矛盾时必须明确指出矛盾并以原始证据为准，不得自行调和；最终交付中的完整代码用单独一行 [[ATTACH_CODE:agent-3]] 引用，系统会自动附上 Tech-03 的代码原文，你只需写结论、要点、安全清单落实情况与使用说明；仅当安全清单含 P0 且必须改代码时，才亲自输出修正后的完整代码且不使用引用标记。'
      }
    ]
  };

  /* ===== Utilities ===== */
  const util = {
    escHtml(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
    escapeRegExp(str) {
      return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    },
    uid(prefix) {
      return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    },
    fnv1a(text) {
      const s = String(text || '');
      let hash = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return 'v1:' + hash.toString(16).padStart(8, '0') + ':' + s.length.toString(16);
    },
    extractUrls(text) {
      const found = String(text || '').match(/https?:\/\/[^\s<>"'，。；、（）【】「」\u4e00-\u9fff\uff00-\uffef]+/g) || [];
      const seen = new Set();
      const urls = [];
      for (let u of found) {
        u = u.replace(/[，。；、）】]+$/, '');
        if (!seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
      return urls;
    },
    cleanNavMarkdown(md) {
      const lines = String(md || '').split('\n');
      const out = [];
      let inFence = false;
      for (const line of lines) {
        if (/^\s*```/.test(line)) inFence = !inFence;
        if (!inFence) {
          const t = line.trim();
          if (/^[-*]\s*\[[^\]]*\]\([^)]*\)\s*$/.test(t)) continue;
          if (/^\[[^\]]*\]\([^)]*\)$/.test(t)) continue;
          if (/^!\[[^\]]*\]\([^)]*\)$/.test(t)) continue;
        }
        out.push(line);
      }
      return out.join('\n').replace(/\n{3,}/g, '\n\n');
    },
    parseSkillMarkdown(md) {
      const text = String(md || '');
      let name = '';
      let desc = '';
      let body = text;
      const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
      if (m) {
        const fm = m[1];
        const nm = fm.match(/^name:\s*(.+)$/m);
        if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
        const dm = fm.match(/^description:\s*(.+)$/m);
        if (dm) desc = dm[1].trim().replace(/^["']|["']$/g, '');
        body = text.slice(m[0].length);
      }
      return { name, desc, body: body.trim() };
    }
  };

  /* ===== Safe Storage Wrapper ===== */
  const ls = {
    getRaw(key) {
      try { return global.localStorage.getItem(key); } catch (_) { return null; }
    },
    setRaw(key, val) {
      try { global.localStorage.setItem(key, String(val)); } catch (_) {}
    },
    getJson(key, fallback) {
      try {
        const raw = global.localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    setJson(key, val) {
      try { global.localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
    },
    has(key) {
      try { return global.localStorage.getItem(key) !== null; } catch (_) { return false; }
    }
  };

  /* ===== Runtime State ===== */
  const state = {
    api: {
      baseUrl: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.3,
      stream: true,
      compactMaxChars: 1600,
      cfAccountId: '',
      cfToken: ''
    },
    squads: [],
    activeSquadId: '',
    agents: [],
    skills: [],
    mcpServers: [],
    instructions: [],
    isExecuting: false,
    isDirectChatting: false,
    abortCtrl: null,
    cumulativeTokens: 0,
    cumulativeLatencyMs: 0,
    inspectedAgentId: 'agent-1',
    pipelineFinalAgentId: null,
    tridentStats: {
      tokensSavedEstimate: 0,
      originalChars: 0,
      compressedChars: 0
    },
    promptCache: new Map(),
    artifactStore: {},
    evidenceStore: [],
    kitesurfCache: {},
    kitesurfFetchCount: 0,
    prefetchedPages: [],
    libSkillLoads: {},
    mcpCallCount: 0,
    mcpToolIndex: {},
    mcpSessions: {},
    activePackets: []
  };

  /* ===== Data Helpers ===== */
  const LEGACY_COLOR_MAP = {
    '#06B6D4': '#00F0FF',
    '#F59E0B': '#FFB800',
    '#6366F1': '#9D4EDD',
    '#10B981': '#00FFA3',
    '#EC4899': '#FF2E93'
  };

  function normalizeAgentColor(c) {
    const key = String(c || '').toUpperCase();
    return LEGACY_COLOR_MAP[key] || c || '#00F0FF';
  }

  function defToRuntime(item) {
    return {
      ...item,
      color: normalizeAgentColor(item.color),
      enabled: item.enabled !== false,
      status: 'idle',
      output: '',
      latencyMs: 0,
      tokens: 0,
      cachedHit: false
    };
  }

  function runtimeToDef(ag) {
    return {
      id: ag.id,
      code: ag.code,
      name: ag.name,
      shortName: ag.shortName,
      role: ag.role,
      icon: ag.icon,
      color: ag.color,
      systemPrompt: ag.systemPrompt,
      enabled: ag.enabled !== false
    };
  }

  function seedSquads() {
    return Object.keys(SQUAD_TEMPLATES).map((k) => ({
      id: 'sq-' + k,
      name: CONST.SQUAD_SEED_NAMES[k] || k,
      builtin: k,
      agents: SQUAD_TEMPLATES[k].map((d) => ({ ...d, enabled: true }))
    }));
  }

  function seedSkills() {
    return [
      {
        id: util.uid('sk'),
        name: '中文技术文档总结',
        desc: '总结英文/中文技术文档页面时用：分层提炼、保留数字与限制条件',
        body: '## 技能：中文技术文档总结\n按以下规程总结技术文档：\n1. 一句话定位：这是什么产品/能力，处于什么阶段（beta/正式）。\n2. 核心要点 3–7 条：解决什么问题、关键能力、使用方式、限制条件。\n3. 数字必须逐字核对原文（性能、配额、价格、覆盖率），不得四舍五入或臆造。\n4. 单列「做不到/不支持」清单。\n5. 接入方式逐项列全（API、绑定、协议、工具）。\n6. 只陈述页面明示内容；页面未提及的写「页面未明确」，禁止引入外部推断。',
        agents: ['agent-2'],
        enabled: true,
        forceLoad: false
      },
      {
        id: util.uid('sk'),
        name: '代码审计清单',
        desc: '审计代码时用：按注入/越权/竞态/数据安全逐项排查，只出问题清单',
        body: '## 技能：代码审计清单\n逐项排查并只报告命中的问题（级别 P0/P1/P2 + 位置 + 一句话说明）：\n1. 注入：SQL/命令/模板注入、未转义的用户输入拼接。\n2. 越权：缺失的权限校验、IDOR、路径穿越。\n3. 竞态：先查后写、非原子计数、文件覆盖。\n4. 数据安全：删除/更新是否可恢复、ID 是否复用、持久化是否会复活已删数据。\n5. 边界：空输入、超长输入、损坏的数据文件、编码问题。\n6. 密钥与日志：硬编码密钥、敏感信息进日志。\n未命中的项不要复述，不要重写代码，只出问题清单。',
        agents: ['agent-4'],
        enabled: true,
        forceLoad: false
      },
      {
        id: util.uid('sk'),
        name: '提示词优化',
        desc: '需要撰写或改进给其他智能体/模型的提示词时用',
        body: '## 技能：提示词优化\n优化提示词时遵循：\n1. 先定输出契约：格式、长度、必须包含与禁止包含的内容，写在提示词前部。\n2. 用结构化分段（角色/任务/约束/输出格式/示例），一段一个主题。\n3. 一次只针对一个失败模式改一处，避免多处同时改动无法归因。\n4. 给出可判定的验收标准，而不是「写得好一点」这类模糊要求。\n5. 需要引用外部材料时，要求标注来源，禁止凭空编造。',
        agents: ['all'],
        enabled: true,
        forceLoad: false
      }
    ];
  }

  function saveApi() {
    ls.setJson(KEYS.API_CFG, state.api);
  }

  function saveSquads() {
    ls.setJson(KEYS.SQUADS, state.squads);
    ls.setRaw(KEYS.ACTIVE_SQUAD, state.activeSquadId);
  }

  function persistActiveSquad() {
    const sq = state.squads.find((s) => s.id === state.activeSquadId);
    if (sq) sq.agents = state.agents.map(runtimeToDef);
    saveSquads();
  }

  function loadSquadIntoRuntime(sq) {
    state.agents.length = 0;
    (sq.agents || []).forEach((d) => state.agents.push(defToRuntime(d)));
    state.activeSquadId = sq.id;
    state.inspectedAgentId = state.agents.length ? state.agents[0].id : 'agent-1';
  }

  function saveLibrary() {
    ls.setJson(KEYS.SKILLS, state.skills);
    ls.setJson(KEYS.MCP, state.mcpServers);
    ls.setJson(KEYS.INSTRUCTIONS, state.instructions);
  }

  function isLibAssigned(item, agentId) {
    if (!item || item.enabled === false) return false;
    const assigned = (item.agents && item.agents.length) ? item.agents : ['all'];
    if (!agentId) return true;
    return assigned.includes('all') || assigned.includes(agentId);
  }

  function getAgentDisplayName(agentId) {
    if (agentId === 'all') return '全部智能体';
    const current = state.agents.find((a) => a.id === agentId);
    if (current) return current.name;
    for (const sq of state.squads) {
      const hit = (sq.agents || []).find((a) => a && a.id === agentId);
      if (hit) return hit.name;
    }
    return agentId;
  }

  function getAssignSummary(item) {
    const assigned = (item.agents && item.agents.length) ? item.agents : ['all'];
    if (assigned.includes('all')) return '全部智能体';
    return assigned.map(getAgentDisplayName).join('、');
  }

  function upsertSkill(parsed) {
    const existing = state.skills.find((s) => s.name === parsed.name);
    if (existing) {
      existing.desc = parsed.desc || existing.desc;
      existing.body = parsed.body;
      existing.enabled = true;
    } else {
      state.skills.push({
        id: util.uid('sk'),
        name: parsed.name,
        desc: parsed.desc || '',
        body: parsed.body,
        agents: ['all'],
        enabled: true,
        forceLoad: false
      });
    }
    saveLibrary();
  }

  function mergeById(existing, incoming) {
    if (!Array.isArray(incoming)) return existing;
    const out = existing.slice();
    incoming.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const idx = item.id != null ? out.findIndex((x) => x && x.id === item.id) : -1;
      if (idx >= 0) out[idx] = item;
      else out.push(item);
    });
    return out;
  }

  function mergeSquads(existing, incoming) {
    if (!Array.isArray(incoming)) return existing;
    const out = existing.slice();
    incoming.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      let idx = item.id != null ? out.findIndex((x) => x && x.id === item.id) : -1;
      if (idx < 0 && item.builtin) idx = out.findIndex((x) => x && x.builtin === item.builtin);
      if (idx >= 0) out[idx] = item;
      else out.push(item);
    });
    return out;
  }

  function exportLibraryJson() {
    persistActiveSquad();
    return JSON.stringify({
      nexusaiLibrary: 1,
      skills: state.skills,
      mcpServers: state.mcpServers,
      instructions: state.instructions,
      squads: state.squads,
      activeSquadId: state.activeSquadId
    }, null, 2);
  }

  function importLibraryJson(text) {
    const parsed = JSON.parse(String(text || ''));
    if (!parsed || typeof parsed !== 'object') throw new Error('不是有效的配置 JSON');
    if (Array.isArray(parsed.skills)) state.skills = mergeById(state.skills, parsed.skills);
    if (Array.isArray(parsed.mcpServers)) state.mcpServers = mergeById(state.mcpServers, parsed.mcpServers);
    if (Array.isArray(parsed.instructions)) state.instructions = mergeById(state.instructions, parsed.instructions);
    saveLibrary();

    let squadUpdated = false;
    if (Array.isArray(parsed.squads) && parsed.squads.length) {
      const beforeId = state.activeSquadId;
      const beforeBuiltin = (state.squads.find((s) => s.id === beforeId) || {}).builtin;
      state.squads = mergeSquads(state.squads, parsed.squads);
      const target =
        state.squads.find((s) => s.id === parsed.activeSquadId) ||
        state.squads.find((s) => s.id === beforeId) ||
        (beforeBuiltin ? state.squads.find((s) => s.builtin === beforeBuiltin) : null) ||
        state.squads[0];
      loadSquadIntoRuntime(target);
      saveSquads();
      squadUpdated = true;
    }
    return { squadUpdated };
  }

  function recordEvidence(kind, label, text) {
    state.evidenceStore.push({ kind, label, text: String(text || '') });
    if (state.evidenceStore.length > 6) state.evidenceStore.shift();
  }

  function spawnPacket(fromId, toId, color) {
    state.activePackets.push({
      fromId,
      toId,
      progress: 0,
      speed: 0.024 + Math.random() * 0.012,
      color: color || '#00F0FF'
    });
    if (state.activePackets.length > 24) state.activePackets.shift();
  }

  /* ===== Hydrate from localStorage on Load ===== */
  function hydrate() {
    const savedApi = ls.getJson(KEYS.API_CFG, null);
    if (savedApi && typeof savedApi === 'object') {
      if (savedApi.baseUrl) state.api.baseUrl = savedApi.baseUrl;
      if (typeof savedApi.apiKey === 'string') state.api.apiKey = savedApi.apiKey;
      if (savedApi.model) state.api.model = savedApi.model;
      if (typeof savedApi.temperature === 'number' && Number.isFinite(savedApi.temperature)) {
        state.api.temperature = savedApi.temperature;
      }
      if (typeof savedApi.stream === 'boolean') state.api.stream = savedApi.stream;
      if (typeof savedApi.cfAccountId === 'string') state.api.cfAccountId = savedApi.cfAccountId;
      if (typeof savedApi.cfToken === 'string') state.api.cfToken = savedApi.cfToken;
    }

    if (!ls.has(KEYS.SKILLS)) {
      state.skills = seedSkills();
      ls.setJson(KEYS.SKILLS, state.skills);
    } else {
      const arr = ls.getJson(KEYS.SKILLS, []);
      state.skills = Array.isArray(arr) ? arr : [];
    }
    const mcpArr = ls.getJson(KEYS.MCP, []);
    state.mcpServers = Array.isArray(mcpArr) ? mcpArr : [];
    const instArr = ls.getJson(KEYS.INSTRUCTIONS, []);
    state.instructions = Array.isArray(instArr) ? instArr : [];

    const savedSquads = ls.getJson(KEYS.SQUADS, []);
    state.squads = (Array.isArray(savedSquads) && savedSquads.length) ? savedSquads : seedSquads();
    const savedActive = ls.getRaw(KEYS.ACTIVE_SQUAD);
    const initialSquad =
      state.squads.find((s) => s.id === savedActive) ||
      state.squads.find((s) => s.builtin === 'engineering') ||
      state.squads[0];
    loadSquadIntoRuntime(initialSquad);
    saveSquads();
  }

  hydrate();

  Nexus.CONST = CONST;
  Nexus.util = util;
  Nexus.state = state;
  Nexus.store = {
    ls,
    defToRuntime,
    runtimeToDef,
    saveApi,
    saveSquads,
    persistActiveSquad,
    loadSquadIntoRuntime,
    saveLibrary,
    isLibAssigned,
    getAgentDisplayName,
    getAssignSummary,
    upsertSkill,
    exportLibraryJson,
    importLibraryJson,
    recordEvidence,
    spawnPacket
  };
})(window);
