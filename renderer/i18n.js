/* Z UI localization. The source language remains Chinese so existing
 * sessions and user-authored content are never rewritten in storage. */
(function installYanI18n(global) {
  const ZH_EN = Object.freeze({
    '从这里创建分支': 'Branch conversation from here',
    '从这里创建分支；共享当前文件，不会回滚文件': 'Branch conversation from here; uses current files without rolling them back',
    '对话分支来源': 'Conversation branch source', '分支来自': 'Branched from',
    '返回原对话': 'Return to source conversation', '原对话': 'Source conversation',
    '共享当前文件；不会回滚文件': 'Uses current files; does not roll back files',
    '请重启 Z 后使用对话分支': 'Restart Z to use conversation branches',
    '正在创建对话分支…': 'Creating conversation branch…',
    '正在加载历史消息，请稍后': 'Loading conversation history. Please wait.',
    '等待这条消息完成后再创建分支': 'Wait for this message to finish before branching',
    '消息保存后可创建分支': 'Available after this message is saved',
    '这条消息已变化，请重新选择分支起点': 'This message changed. Select the branch point again.',
    '创建对话分支失败，请重试': 'Could not create the conversation branch. Try again.',
    '对话分支已创建，可在任务列表中打开': 'Conversation branch created. Open it from the task list.',
    '对话分支已创建，请从任务列表打开': 'Conversation branch created. Please open it from the task list.',
    '原对话已不存在，当前分支仍可继续': 'The source conversation is no longer available. You can continue this branch.',
    '无法打开原对话，请重试': 'Could not open the source conversation. Try again.',
    '分支中的历史记录仅供查看': 'Inherited conversation history is read-only',
    '观察记录': 'Observer history', '选择此对话的观察记录': 'Choose an observation from this conversation',
    '正在读取观察记录…': 'Loading observer history…', '最近一轮': 'Latest run', '当前运行': 'Current run',
    '加载更早记录': 'Load earlier records', '正在加载更早记录…': 'Loading earlier records…',
    '观察记录加载失败，请重试': 'Could not load observer history. Try again.',
    '选择连接': 'Select connection', '切换 API 连接': 'Switch API connection', '切换 API': 'Switch API',
    'API 连接': 'API connection', '规则': 'Rules', '规则模式': 'Rule mode', '观察者设置': 'Observer settings',
    '细节模式': 'Details', '检查间隔（工具动作数）': 'Check interval (tool actions)',
    '观察者思考强度': 'Observer reasoning strength',
    '轻度': 'Low', '高': 'High', '极高': 'Extra high', '最高': 'Maximum',
    '与主模型独立设置，默认最高。仅用于模型观察，从下一轮任务生效。': 'Set independently from the main model; Maximum by default. Applies to model observation from the next task.',
    '规则模式不调用模型；选择观察者模型后可调整思考强度。': 'Rule mode makes no model calls. Select an observer model to adjust its reasoning strength.',
    '规则模式无需模型。选择独立模型后，观察者会在后台分析任务摘要并提供建议。修改从下一轮任务生效。': 'Rule mode needs no model. An independent model can review task summaries in the background and offer advice. Changes apply to the next task.',
    '在这里切换主模型使用的 API 和模型。正在执行的任务继续使用原来的连接。': 'Choose the API and model for the main agent. A running task keeps its original connection.',
    '每新增指定数量的工具动作，启动一次观察；不是按聊天消息计数。规则首次需要至少 6 个动作。模型判断期间不重复发起请求。': 'Review after this many new tool actions, not chat messages. Rules need at least 6 actions initially. Model reviews never overlap.',
    '正在读取连接…': 'Loading connections…', '仅规则观察（不调用模型）': 'Rules only (no model calls)',
    '原连接已不可用，请重新选择。': 'The previous connection is unavailable. Choose another.',
    '尚无可用连接，请先在设置中添加 API。': 'No connections available. Add an API in Settings first.',
    '读取连接失败，请重试。': 'Could not load connections. Try again.', '正在保存…': 'Saving…',
    '观察者设置已保存，下轮任务生效': 'Observer settings saved for the next task', 'API 和模型已切换': 'API and model switched',
    '保存失败，请重试。': 'Could not save. Try again.', '检查间隔须为 1 到 100 个工具动作': 'Enter an interval from 1 to 100 tool actions',
    '请选择已启用 API 中的文本模型': 'Choose a text model from an enabled API',
    '模型观察建议': 'Model observer advice', '观察者模型和检查间隔': 'Observer model and check interval',
    '等待动作': 'Waiting for actions', '正在判断': 'Reviewing', '已完成判断': 'Review completed',
    '规则模式继续工作': 'Rule mode remains active', '本轮已结束': 'Task ended',
    '主界面': 'Main', '新建任务': 'New task', 'Skill 市场': 'Skill market', 'MCP 服务': 'MCP services',
    '设置': 'Settings', '宠物': 'Pet', '用户': 'User', '新对话': 'New conversation', '关于Z v1.6.1': 'About Z v1.6.1',
    '选择文件夹': 'Choose folder', '分支': 'Branch', '搜索分支': 'Search branches',
    '创建并检出新分支…': 'Create and checkout branch…', 'Git 图谱': 'Git graph', '置顶任务': 'Pin task',
    '重命名任务': 'Rename task', 'Git 工具': 'Git tools', 'Git 不可用': 'Git unavailable',
    '请先选择 Git 工作区': 'Select a Git workspace first', '更改': 'Changes', '提交或推送': 'Commit or push',
    '打开并同步当前工作区': 'Open and sync current workspace',
    '终端': 'Terminal', '打开电脑上的终端': 'Open the system terminal', '资源管理器': 'Explorer',
    '在文件夹中查看工作区': 'Show workspace in folder', '最近一条': 'Latest', '随时待命': 'Standing by',
    '权限确认': 'Permission required', '使用视觉中继': 'Use vision relay',
    '开启后 Z 会调用免费视觉中继模型辅助定位按钮与理解界面。': 'When enabled, Z can use free vision-relay models to locate controls and understand the interface.',
    '总是允许': 'Always allow', '本次允许': 'Allow once', '拒绝': 'Deny', '待办': 'Todo',
    '编辑了文件': 'Edited files', '已编辑文件': 'Edited files', '查看已编辑文件': 'View edited files',
    '当前文件暂时无法打开审阅': 'This file cannot be opened in Review yet',
    '请求批准': 'Approval requested', '权限访问': 'Permission access',
    '替我审批': 'Approve for me',
    '完全访问': 'Full access', '操作将不再逐一询问': 'Actions will run without asking each time',
    '添加': 'Add', '文件': 'File', '文件夹': 'Folder', '优化prompt': 'Optimize prompt', '优化当前输入': 'Optimize current input',
    '添加附件': 'Add attachment', '优化你的prompt': 'Optimize your prompt', '使用/选择技能或工作方式': 'Use/select a Skill or work mode', '工作方式': 'Work mode',
    '目标': 'Goal', '设置要持续追求的目标': 'Set the outcome to pursue', '设置要追求的目标': 'Set the goal to pursue', '计划': 'Plan', '计划模式': 'Plan mode', '开启计划模式': 'Enable plan mode', '使用/选择工作方式': 'Use/select a work mode', '使用$选择技能': 'Use $ to select a skill',
    '技能': 'Skills', '查找、安装并管理 Agent 可调用的能力。': 'Find, install, and manage capabilities available to the Agent.',
    '全部': 'All', '个人': 'Personal', '添加自定义 Skill': 'Add custom Skill',
    '打开资源管理器': 'Open Explorer', '尚未选择文件': 'No file selected', '服务注册表': 'Service registry',
    '测试连接、启停服务并查看启动命令。': 'Test connections, start or stop services, and inspect launch commands.',
    '服务与命令': 'Services and commands', '操作': 'Actions', '添加服务器': 'Add server',
    '名称': 'Name', '启动命令': 'Launch command', '命令参数': 'Command arguments', '返回': 'Back', '下一页': 'Next',
    '媒体生成': 'Media generation', '就绪': 'Ready', '模型与 API': 'Models and API', '图片': 'Image', '视频': 'Video',
    '提示词': 'Prompt', '比例': 'Aspect ratio', '时长': 'Duration', '3 秒': '3 sec', '5 秒': '5 sec',
    '10 秒': '10 sec', '18 秒': '18 sec', '分辨率': 'Resolution', '更多设置': 'More settings',
    '反向提示词': 'Negative prompt', '随机种子': 'Random seed', '添加参考图': 'Add reference image',
    '生成图片': 'Generate image', '等待生成': 'Waiting to generate', '正在生成图片': 'Generating image',
    '生成失败': 'Generation failed', '浏览器': 'Browser', '审阅': 'Review', '辅助对话': 'Auxiliary chat', '临时对话': 'Temporary chat',
    '侧边面板': 'Side panel', '改动审阅': 'Review changes', '当前任务': 'Current task',
    '暂无可审阅的改动': 'No reviewable changes', 'Agent 修改文件后会显示在这里': 'Changes made by the Agent will appear here',
    'Z工作期间，提问以辅助工作': 'Ask questions while Z is working', 'Z正在操控Browser': 'Z is controlling Browser',
    '缩放': 'Zoom', '自动': 'Auto', '清除缓存': 'Clear cache', '清除 Cookie': 'Clear cookies', '输入URL以浏览': 'Enter a URL to browse',
    'Git 操作': 'Git operations', '取消': 'Cancel', '确认': 'Confirm', '提交信息': 'Commit message',
    '包含未暂存的更改': 'Include unstaged changes', '提交': 'Commit', '提交并推送': 'Commit and push', '推送': 'Push',
    '图': 'Graph', '描述': 'Description', '日期': 'Date', '作者': 'Author', '空闲': 'Idle',
    '关于': 'About', '关于Z': 'About Z', '版本信息与本次更新': 'Version and release notes', '版本信息与更新文档': 'Version information and release notes', '常规': 'General', '视觉中继': 'Vision relay',
    '常见报错': 'Common errors', '关闭常见报错': 'Close common errors', '更新文档': 'Release notes',
    '引导': 'Guide', '滚动到最新内容': 'Scroll to latest content', '权限': 'Permissions',
    '主界面': 'Main interface', '辅助对话': 'Auxiliary chat', '输入框': 'Composer', '工作区': 'Workspace',
    '上手指南': 'Getting started', 'Z 上手指南': 'Using Z', '上手手册': 'Getting started',
    '本次更新': 'This update', '观察者说明': 'About Observer', '本机版本': 'Local version',
    '少一点绕路，多一点完成': 'Less circling, more finishing', 'Z 工作台': 'Z workspace',
    '告诉 Z，你想完成什么…': 'Tell Z what you want to accomplish…',
    'API 连接': 'API connections', '我的连接': 'My connections', '图像/视频模型选择': 'Image/video model selection',
    '生成图像模型选择': 'Image generation model', '生成视频模型选择': 'Video generation model', '未选择': 'Not selected',
    '选择': 'Select', '选择供应商': 'Select provider', '选择模型': 'Select model', '← 上一页': '← Previous',
    '下一页 →': 'Next →', '新建连接': 'New connection', '配置名称': 'Connection name', '兼容预设': 'Compatibility preset',
    '格式': 'Format', '选择接口线路协议；不确定就保留自动识别。': 'Choose the wire protocol; keep auto-detect when unsure.',
    '自动识别': 'Auto-detect', 'OpenAI 通用': 'OpenAI compatible', 'glm·GLMM': 'glm·GLMM',
    '自动识别（按预设与 URL 推断）': 'Auto-detect (inferred from preset and URL)',
    'Chat Completions（/chat/completions）': 'Chat Completions (/chat/completions)',
    'Anthropic Messages（/v1/messages）': 'Anthropic Messages (/v1/messages)',
    'Responses（/responses）': 'Responses (/responses)',
    '通义 · DashScope': 'Qwen · DashScope', '豆包 · 火山方舟': 'Doubao · Volcengine Ark', '阶跃 · StepFun': 'StepFun',
    '混元 · Hunyuan': 'Hunyuan', '硅基流动': 'SiliconFlow', '日日新': 'SenseNova', '基元律动': 'Jiyuan',
    '生成图像 POST': 'Image generation POST', '编辑图片 POST': 'Image editing POST', '生成视频 POST': 'Video generation POST',
    '自定义模型 ID': 'Custom model ID', '测试连接': 'Test connection', '返回模型': 'Returned models',
    '以下为API返回的全部模型': 'All models returned by the API', '完成': 'Finish', '添加壁纸': 'Add wallpaper',
    '选择添加照片': 'Choose photo', '填写壁纸昵称': 'Wallpaper name', '确认操作': 'Confirm action', '可用模型': 'Available models',
    '允许任意主模型读取和理解图像内容，实现完全多模态': 'Let any primary model read and understand images for full multimodality',
    '中': 'Medium', '配置当前主模型与推理强度。': 'Configure the primary model and reasoning strength.', '选择当前配置下所有模型之一': 'Choose one of the models in the current configuration', '推理强度': 'Reasoning strength', '已安装的 Skill': 'Installed Skills', 'Model：No model selected · 推理强度：中': 'Model: No model selected · Reasoning strength: Medium', '当前Model No model selected，推理强度 中，点击切换': 'Current model: No model selected, reasoning strength: Medium. Select to switch', 'Model：No model selected · Reasoning strength：中': 'Model: No model selected · Reasoning strength: Medium', '当前Model No model selected，Reasoning strength 中，点击切换': 'Current model: No model selected, reasoning strength: Medium. Select to switch',
    '使用文档': 'User guide', '查看说明': 'View guide', '当前支持': 'Supported providers', '教学文档': 'Tutorial',
    '启用视觉中继': 'Enable vision relay', '启用或关闭视觉中继': 'Enable or disable vision relay', 'Z 可能把支持多模态的主模型误判为不支持，所以将决定权还给你：关闭后图片将直接发给主模型。': 'Z may misclassify a multimodal primary model as text-only, so the choice is yours: when the relay is off, images go straight to the primary model.',
    '检查配置状态': 'Check configuration', '视觉中继使用说明': 'Vision relay guide', '只读说明，按页查看。': 'Read-only guide. View it page by page.',
    '外观与语言': 'Appearance and language', '主题': 'Theme', '选择 Z 的界面外观': 'Choose the Z appearance',
    '语言': 'Language', '选择 Z 的界面语言': 'Choose the Z interface language', '中文': 'Chinese',
    '正文字体': 'Body font', 'Agent 输出与长文阅读使用的字体，不喜欢宋体观感可切换': 'Font used for Agent output and long-form reading; switch it if you dislike the serif look',
    '衬线': 'Serif', '无衬线': 'Sans-serif',
    '用户名': 'Username', '让 Z 记住你的名字': 'Let Z remember your name', '权限': 'Permissions',
    '上下文': 'Context', '最大上下文与压缩': 'Maximum context and compaction',
    '不同模型最大上下文与压缩阈值不同，请手动配置': 'Maximum context and compaction thresholds vary by model. Configure them manually.',
    '配置上下文': 'Configure context', '按当前环境的模型能力手动设置。': 'Set values manually for the current environment and model capabilities.',
    '最大上下文': 'Maximum context', '设置当前环境最大上下文长度': 'Set the maximum context length for the current environment',
    '压缩阈值': 'Compaction threshold', '设置当前环境的压缩阈值': 'Set the compaction threshold for the current environment',
    '关闭上下文配置': 'Close context settings', '请输入有效的最大上下文长度': 'Enter a valid maximum context length',
    '请输入有效的压缩阈值': 'Enter a valid compaction threshold', '压缩阈值必须小于最大上下文': 'The compaction threshold must be lower than the maximum context',
    '正在保存上下文配置': 'Saving context settings', '上下文配置已保存': 'Context settings saved', '上下文配置保存失败': 'Failed to save context settings',
    '读取文件': 'Read files', '允许读取工作区与上传的文件': 'Allow reading workspace and uploaded files',
    '写入文件': 'Write files', '允许创建或修改文件': 'Allow creating or modifying files', '执行命令': 'Run commands',
    '允许运行 Shell 命令（谨慎）': 'Allow running shell commands (careful)', '网络访问': 'Network access', '允许调用外部 API': 'Allow calling external APIs',
    '应用': 'Application', '显示桌宠': 'Show desktop pet', '在桌面显示 Z 宠物窗口': 'Show the Z pet window on the desktop',
    '快速启动': 'Quick launch', '在其他软件或桌面上直接呼出快速输入': 'Open quick input from other apps or the desktop',
    '子代理': 'Subagents', '选择本轮可以参与协作的角色': 'Choose roles that can collaborate this turn',
    '定位文件、符号与工作区事实': 'Locate files, symbols, and workspace facts', '审阅实现并指出具体风险': 'Review implementation and identify concrete risks',
    '查阅文档、资料与外部来源': 'Read docs, references, and external sources', '运行非变更测试与诊断': 'Run non-mutating tests and diagnostics',
    '壁纸市场': 'Wallpaper market', '不透明度': 'Opacity', '剑与樱': 'Sword and Sakura', '中式园林': 'Chinese Garden',
    '月之暗面': 'Dark Side of the Moon', '侧脸回眸': 'Looking Back', '幽邃山洞': 'Deep Cave', '自定义壁纸': 'Custom wallpaper',
    '选择 JPG / PNG': 'Choose JPG / PNG',
    '任务名称': 'Task name', '保存': 'Save', '删除': 'Delete', '有什么我可以帮你的吗？': 'What can I help you with?', '输入需求': 'Enter a request', '提交需求': 'Submit request',
    '正文朗读': 'Read aloud', '朗读音色': 'Reading voice', '朗读语速': 'Reading speed', '语速': 'Speed', '试听': 'Preview', '试听失败': 'Preview failed', '朗读': 'Read aloud',
    '选择朗读音色': 'Choose reading voice',
    '晓晓 · 女声温柔': 'Xiaoxiao · warm female', '晓伊 · 女声活泼': 'Xiaoyi · lively female', '云希 · 男声阳光': 'Yunxi · sunny male', '云健 · 男声沉稳': 'Yunjian · steady male', '云扬 · 男声播报': 'Yunyang · news male', '云夏 · 男声少年': 'Yunxia · youthful male', '晓北 · 女声东北': 'Xiaobei · Northeastern female', '晓妮 · 女声陕西': 'Xiaoni · Shaanxi female',
    '这条消息没有可朗读的正文': 'This message has no readable text', '朗读失败': 'Read-aloud failed', '朗读音色已更新': 'Reading voice updated', '朗读音色保存失败': 'Failed to save reading voice', '语速保存失败': 'Failed to save reading speed',
    '删除任务？': 'Delete task?', '删除任务': 'Delete task', '移除工作区？': 'Remove workspace?', '移除工作区': 'Remove workspace',
    '删除 Skill？': 'Delete Skill?', '删除 Skill': 'Delete Skill',
    'Z': 'Z', 'Z Kernel（基于 OpenCode 二次开发）': 'Z Kernel (based on OpenCode)',
    '工作区与目标模式': 'Workspaces and goal mode', 'Skill、MCP 与浏览器': 'Skills, MCP, and Browser',
    '多模态与可靠交付': 'Multimodality and reliable delivery', '记忆、设置与生态': 'Memory, settings, and ecosystem',
    '版本信息与本次更新': 'Version and release notes', 'v1.4.0 完整更新': 'v1.4.0 complete update',
    '已处理': 'Handled', '回包中': 'Replying', '回包时间': 'Reply time', '回复时间': 'Response time', '缓存命中': 'Cache hit', '缓存命中显示': 'Cache-hit display',
    '撤销': 'Undo', '本轮改动已撤销': 'Changes from this run have been undone',
    '工作中': 'Working', '处理中': 'Processing', '运行失败': 'Run failed', '已暂停': 'Paused', '任务已中断': 'Task interrupted', 'Z Kernel 已完成执行并返回真实会话结果。': 'Z Kernel completed execution and returned the real session result.', '等待你的回答': 'Waiting for your answer', '等待操作权限': 'Waiting for permission',
    '操作权限等待确认': 'Awaiting operation permission', '任务已完成': 'Task completed', '任务已停止': 'Task stopped', '任务出现异常': 'Task failed',
    '加载中': 'Loading', '检查中': 'Checking', '测试中': 'Testing', '测试失败': 'Test failed', '连接失败': 'Connection failed',
    '连接成功': 'Connection successful', '保存失败': 'Save failed', '操作失败': 'Operation failed', '下载图片': 'Download image', '正在加载图片…': 'Loading image…', 'Agent 生成的图片': 'Image generated by Agent', '无法读取会话图片': 'Unable to read session image', '会话图片已失效': 'Session image is no longer available', '图片数据无法解码': 'Image data could not be decoded', '正在选择保存位置…': 'Choosing save location…', '下载失败': 'Download failed', '图片加载失败': 'Image loading failed', '暂无对话 · 点击上方开始': 'No conversations · click above to start', '本轮缓存读取': 'Cache read this run', '输入总量': 'Total input', '输入': 'Input', '输出': 'Output', '新增': 'Added', '已编辑': 'Edited', '已撤销': 'Reverted', '已删除': 'Deleted', '未知': 'Unknown', '在审阅面板中查看': 'View in Review panel', '正在压缩上下文': 'Compacting context', '上下文压缩已完成': 'Context compaction completed', '正在验收目标': 'Validating goal', '已修复问题，准备再次验收': 'Issue fixed; preparing another validation', '验收通过，正在完成回复': 'Validation passed; finishing reply', '验收未通过': 'Validation failed', '正在读取图片': 'Reading image', '正在切换读图模型': 'Switching vision model', '思考推理': 'Reasoning', '正在恢复模型工具调用': 'Restoring model tool call', '子代理数量已达上限': 'Subagent limit reached', '子代理正在生成回复': 'Subagent is generating a reply', '子代理正在思考': 'Subagent is thinking', '任务出现异常': 'Task failed', '内核事件流出现异常': 'Kernel event stream failed', '正在收尾': 'Finalizing', '等待用户回答': 'Waiting for user answer', '模型请求重试': 'Retrying model request', '问题拒绝': 'Question denied', '问题回复': 'Question answered', '任务等待用户选择工作区。': 'Task is waiting for a workspace selection.',
    '没有匹配的 Skill': 'No matching Skills', '正在读取 Skill': 'Reading Skill', '未能读取 Skill': 'Unable to read Skill',
    '重新加载': 'Reload', '代码已复制': 'Code copied', '复制失败': 'Copy failed',
    '已撤回，可编辑后重发': 'Withdrawn; edit and resend', '已中断': 'Interrupted', '权限确认': 'Permission required',
    '上一步': 'Previous', '不回答': 'Skip', '跳过': 'Skip', '发送回答': 'Send answer', '下一题': 'Next question', '上一题': 'Previous question', '关闭问题': 'Close question', '其他回答': 'Other answer', '你的回答': 'Your answer', '自拟回答': 'Custom answer', '告诉 Z 你的想法': 'Tell Z what you have in mind', '请输入你的回答': 'Enter your answer', '否，并告诉 Z 应该如何做不同': 'No, and tell Z how it should be different',
    '请先选择工作区': 'Select a workspace first', '未知错误': 'Unknown error', '未配置': 'Not configured', '尚未配置对应连接': 'No corresponding connection configured', '当前不可用': 'Unavailable',
    '官方': 'Official', '国内': 'China', '国际': 'International', '连接': 'Connection', '模型': 'Model', '供应商': 'Provider', '和': 'and', 'Z正在操控你的电脑，按Esc退出': 'Z is controlling your computer. Press Esc to exit',
    '项目': 'Projects', '娱乐桌宠': 'Entertainment pet', '当前工作区没有可用分支': 'No branches available in the current workspace', '未设置工作区': 'Workspace not set',
    '先为当前任务选择一个文件夹。': 'Choose a folder for this task first.', '深色模式': 'Dark mode',
    'Z Prompt Optimizer正在优化你的输入，按Ctrl+Z以回退优化': 'Z Prompt Optimizer is refining your input. Press Ctrl+Z to revert.',
    '启用': 'Enable', '停用': 'Disable', '默认': 'Default', '可选': 'Optional', '标准': 'Standard', '目标模式': 'Goal mode',
    '随时待命': 'Standing by', '推理速度': 'Reasoning speed', '未选择模型': 'No model selected',
    '上下文状态': 'Context status', '自动压缩阈值': 'automatic compaction threshold', '距离自动压缩还有': 'Compaction in',
    '已完成': 'Completed', '尚未选择照片': 'No photo selected', '← 上一步': '← Previous',
    'glm（国内）': 'glm (China)', 'sensenova（国内）': 'sensenova (China)', 'Agnes（国际）': 'Agnes (International)', '硅基流动（国内）': 'SiliconFlow (China)',
    '月薪猫': 'Monthly Cat', '大烧货': 'Big Burner', '准备一个 Skill JSON 文件，然后从资源管理器选择它。': 'Prepare a Skill JSON file, then choose it from Explorer.',
    '文件至少包含': 'Each file must include', '字段。导入后会出现在“个人”筛选中，也可以从输入框上方的“技能”调用。': 'fields. After import, it appears under the Personal filter and can be called from Skills above the composer.',
    '连接本地或远程工具，让 Agent 获得可验证的执行能力。': 'Connect local or remote tools so the Agent can perform verifiable actions.',
    '先给这个 MCP 服务起一个容易识别的名称。': 'Give this MCP service an easy-to-recognize name first.',
    '稍后可在服务注册表中识别它': 'It will be identifiable in the service registry later',
    '填写可在本机终端中运行的命令': 'Enter a command that can run in the local terminal',
    '可留空；多个参数用空格分隔，路径含空格时使用引号': 'Optional; separate multiple arguments with spaces and quote paths containing spaces',
    '选择目标分支并处理当前工作区的更改。': 'Choose a target branch and handle the current workspace changes.',
    '自建任意数量的 API 连接。填写名称、Base URL 和 API Key，一键测试并拉取模型列表。': 'Create any number of API connections. Enter a name, Base URL, and API key, then test and fetch models in one click.',
    '先选择一个已配置连接，再选择模型。': 'Choose a configured connection first, then choose a model.',
    '仅显示含生成图像模型的 API 连接。': 'Only show API connections with image-generation models.',
    '默认可选择“不选择”，用于取消当前模型。': 'Choose Not selected by default to clear the current model.',
    '一页一项，按步填写；随时可测试或保存。': 'One item per page. Follow the steps and test or save at any time.',
    '给这条连接起一个名字，例如 DeepSeek 官方、我的中转站。': 'Give this connection a name, for example DeepSeek Official or My Relay.',
    '默认按名称和 URL 自动识别接口形状；不对时手动指定。': 'The interface shape is detected from the name and URL by default; choose one manually if needed.',
    'OpenAI 兼容网关、官方 API 或中转站均可。': 'An OpenAI-compatible gateway, official API, or relay all work.',
    '请妥善保管你的API key，Z不会泄露它': 'Keep your API key safe. Z will not disclose it.',
    '自定义生图端点；留空按预设形状从 Base URL 推导。': 'Custom image-generation endpoint; leave blank to derive it from Base URL.',
    '图片编辑端点；留空按预设形状推导。': 'Image-editing endpoint; leave blank to derive it from the preset.',
    '生视频端点；留空按预设形状推导。': 'Video-generation endpoint; leave blank to derive it from the preset.',
    '目录接口拉不到模型时手填；随后测试连接验证。': 'Enter it manually when the catalog endpoint cannot return models, then test the connection.',
    '确认以下信息，按“完成”保存连接。': 'Review the information below and select Finish to save the connection.',
    '一页一项，保存后会保留在壁纸市场。': 'One item per page. It will remain in the wallpaper market after saving.',
    '支持 JPG 与 PNG 图片，保存后可在壁纸市场重复使用。': 'JPG and PNG images are supported and can be reused from the wallpaper market after saving.',
    '给这张壁纸起一个容易识别的名字。': 'Give this wallpaper an easy-to-recognize name.',
    '已配置厂商的模型会按用途归类显示。': 'Models from configured providers are grouped by purpose.',
    '关于视觉中继，你可以点击右侧“查看说明”': 'For vision relay details, select View guide on the right.',
    '在明确范围内编写代码并做轻量验收，最多 3 个并发槽位': 'Write code within the assigned scope and perform lightweight checks, with up to 3 concurrent slots.',
    'Z提供多种壁纸供你选择，也支持上传你喜欢的壁纸': 'Z provides wallpapers to choose from and supports uploading your own.',
    '删除后无法恢复该任务及其对话记录。': 'This task and its conversation cannot be restored after deletion.',
    '仅从左侧任务列表移除，不会删除本机文件或任务记录。': 'Remove it from the task list only; local files and task records will not be deleted.',
    '删除后 Agent 将无法继续调用它，需要重新安装才能恢复。': 'The Agent cannot call it after deletion; reinstall it to restore access.',
    'Agent 将不再为常规操作请求确认，并可使用绝对路径访问本机文件。仅在你完全信任当前任务、模型和工作区时开启。': 'The Agent will stop asking for routine-operation confirmation and can access local files by absolute path. Enable this only when you fully trust the task, model, and workspace.',
    '你在设置中关闭的文件读写与网络权限仍然生效；高风险系统命令仍会被拦截。': 'File, write, and network permissions disabled in Settings still apply; high-risk system commands remain blocked.'
    , '代码辅助': 'Code assistance', 'UI美化': 'UI polish', '网页设计': 'Web design', 'Agent规则': 'Agent rules', '办公辅助': 'Office assistance',
    '编写、理解、审阅与维护代码库': 'Write, understand, review, and maintain codebases',
    '减少错误假设、过度工程化和无关修改的编码 Agent 行为准则': 'Coding Agent guidance that reduces wrong assumptions, over-engineering, and unrelated changes',
    '简化并精炼代码：提升清晰度、一致性与可维护性，严格保持功能不变；默认聚焦最近改动': 'Simplify and refine code for clarity, consistency, and maintainability while preserving behavior; focus on recent changes by default',
    '以深模块、清晰接口和可测试边界设计或改善代码库结构': 'Design or improve codebase structure with deep modules, clear interfaces, and testable boundaries',
    '用本地增量代码图快速理解架构、依赖、调用链、符号关系与改动影响，减少反复搜索和通读文件': 'Use a local incremental code graph to understand architecture, dependencies, call chains, symbols, and change impact without repeated searching',
    '面向疑难故障与性能回退的证据化诊断循环，先定位根因再决定修复': 'Evidence-driven diagnosis for difficult failures and regressions: locate the root cause before fixing',
    '仅在用户明确选择时扫描整个仓库，按收益排序列出可删除、简化或替换的复杂度': 'Scan the entire repository only when selected, then rank complexity that can be removed, simplified, or replaced',
    '仅在用户明确选择时审阅当前差异中的过度设计，并给出可删除或替换项': 'Review over-engineering in the current diff only when selected and list removable or replaceable parts',
    '用 LSP 符号、引用、诊断与符号级编辑完成更小、更准确的代码修改': 'Use LSP symbols, references, diagnostics, and symbol edits for smaller, more accurate code changes',
    '用本地 CodeGraph 图谱浏览项目结构、文件职责、符号关系和影响范围': 'Browse project structure, file responsibilities, symbol relationships, and impact with the local CodeGraph',
    '动效、交互和界面质量提升': 'Motion, interaction, and interface quality',
    '高品质界面动效入口，按任务加载动画实现、动效审阅、机会发现或 Apple 交互模块': 'High-quality interface motion entry point for animation implementation, review, opportunity discovery, or Apple interaction modules',
    'GreenSock 官方 GSAP 动画套装入口，按任务只加载时间线、框架、滚动、插件或性能模块': 'Official GreenSock GSAP motion suite with task-scoped timeline, framework, scroll, plugin, and performance modules',
    'rdev Liquid Glass React 的本地实现参考与接入规则，按需读取源码，不自动安装依赖': 'Local implementation reference and integration rules for rdev Liquid Glass React; read source as needed without installing dependencies',
    '调用 Z 预装的 React Bits 组件库，为 React 界面加入可复用的文字、背景与交互动效': 'Use the preinstalled React Bits library to add reusable text, background, and interaction motion to React interfaces',
    '反模板的高质量前端设计入口，覆盖布局、排版、颜色、动效与视觉实现质量': 'Anti-template frontend design entry point covering layout, typography, color, motion, and visual quality',
    'NextLevelBuilder 的 UI/UX 设计智能数据库，覆盖样式、色彩、字体、UX 规范、动效、图表和 22 类技术栈': 'NextLevelBuilder UI/UX design intelligence database covering styles, colors, fonts, UX rules, motion, charts, and 22 technology stacks',
    '网页结构、视觉语言与组件实现': 'Web structure, visual language, and component implementation',
    '按品牌单项读取 74 套 DESIGN.md 视觉语言参考，避免把整库塞入上下文': 'Read 74 DESIGN.md visual-language references one brand at a time instead of loading the entire library',
    '调用 Z 预装的 Uiverse HTML/CSS 片段，为网页加入可直接落地的按钮、卡片、导航与页面区块': 'Use preinstalled Uiverse HTML/CSS snippets for production-ready buttons, cards, navigation, and page sections',
    '搜索、提示词与 Agent 工作规范': 'Search, prompts, and Agent operating rules',
    '通过统一搜索运行时完成实时检索、并行搜索与 URL 内容提取，为 Agent 提供可核验的外部信息': 'Use the unified search runtime for live and parallel search plus URL extraction, giving the Agent verifiable external information',
    '编写稳定、精确且节省上下文的 Skill、AGENTS.md 与 Agent 指令文档': 'Write stable, precise, context-efficient Skills, AGENTS.md files, and Agent instructions',
    '在不扩张意图与任务范围的前提下，让用户 Prompt 更清晰、更可执行': 'Make user prompts clearer and more executable without expanding intent or scope',
    '文档、演示、图表与媒体制作': 'Documents, presentations, charts, and media',
    '用 HTML、CSS 与 GSAP 创建、检查、预览并渲染视频，支持字幕、配音、音频响应和网站转视频': 'Create, inspect, preview, and render videos with HTML, CSS, and GSAP, including captions, voiceover, audio response, and site capture',
    '创建/编辑 Word、Excel、PowerPoint（.docx/.xlsx/.pptx），本地 CLI，无需安装 Office': 'Create and edit Word, Excel, and PowerPoint files locally with CLI tools; Office is not required',
    '用 React 程序化生成视频，覆盖动画、音频、字幕、图表、3D、转场与渲染': 'Programmatically create videos with React, including animation, audio, captions, charts, 3D, transitions, and rendering',
    '内置': 'Built-in', '内置 · 系统托管': 'Built-in · system-managed',
    '隔离式网页自动化与端到端测试。Z 内置浏览器无法满足脚本化测试需求时再使用。': 'Isolated web automation and end-to-end testing. Use only when the built-in Z Browser is insufficient for scripted tests.',
    '为当前工作区建立代码图并执行结构化代码检索与理解。': 'Build a code graph for the current workspace and perform structured code search and understanding.',
    '以 LSP 符号、引用、诊断和符号级编辑完成精确的代码定位与修改。': 'Use LSP symbols, references, diagnostics, and symbol edits for precise code location and changes.',
    '通过视觉中继读取本地或历史生成图片，并调用当前会话选定的生图与生视频次模型。': 'Read local or previously generated images through vision relay and call the image/video models selected for this session.',
    '由 Z Kernel 按当前会话配置托管': 'Managed by Z Kernel using the current session configuration',
    '查找、安装、列出、读取和删除 Z 的 Skill；未选择工作区时也可使用。': 'Find, install, list, read, and remove Z Skills, including when no workspace is selected.',
    '控制 Z 右侧可见的内置浏览器，用于网页阅读、交互与视觉验收。': 'Control the built-in browser in the right panel for web reading, interaction, and visual verification.',
    '在用户明确授权后进入另一工作区的最新 Z 任务；目标工作区没有任务时才创建并交接上下文。': 'After explicit authorization, enter the latest Z task in another workspace; create and hand off context only when none exists.',
    '将重复失败、可复用策略或子智能体角色排队，在本轮完成后进行证据化演进；运行中不会改写当前提示。': 'Queue repeated failures, reusable tactics, or subagent roles for evidence-based refinement after this turn; never rewrite the current prompt while running.',
    '文本': 'Text', '暂无已配置的文本模型': 'No configured text models', '生图': 'Image generation', '暂无已配置的生图模型': 'No configured image models',
    '生视频': 'Video generation', '暂无已配置的生视频模型': 'No configured video models', '主题、语言、权限等基础设置': 'Basic theme, language, and permission settings',
    '模型厂商、凭据与兼容端点': 'Model providers, credentials, and compatible endpoints', '选择当前任务默认使用的模型': 'Choose the default model for the current task', 'API 配置': 'API settings',
    '切换侧边栏 (Ctrl+B)': 'Toggle sidebar (Ctrl+B)', '切换侧边栏': 'Toggle sidebar', 'Z 工作区视图': 'Z workspace view', '最小化': 'Minimize', '最大化': 'Maximize', '关闭': 'Close',
    '项目视图操作': 'Project view actions', '折叠所有工作区': 'Collapse all workspaces', '未选择工作区': 'No workspace selected', '工作区操作': 'Workspace actions', '任务操作': 'Task actions',
    '打开设置': 'Open settings', '打开桌宠': 'Open pet', '切换浅色模式': 'Switch to light mode', '进入设置页面': 'Open Settings page', '用户设置': 'User settings',
    '选择工作区文件夹': 'Choose workspace folder', '切换 Git 分支': 'Switch Git branch', 'Git 分支': 'Git branch', '刷新 Git 状态': 'Refresh Git status',
    '打开工作区工具 · 终端': 'Open workspace tool · Terminal', '选择工作区工具': 'Choose workspace tool', '工作区工具': 'Workspace tools',
    '在 VS Code 中打开当前工作区': 'Open the current workspace in VS Code', '打开终端': 'Open terminal', '在文件资源管理器中打开': 'Open in File Explorer', '双击重命名任务': 'Double-click to rename task',
    '随时待命，单击展开输入框': 'Standing by; click to expand composer', '展开输入框': 'Expand composer', '对话回合导航': 'Conversation turn navigation', '查看任务待办': 'View task todos', '任务待办': 'Task todos',
    '添加内容': 'Add content', '打开添加面板': 'Open add menu', '添加文件、工作方式或 Skill': 'Add a file, work mode, or Skill', '权限访问：请求批准': 'Permission access: approval required', '当前为常规模式': 'Current mode: General',
    '模型：未选择模型 · 推理速度：标准': 'Model: No model selected · Reasoning speed: Standard', '当前模型 未选择模型，推理速度 标准，点击切换': 'Current model: No model selected, reasoning speed: Standard; click to switch', '模型与推理速度选择': 'Model and reasoning speed selection', '展开模型选择': 'Expand model selection', '返回推理速度滑块': 'Back to reasoning speed', '返回模型选择': 'Back to model selection', '发送': 'Send', '排队对话': 'Queued message', '编辑排队对话': 'Edit queued message', '删除排队对话': 'Delete queued message', '排队发送': 'Queue message', '更新排队对话': 'Update queued message',
    '添加与插件': 'Add-ons and plugins', '选择 Skill': 'Choose Skill', '消息输入': 'Message input', '将输入框收至底部': 'Dock composer at bottom', 'Z · 项目地图': 'Z · Project map',
    'Skill 市场筛选工具': 'Skill market filters', '搜索 Skill': 'Search Skills', '搜索名称、说明或 ID': 'Search name, description, or ID', 'Skill 分类': 'Skill categories', '创建个人 Skill': 'Create personal Skill', 'Skill 功能分组': 'Skill capability groups', '设置页固定显示侧边栏': 'Keep the sidebar fixed on the Settings page', 'Settings页固定显示侧边栏': 'Keep the sidebar fixed on the Settings page',
    '快捷工具': 'Quick tools', '搜索分支': 'Search branches', '打开 Git 工具': 'Open Git tools', '切换到深色主题': 'Switch to dark theme', '切换到浅色主题': 'Switch to light theme', '关闭桌宠': 'Close pet', '关闭设置': 'Close settings', '打开右侧面板': 'Open right panel', '关闭右侧面板': 'Close right panel', '查看全部': 'View all', '搜索': 'Search', '选择文件夹': 'Choose folder', '选择工作区': 'Choose workspace',
    '关闭添加 Skill 弹窗': 'Close Add Skill dialog', '添加所选 Skill': 'Add selected Skill', '关闭添加服务器弹窗': 'Close Add Server dialog',
    '例如 Playwright': 'For example, Playwright', '例如 npx 或 uvx': 'For example, npx or uvx', '例如 -y @playwright/mcp@latest': 'For example, -y @playwright/mcp@latest',
    '右侧面板标签页': 'Right-panel tabs', '新建标签页': 'New tab', '新建右侧面板标签页': 'New right-panel tab', '全屏显示右侧面板': 'Show right panel full screen', '打开右侧工具': 'Open right-panel tools',
    '打开审阅': 'Open Review', '打开浏览器': 'Open Browser', '打开临时对话': 'Open temporary chat', '关闭侧边面板': 'Close side panel', '侧边面板工具': 'Side panel tools', '刷新审阅': 'Refresh Review', '改动文件': 'Changed files', '文件差异': 'File diff', '行级差异': 'Line diff',
    '辅助对话内容': 'Auxiliary chat content', '临时对话内容': 'Temporary chat content', '当前任务未在工作': 'Current task is not running', '关闭 Git 弹窗': 'Close Git dialog', '关闭提交弹窗': 'Close Commit dialog',
    '留空将自动生成': 'Leave blank to generate automatically', '智能生成提交信息': 'Generate commit message with AI', '刷新 Git 图谱': 'Refresh Git graph', '上下文 token 使用率': 'Context token usage', '设置分类': 'Settings categories',
    '生成图像模型，当前未选择': 'Image generation model, currently not selected', '生成视频模型，当前未选择': 'Video generation model, currently not selected',
    '关闭连接配置': 'Close connection settings', '显示 API Key': 'Show API key', '例如 deepseek-chat': 'For example, deepseek-chat', '测试连接并拉取模型目录': 'Test connection and fetch model catalog',
    '壁纸昵称': 'Wallpaper nickname', '关闭视觉中继说明': 'Close vision relay guide', '让Z记住你的名字': 'Let Z remember your name',
    '允许读取文件': 'Allow reading files', '允许写入文件': 'Allow writing files', '允许执行命令': 'Allow running commands', '允许网络访问': 'Allow network access', '选择桌宠': 'Choose desktop pet',
    '修改快速启动快捷键': 'Change Quick launch shortcut', '删除壁纸': 'Delete wallpaper',
    '材质强度': 'Material strength',
    '例如：爽快': 'For example: Direct', '例如：没素质，爽快': 'For example: Blunt and direct',
    'A：任务期间请勿随意更改模型配置': 'A: Do not change model configuration during a task',
    '深度求索中……': 'Deep Diving……',
    '健康': 'Health', '本地健康管理，数据只保存在本机': 'Local health tracking. Data stays on this device.',
    '今日概览': "Today's overview", '快速记录': 'Quick log', '日期': 'Date', '7 天趋势': '7-day trend',
    '饮水': 'Water', '睡眠': 'Sleep', '体重': 'Weight', '运动': 'Exercise', '心情': 'Mood', '目标': 'Goals',
    '饮食': 'Meals', '备注': 'Note',
    '保存目标': 'Save goals', '导出数据': 'Export data', '记录': 'Save', '添加': 'Add', '保存': 'Save',
    '很差': 'Awful', '较差': 'Poor', '一般': 'Okay', '不错': 'Good', '很好': 'Great',
    '清空今日': 'Clear today', '确定清空今天的记录？': "Clear today's records?",
    '还没有记录，从下面记第一笔开始': 'No records yet. Start with a quick log below.',
    '也可以直接对 Agent 说：记录我今天喝了 500ml 水': 'You can also tell the Agent: log 500ml of water for today',
    '数据目录': 'Data folder', '加载中……': 'Loading…', '已记录': 'Saved', '已导出数据': 'Exported',
    '目标已更新': 'Goals updated', '操作失败': 'Action failed', '请输入有效数值': 'Enter a valid number',
    '例如：燕麦粥 + 鸡蛋': 'e.g. oatmeal + eggs', '今天身体感觉如何': 'How does your body feel today',
    '周日': 'Sun', '周一': 'Mon', '周二': 'Tue', '周三': 'Wed', '周四': 'Thu', '周五': 'Fri', '周六': 'Sat',
    '点击左侧边栏': 'Click', '查看引导': 'in the left sidebar to open the guide',
    '观察者': 'Observer', '观察者运行情况': 'Observer activity', '观察者 / 运行状态': 'Observer / Activity',
    'Z 正在操作浏览器': 'Z is using the browser', '项目地图需要当前任务工作区。': 'Project map requires a workspace for the current task.',
    'Z 媒体': 'Z Media', 'Z 技能': 'Z Skills', 'Z 内置浏览器': 'Z Browser', 'Z 网页读取': 'Z Web Fetch',
    'Z 会话': 'Z Sessions', 'Z 持续改进': 'Z Continuous Improvement', 'Z 项目分析': 'Z Project Analysis',
    'Z 工作区': 'Z Workspace', 'Z 内核': 'Z Kernel', '打开 Z': 'Open Z', '退出 Z': 'Quit Z',
    '调用当前会话选定的图像与视频模型，并维护可继续修改的媒体上下文。': 'Use the image and video models selected for this session and maintain media context for further edits.',
    'Z 内置浏览器连接失败。': 'Z could not connect to the built-in browser.',
    '内置浏览器操作已取消。': 'The built-in browser action was cancelled.',
    'Z 主窗口尚未就绪，无法控制内置浏览器。': 'The Z main window is not ready to control the built-in browser.',
    '内置浏览器操作超时。': 'The built-in browser action timed out.',
    'Z 正在退出，内置浏览器操作已终止。': 'Z is closing. The built-in browser action has stopped.',
    'Z 主窗口尚未就绪。': 'The Z main window is not ready.',
    '当前任务没有关联的 Z 对话。': 'This task has no associated Z conversation.',
    'Z 已找到目标工作区现有的最新任务；当前回答结束后界面会自动返回该任务。': 'Z found the latest task in the target workspace. The interface will return to it after this reply.',
    'Z 已创建新的任务并完成上下文交接；当前回答结束后界面会自动进入新任务。': 'Z created a task and handed off the context. The interface will open the task after this reply.',
    'Z 正在退出，会话操作已终止。': 'Z is closing. The conversation action has stopped.',
    '只能编辑 Z 保存的图片附件': 'Only image attachments saved by Z can be edited',
    'Z 内核只能启动文本或工具模型。': 'Z Kernel can only start text or tool models.',
    'Z 任务引擎尚未初始化。': 'The Z task engine has not been initialized.',
    '任务回合不存在。': 'The task turn does not exist.',
    '排队请求不存在或已处理。': 'The queued request does not exist or has already been handled.',
    '排队请求不存在。': 'The queued request does not exist.',
    '排队请求不存在或无法确认。': 'The queued request does not exist or cannot be acknowledged.',
    'Z 任务不存在': 'The Z task does not exist',
    '计划文件不在 Z 的计划目录内。': 'The plan file is outside the Z plans directory.',
    'Z 内核尚未运行': 'Z Kernel is not running', 'Z 内核启动失败': 'Z Kernel failed to start',
    'Z Kernel 未返回成功结果': 'Z Kernel did not return a successful result',
    'Z Kernel 已完成执行并返回真实会话结果。': 'Z Kernel finished execution and returned the session result.',
    'Z Kernel 启动失败': 'Z Kernel failed to start', 'Z Prompt Optimizer 未正确安装': 'Z Prompt Optimizer is not installed correctly',
    '项目地图': 'Project map', '可视工作区': 'Visual workspace', '个人工作台': 'Personal workspace',
    '认识 Z': 'Meet Z', '少一点绕路，多一点完成。': 'Less circling, more finishing.',
    '你的目标是起点，清晰的过程是方向。': 'Your goal sets the destination. A clear process keeps you on track.',
    '遇到问题，从这里排查': 'Start troubleshooting here',
    '连接、工具、上下文与观察者状态的常见问题，都有下一步说明。': 'Find the next step for common connection, tool, context, and Observer issues.',
    'Z 的这次更新': 'What is new in Z', '新的工作台、使用引导与观察者面板。': 'The new workspace, user guide, and Observer panel.',
    '看看新变化': 'See what changed', '开始你的第一件事': 'Start your first task',
    '连接模型后即可开始。Z 会自动准备任务文件夹，也支持选择已有项目。': 'Connect a model and start. Z prepares a task folder automatically; you can also choose an existing project.',
    '任务文件夹': 'Task folder', '自动任务文件夹': 'Automatic task folder',
    '使用自动任务文件夹': 'Use automatic task folder', '已使用自动任务文件夹': 'Using the automatic task folder',
    '已自动准备任务文件夹，也可以选择项目文件夹': 'A task folder is ready. You can also choose a project folder.',
    '打开使用指南': 'Open the user guide', '当前版本': 'Current version', 'Z · v1.6.1 · 本机工作台': 'Z · v1.6.1 · Local workspace',
    '本地版本': 'Local version', '从实际现象出发，找到下一步的处理方法。': 'Start with what happened and find your next step.',
    '第一次使用 Z？': 'New to Z?', '从这里开始': 'Start here',
    '从一个想法到一次完成。专注创造，让过程清晰可见。': 'From an idea to a finished task. Focus on creating with a clear view of the process.',
    '查看观察者运行情况': 'View Observer activity', '了解观察者如何工作': 'See how Observer works',
    '下一步，交给 Z。': 'Your next step, with Z.', '实时': 'Live', '历史': 'History', '待命': 'Ready',
    '随时准备观察': 'Ready to observe', '等待观察者状态': 'Waiting for Observer status', '等待更多动作': 'Waiting for more actions',
    '正在观察执行过程': 'Observing the work', '本轮未启用观察者': 'Observer is disabled for this run',
    '本轮观察已结束': 'Observation completed', '观察已停止': 'Observation stopped',
    '观察者运行异常': 'Observer error', '任务运行出现异常': 'Task execution error',
    '此轮没有监控记录': 'No monitoring data for this run', '检测轮次': 'Checks', '会话动作': 'Session actions',
    '介入次数': 'Interventions', '最近判断': 'Latest check', '触发时间线': 'Trigger timeline',
    '尚未形成判断': 'No check yet', '最近检查没有触发新提醒': 'The latest check triggered no new reminder',
    '重复操作': 'Repeated actions', '探索趋于饱和': 'Exploration saturation', '策略长期未变': 'Stale strategy',
    '偏离任务目标': 'Goal drift', '验证结果需要更新': 'Verification needs refreshing',
    '建议': 'Advice', '提醒': 'Reminder', '升级提醒': 'Escalated reminder', '请求停止': 'Stop requested',
    '正在发送提醒': 'Sending reminder', '提醒已排队 · 等待模型接收': 'Queued · awaiting model receipt',
    '提醒已送达模型': 'Delivered to the model', '提醒发送失败': 'Reminder delivery failed',
    '送达状态未记录': 'Delivery status not recorded', '时间未记录': 'Time not recorded',
    '让每一步都有方向': 'Give every step a direction', '本轮尚无介入': 'No interventions in this run',
    '暂无可展示的提醒': 'No reminders to display',
    '观察者关注执行过程并发出提醒，不保证答案或解题结果正确。': 'Observer follows the process and sends reminders. It does not guarantee a correct answer or solution.',
    '开始一个任务，观察者会在这里展示真实的检查和提醒记录。': 'Start a task. Observer will show its actual checks and reminders here.',
    '任务刚刚开始，观察者正在积累可判断的操作记录。': 'The task has just started. Observer is gathering enough actions for a check.',
    '任务正在运行，尚未收到本轮的观察者数据。': 'The task is running. No Observer data has arrived for this run yet.',
    '此轮任务没有启用观察者，不会产生运行提醒。': 'Observer is disabled for this run and will not send reminders.',
    '观察者的检查过程出现异常，已有记录保留在下方。请结合任务消息查看详情。': 'Observer encountered an error during a check. Existing records remain below. Read the task messages for details.',
    '这段历史没有保存观察者数据，无法还原检测或介入次数。': 'This history has no saved Observer data, so check and intervention counts cannot be restored.',
    '观察者发现了需要关注的操作模式。': 'Observer found a pattern that needs attention.',
    '观察者在本轮保持关闭。': 'Observer remains disabled for this run.',
    '你专注目标，观察者留意过程。开始对话后，检查进度与触发原因会在这里逐步展开。': 'Focus on your goal while Observer follows the process. Start a conversation to see checks and reminder reasons here.',
    '目前没有触发观察者提醒。任务仍由模型正常执行。': 'Observer has not triggered any reminders. The model continues the task normally.',
    ...(global.ZProductContent?.translations || {})
  });
  const attributeFragments = Object.freeze(Object.keys(ZH_EN)
    .filter(key => key.length >= 2)
    .sort((a, b) => b.length - a.length));

  const textState = new WeakMap();
  const attrState = new WeakMap();
  let language = 'zh-CN';
  let applying = false;
  let observer = null;

  function normalize(value) {
    return String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh-CN';
  }

  function translate(value, target = language) {
    const source = String(value ?? '');
    if (normalize(target) !== 'en' || !/[\u3400-\u9fff]/u.test(source)) return source;
    const exact = ZH_EN[source.trim()];
    if (exact) return source.replace(source.trim(), exact);
    const modelChecks = source.match(/^模型检查 (\d+) 次$/u);
    if (modelChecks) return `Model reviews: ${modelChecks[1]}`;
    const modelPhase = source.match(/^(.+) · (等待动作|正在判断|已完成判断|规则模式继续工作|本轮已结束)$/u);
    if (modelPhase) return `${modelPhase[1]} · ${ZH_EN[modelPhase[2]]}`;
    const startupError = source.match(/^Z 无法启动本轮任务：([\s\S]*)$/u);
    if (startupError) return `Z could not start this task: ${translate(startupError[1], target)}`;
    const kernelError = source.match(/^Z 内核无法启动。\s*([\s\S]*)$/u);
    if (kernelError) return `Z Kernel could not start.\n\n${translate(kernelError[1], target)}`;
    const visualWorkspaceError = source.match(/^可视工作区任务(未能启动|失败)：([\s\S]*)$/u);
    if (visualWorkspaceError) return `${visualWorkspaceError[1] === '未能启动' ? 'The visual workspace task could not start' : 'The visual workspace task failed'}: ${translate(visualWorkspaceError[2], target)}`;
    const skillConflict = source.match(/^同名 Skill「(.+)」已由用户或外部来源安装，Z 不会覆盖它。$/u);
    if (skillConflict) return `The Skill “${skillConflict[1]}” was installed by you or another source. Z will not overwrite it.`;
    const context = source.match(/^上下文约\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*tokens（自动压缩阈值）$/u);
    if (context) return `Context ${context[1]} / ${context[2]} tokens (automatic compaction threshold)`;
    const remaining = source.match(/^距离自动压缩还有\s*(.+)$/u);
    if (remaining) return `Compaction in ${remaining[1]}`;
    const reachedLine = source.match(/^已达到自动压缩线\s*(.+)$/u);
    if (reachedLine) return `Compaction line ${reachedLine[1]} reached`;
    const beyondLine = source.match(/^已超过安全线\s*(.+)，下次请求会先压缩早期对话$/u);
    if (beyondLine) return `Beyond the safety line ${beyondLine[1]}; the next request compacts early turns first`;
    const replying = source.match(/^回包中\s*(.+)$/u);
    if (replying) return `Replying ${replying[1]}`;
    const handled = source.match(/^已处理\s*(.+)$/u);
    if (handled) return `Handled ${handled[1]}`;
    const response = source.match(/^回包时间\s*(.+)$/u);
    if (response) return `Reply time ${response[1]}`;
    const childTool = source.match(/^子代理正在执行\s*(.+)$/u);
    if (childTool) return `Subagent executing ${childTool[1]}`;
    const childStarted = source.match(/^(.+)已开始工作$/u);
    if (childStarted) return `${childStarted[1]} started working`;
    const completed = source.match(/^已完成\s*(\d+\/\d+)$/u);
    if (completed) return `Completed ${completed[1]}`;
    const todoProgress = source.match(/^第\s*(\d+\/\d+)\s*已完成$/u);
    if (todoProgress) return `Completed ${todoProgress[1]}`;
    const changed = source.match(/^(已编辑|已撤销)\s*(\d+)\s*个文件$/u);
    if (changed) return `${changed[1] === '已撤销' ? 'Reverted' : 'Edited'} ${changed[2]} file${changed[2] === '1' ? '' : 's'}`;
    const moreChangedFiles = source.match(/^(再显示|收起)\s*(\d+)\s*个文件$/u);
    if (moreChangedFiles) return `${moreChangedFiles[1] === '收起' ? 'Show fewer' : 'Show'} ${moreChangedFiles[2]} file${moreChangedFiles[2] === '1' ? '' : 's'}`;
    const changedLines = source.match(/^新增\s*(\d+)\s*行[，,]\s*删除\s*(\d+)\s*行$/u);
    if (changedLines) return `Added ${changedLines[1]} line${changedLines[1] === '1' ? '' : 's'}, deleted ${changedLines[2]} line${changedLines[2] === '1' ? '' : 's'}`;
    const files = source.match(/^(\d+)\s*个文件$/u);
    if (files) return `${files[1]} file${files[1] === '1' ? '' : 's'}`;
    return source;
  }

  function translateAttribute(value) {
    const source = String(value ?? '');
    const exact = translate(source);
    if (!/[\u3400-\u9fff]/u.test(exact)) return exact;
    const skillDetail = source.match(/^查看\s+(.+)\s+的 Skill 详情$/u);
    if (skillDetail) return `View ${skillDetail[1]} Skill details`;
    const skillInstalled = source.match(/^(.+)\s+已安装$/u);
    if (skillInstalled) return `${skillInstalled[1]} installed`;
    const rollbackRun = source.match(/^撤销本轮\s*(\d+)\s*个文件改动$/u);
    if (rollbackRun) return `Undo changes to ${rollbackRun[1]} file${rollbackRun[1] === '1' ? '' : 's'} from this run`;
    const mediaSelection = source.match(/^(生成图像模型选择|生成视频模型选择)[，,]\s*当前(.+)$/u);
    if (mediaSelection) return `${mediaSelection[1] === '生成图像模型选择' ? 'Image generation model' : 'Video generation model'}, current ${translate(mediaSelection[2]).trim()}`;
    const testConnection = source.match(/^测试\s+(.+)\s+连接$/u);
    if (testConnection) return `Test ${testConnection[1]} connection`;
    const relayCheck = source.match(/^检查(.+)配置状态，当前(.+)$/u);
    if (relayCheck) return `Check ${translate(relayCheck[1]).trim()} configuration, currently ${translate(relayCheck[2]).trim()}`;
    const deleteLabel = source.match(/^删除(.+)$/u);
    if (deleteLabel) return `Delete ${translate(deleteLabel[1]).trim()}`;
    let result = source;
    for (const key of attributeFragments) {
      if (result.includes(key)) result = result.split(key).join(ZH_EN[key]);
    }
    return result;
  }

  function shouldSkip(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.closest('script, style, noscript, pre, code, textarea, input, select')) return true;
    if (parent.closest('.msg.user .msg-body, .user-message, .agent-markdown, [data-preserve-language]')) return true;
    return false;
  }

  function applyText(node) {
    if (!node?.nodeValue || shouldSkip(node)) return;
    let record = textState.get(node);
    const current = node.nodeValue;
    if (!record || current !== record.translated) {
      record = { source: current, translated: current };
      textState.set(node, record);
    }
    const next = language === 'en' ? translate(record.source) : record.source;
    if (next !== current) {
      record.translated = next;
      applying = true;
      node.nodeValue = next;
      applying = false;
    } else {
      record.translated = current;
    }
  }

  function applyAttribute(element, name) {
    if (!element || element.closest?.('script, style, pre, code, [data-preserve-language]')) return;
    const value = element.getAttribute(name);
    if (value == null || !/[\u3400-\u9fff]/u.test(value)) return;
    let record = attrState.get(element);
    if (!record) { record = {}; attrState.set(element, record); }
    if (!record[name] || value !== record[name].translated) record[name] = { source: value, translated: value };
    const next = language === 'en' ? translateAttribute(record[name].source) : record[name].source;
    if (next !== value) {
      record[name].translated = next;
      applying = true;
      element.setAttribute(name, next);
      applying = false;
    } else record[name].translated = value;
  }

  function visit(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(applyText);
    const elements = root.nodeType === Node.ELEMENT_NODE ? [root, ...root.querySelectorAll('*')] : [...root.querySelectorAll('*')];
    elements.forEach(element => ['title', 'aria-label', 'placeholder', 'alt', 'data-placeholder'].forEach(name => applyAttribute(element, name)));
  }

  function apply(nextLanguage, root = document) {
    language = normalize(nextLanguage);
    visit(root);
    if (language === 'en' && !observer && root?.body) {
      observer = new MutationObserver(records => {
        if (applying) return;
        for (const record of records) {
          if (record.type === 'characterData') applyText(record.target);
          else record.addedNodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) applyText(node);
            else if (node.nodeType === Node.ELEMENT_NODE) visit(node);
          });
          if (record.type === 'attributes') applyAttribute(record.target, record.attributeName);
        }
      });
      observer.observe(root.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder', 'alt', 'data-placeholder'] });
    }
    if (language !== 'en' && observer) {
      observer.disconnect();
      observer = null;
    }
    return language;
  }

  global.YanI18n = Object.freeze({ apply, normalize, translate, dictionary: ZH_EN });
  const initialLanguage = new URLSearchParams(global.location?.search || '').get('lang');
  if (initialLanguage) {
    document.documentElement.lang = normalize(initialLanguage);
    document.documentElement.dataset.language = normalize(initialLanguage);
    if (document.body) apply(initialLanguage, document);
    else document.addEventListener('DOMContentLoaded', () => apply(initialLanguage, document), { once: true });
  }
})(window);
