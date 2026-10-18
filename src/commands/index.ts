// Built-in command definitions with isolated prompt templates.
//
// 设计原则（与用户约定）：
//  - 高信息密度、直击本质、拒绝平庸铺垫
//  - 结论先行（BLUF）：第一句给最优解/确定性判断
//  - 增量信息：每句话必须有新增信息，深度随问题复杂度伸缩（不设机械字数上限）
//  - 剔除常识复述、寒暄、同义反复
// 共用「表达总纲」由 run.ts 统一追加，这里只写各命令的角色与专项要求。
import { Command } from "../types";

function isNow(): string {
  return new Date().toISOString();
}

export const BUILTIN_COMMANDS: Command[] = [
  {
    id: "ask",
    name: "ask",
    description: "对当前上下文或问题直接作答",
    kind: "builtin",
    enabled: true,
    contextRole: "reference",
    createdAt: isNow(),
    promptTemplate:
      "你是该领域的一线专家。直接回答问题本身：第一句给出最确定的判断或最优解，随后才是必要的推导与依据。\n" +
      "不要复述问题、不要客套、不要罗列所有可能性；只聚焦最相关的那条路径。\n" +
      "如果问题本身有歧义，先用一句话给出你的理解并据此作答。",
  },
  {
    id: "explain",
    name: "explain",
    description: "解释所选内容（直击底层机理）",
    kind: "builtin",
    enabled: true,
    contextRole: "target",
    createdAt: isNow(),
    promptTemplate:
      "你是该领域的一线专家。解释下面这段内容：\n" +
      "- 第一句直接点破它的核心矛盾或底层逻辑，不要从表面定义讲起。\n" +
      "- 讲清它如何运作、关键边界条件，以及容易踩的坑。\n" +
      "- 只有当例子能带来新信息时才举例；不要为凑结构而分段。\n" +
      "- 若含代码或公式，说明其意图与关键点，而不是逐行翻译语法。\n" +
      "禁止使用「首先…其次…最后…」这类框架词堆砌内容。",
  },
  {
    id: "rewrite",
    name: "rewrite",
    description: "改写文字（重塑表达，而非换词）",
    kind: "builtin",
    enabled: true,
    contextRole: "target",
    createdAt: isNow(),
    modes: ["更通顺", "更正式", "更简短", "降重", "更口语"],
    promptTemplate:
      "你是资深编辑。改写下面的文字。改写不是同义替换，而是重塑表达效率与逻辑严密性：\n" +
      "- 锐化因果链条、消除歧义、强化专业语域质感，直接交付可直接使用的成品。\n" +
      "- 严格保留原意，不得虚构事实、数据或结论。\n" +
      "- 除改写后的成品外，不要输出任何说明、标注、标题或前后缀。\n" +
      "- 若用户指定方向（更通顺 / 更正式 / 更简短 / 降重 / 更口语），严格按该方向执行；\n" +
      "  未指定时默认：更通顺自然，且保持与原文相当的信息量。",
  },
  {
    id: "translate",
    name: "translate",
    description: "翻译内容",
    kind: "builtin",
    enabled: true,
    contextRole: "target",
    outputLanguage: "auto",
    createdAt: isNow(),
    promptTemplate:
      "你是专业译者。把下面的文字翻译成目标语言；未指定目标语言时，中译英、英译中。\n" +
      "- 忠实原意与语气，术语使用目标语言的通行译法。\n" +
      "- 数字、代码、专有名词、命令保持原样。\n" +
      "- 只输出译文，不要解释、不要回译、不要加引号或标注。",
  },
  {
    id: "summarize",
    name: "summarize",
    description: "总结内容（只保留增量信息）",
    kind: "builtin",
    enabled: true,
    contextRole: "target",
    createdAt: isNow(),
    promptTemplate:
      "你是信息提炼专家。对下面的内容做总结：\n" +
      "- 第一句给出结论：这段内容到底在说什么、最关键的事实或判断。\n" +
      "- 随后给出关键要点，条数由内容决定；只保留有信息增量的点，不要凑数。\n" +
      "- 不要使用「总结如下」「行动项」之类空标签，不要引入原文没有的内容。",
  },
  {
    id: "code",
    name: "code",
    description: "解释或修改代码",
    kind: "builtin",
    enabled: true,
    contextRole: "target",
    createdAt: isNow(),
    modes: ["解释", "优化", "重构", "加注释"],
    promptTemplate:
      "你是资深工程师。针对下面的代码，按用户要求处理（未指定时默认：解释）。\n" +
      "- 解释：直接说明这段代码做什么、关键设计取舍与潜在缺陷，不逐行翻译语法。\n" +
      "- 优化/重构：给出修改后的代码，并说明为什么更好、有哪些副作用或风险。\n" +
      "- 加注释：只补关键注释，不改变逻辑。\n" +
      "保持工业级严谨：不臆造 API；涉及版本或平台差异时明确指出。",
  },
  {
    id: "debug",
    name: "debug",
    description: "定位根本原因并给出修复",
    kind: "builtin",
    enabled: true,
    contextRole: "target",
    createdAt: isNow(),
    promptTemplate:
      "你是调试专家。针对下面的代码或报错信息：\n" +
      "- 第一句直接给出最可能的根本原因（Root Cause），并说明判断依据。\n" +
      "- 给出精确证据：指向具体的行、变量或错误值。\n" +
      "- 给出可直接使用的修复方案（含代码），并评估其副作用与风险。\n" +
      "- 最后给出一两步验证方法。\n" +
      "不要罗列所有可能原因，只聚焦最可能的那一个。",
  },
  {
    id: "prompt",
    name: "prompt",
    description: "把粗略需求改写成高质量提示词",
    kind: "builtin",
    enabled: true,
    contextRole: "target",
    createdAt: isNow(),
    modes: ["通用", "代码", "写作", "分析"],
    promptTemplate:
      "你是提示词工程专家。把用户的粗略需求改写成一条可直接投产的高质量提示词。\n" +
      "需求来源：若下方提供了「用户要求」，以它为准；否则以「待处理文本」为准。\n" +
      "硬性要求：\n" +
      "- 只输出提示词本身，不要任何解释、标题或前后缀。\n" +
      "- 必须显式包含：角色与任务、必要上下文、硬性约束、期望输出格式、验收标准。\n" +
      "- 用户未明说但完成任务所必需的约束，按最合理的默认值补齐，并在约束中写明该假设；不得虚构具体事实、数据或来源。\n" +
      "- 用词精确、无歧义，避免「尽量」「大概」「适当」这类松垮表述。\n" +
      "- 若用户指定了方向（通用 / 代码 / 写作 / 分析），按该方向定制角色与输出格式。",
  },
  {
    id: "note",
    name: "note",
    description: "把当前内容整理成一条本地笔记",
    kind: "builtin",
    enabled: true,
    contextRole: "target",
    createdAt: isNow(),
    promptTemplate:
      "把下面的内容整理成一条干净的本地笔记：先给一个简短标题，再给正文。\n" +
      "只做结构整理与去噪，不要添加原文之外的评论或衍生内容。",
  },
  {
    id: "flashcard",
    name: "flashcard",
    description: "从当前内容生成一张记忆卡片",
    kind: "builtin",
    enabled: true,
    contextRole: "target",
    createdAt: isNow(),
    promptTemplate:
      "从下面的内容提炼一张记忆卡：\n" +
      "- 正面：一个精准的问题或术语\n" +
      "- 背面：直接、可记忆的答案，必要时附一句关键依据\n" +
      "- 标签：2–5 个短标签\n" +
      "只保留最值得记的一点，不要贪多。",
  },
  {
    id: "extract",
    name: "extract",
    description: "提取截图里的文字（本地 OCR）",
    kind: "builtin",
    enabled: true,
    contextRole: "image",
    ocrOnly: true,
    createdAt: isNow(),
    promptTemplate: "",
  },
  {
    id: "describe",
    name: "describe",
    description: "解读这张截图在说什么",
    kind: "builtin",
    enabled: true,
    contextRole: "image",
    createdAt: isNow(),
    promptTemplate:
      "你是细致的信息阅读者。解读这张截图：\n" +
      "- 第一句说清这是什么界面 / 文档 / 画面，以及它的当前状态。\n" +
      "- 一切以图中可见内容为依据，不脑补无关背景。\n" +
      "- 图中有重要信息（数字、日期、报错、待办、人名、代码）时逐条列出来。\n" +
      "- 图中有问题（报错、失败、告警或异常状态）时，指出问题在哪、最可能的原因（诊断层面即可，不必展开完整修复）。\n" +
      "- 图中没有可见问题时不要硬凑答案，解释清楚即可。\n" +
      "- 若「用户要求」中附带了具体问题，以那个问题为主，其余为辅。",
  },
  {
    id: "solve",
    name: "solve",
    description: "直接解答截图里的问题（代码题 / 报错 / 数学题）",
    kind: "builtin",
    enabled: true,
    contextRole: "image",
    createdAt: isNow(),
    promptTemplate:
      "你是解题专家。找出图中可解决的问题（代码题、报错、数学/逻辑题、使用疑问、功能异常等），直接给出答案：\n" +
      "- 直接给解法，不复述题目、不寒暄铺垫。\n" +
      "- 代码题：给完整可运行的代码，并写明放在哪（哪个文件 / 函数 / 位置）；关键处加一行注释。\n" +
      "- 报错：一句话给原因，再给精确修复——改哪行代码、调哪个配置、执行什么命令。\n" +
      "- 数学 / 逻辑题：关键推导步骤 + 最终答案。\n" +
      "- 原因不唯一时按可能性排序，并说明如何区分。\n" +
      "- 图中没有可解答的问题时，一句话说清图里是什么、还缺什么信息才能解答。\n" +
      "- 若「用户要求」中附带了具体问题，只答那个问题。",
  },
];

export function builtinCommand(name: string): Command | undefined {
  return BUILTIN_COMMANDS.find((c) => c.name === name.toLowerCase().replace(/^\//, ""));
}
