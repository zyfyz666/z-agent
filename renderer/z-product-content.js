(function (root, factory) {
  'use strict';
  const content = factory();
  if (typeof module === 'object' && module.exports) module.exports = content;
  else root.ZProductContent = content;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const translations = {};
  const line = (zh, en) => { translations[zh] = en; return zh; };
  const guide = {
    title: line('Z 使用指南', 'Using Z'),
    subtitle: line('从一个清楚的目标开始，了解工作过程，再查看结果。', 'Start with a clear goal, follow the work, then review the result.'),
    pages: [
      {
        title: line('01 / 从目标开始', '01 / Start with a goal'),
        paragraphs: [line('把你想完成的事交给 Z。你可以先提问，也可以让它在选定的工作区中完成具体修改。', 'Tell Z what you want to accomplish. Ask a question, or request a concrete change in a selected workspace.')],
        bullets: [
          line('说明结果：你需要什么、涉及哪些文件、怎样算完成。', 'Describe the result: what you need, which files matter, and what completion means.'),
          line('补充边界：例如先调查、保留现有修改，或只改指定范围。', 'Add boundaries: investigate first, preserve existing changes, or edit only a specified area.'),
          line('可以这样开始：“先找出登录失败的原因，告诉我验证方法，再修复。”', 'Try: “Find why login fails, explain how to verify it, then fix it.”')
        ]
      },
      {
        title: line('02 / 连接你的模型', '02 / Connect your model'),
        paragraphs: [line('Z 使用你配置的模型服务。先建立连接，再选择当前任务使用的模型。', 'Z uses the model service you configure. Create a connection, then select a model for the current task.')],
        bullets: [
          line('进入「设置 → API 配置 → 新建连接」，填写服务地址、接口格式和 API Key。', 'Open Settings → API configuration → New connection, then enter the service URL, API format, and API key.'),
          line('使用「测试连接」检查配置；连接成功后，在输入框的模型按钮中选择模型。', 'Use Test connection to check the configuration, then select a model with the model button in the composer.'),
          line('调用内容会发送给你选择的服务，费用、额度和模型能力以该服务为准。', 'Requests are sent to your chosen service. Its pricing, quota, and model capabilities apply.')
        ]
      },
      {
        title: line('03 / 工作区与权限', '03 / Workspace and permissions'),
        paragraphs: [line('工作区决定任务处理哪个文件夹。权限决定哪些操作可以执行。', 'The workspace determines which folder the task works on. Permissions determine which actions can run.')],
        bullets: [
          line('代码修改前，使用任务栏的「选择工作区」指定项目文件夹。', 'Before requesting code changes, choose the project folder with Select workspace in the task bar.'),
          line('在输入框的权限控件中选择「请求批准」「替我审批」或「完全访问」，按任务需要设置。', 'Use the composer permission control to choose Approval requested, Approve for me, or Full access for the task.'),
          line('看到确认卡片时，先检查操作和目标，再决定允许或拒绝；已有文件修改仍需要你复核。', 'When an approval card appears, review the action and target before allowing or denying it. Review changes to existing files as well.')
        ]
      },
      {
        title: line('04 / 认识观察者', '04 / Meet Observer'),
        paragraphs: [line('「观察者」默认在右侧展开，展示当前任务真实产生的检测与提醒记录；你可以手动收起，再从左侧「观察者」打开。它关注重复操作、策略停滞和验证过期等执行模式。', 'Observer opens in the right panel by default to show actual checks and reminders from the current task. You can collapse it and reopen it from Observer in the sidebar. It looks for patterns such as repeated actions, stalled strategies, and stale verification.')],
        bullets: [
          line('检测轮次是实际检查次数，会话动作是观察到的动作数，介入次数是触发的提醒数。', 'Checks count actual evaluations, Session actions count observed actions, and Interventions count triggered reminders.'),
          line('「已排队」表示等待接收；「已送达」才确认提醒送达模型；发送失败会单独标出。', 'Queued means awaiting receipt. Delivered confirms the reminder reached the model. Delivery failures are shown separately.'),
          line('介入次数为 0 不代表答案正确。历史没有记录时显示未知，不能按 0 次解读；观察者异常也不等于主任务失败。', 'Zero interventions does not mean the answer is correct. Missing historical data is unknown, not zero. An Observer error does not necessarily mean the main task failed.')
        ]
      },
      {
        title: line('05 / 长任务与上下文', '05 / Long tasks and context'),
        paragraphs: [line('长任务需要同时关注模型进度和上下文占用。切换到其他对话后，正在运行的任务可以继续执行。', 'For long tasks, watch both model progress and context usage. A running task can continue while you switch to another conversation.')],
        bullets: [
          line('点击输入区附近的上下文圆环，查看用量、上限与压缩提示；没有服务端用量时可能使用估算。', 'Select the context ring near the composer to see usage, limits, and compaction hints. Usage may be estimated when the service does not report it.'),
          line('在「设置 → 常规 → 配置上下文」中，按实际模型能力设置窗口与压缩阈值。', 'Under Settings → General → Configure context, set the window and compaction threshold for the actual model.'),
          line('任务空闲时可以点击「我来压缩」。压缩会调用模型生成摘要，不能扩大模型本身的上下文上限。', 'When the task is idle, select Compact now. Compaction calls the model to create a summary; it cannot enlarge the model’s context limit.')
        ]
      },
      {
        title: line('06 / 查看改动与验证', '06 / Review changes and verification'),
        paragraphs: [line('任务回复是交付说明，文件变化和检查结果才是你复核工作的依据。', 'The task reply describes the delivery. File changes and check results provide the evidence for your review.')],
        bullets: [
          line('从任务的改动入口或右侧「审阅」查看文件差异，核对是否符合你的目标与范围。', 'Open task changes or Review in the right panel to inspect file differences against your goal and scope.'),
          line('区分“运行了检查”和“检查通过”。关注失败信息、未验证部分以及环境限制。', 'Distinguish running a check from passing it. Read failures, unverified areas, and environment limitations.'),
          line('不满意时指出具体文件或行为，要求 Z 继续处理；提交或推送前再核对内容。', 'If something is wrong, identify the file or behavior and ask Z to continue. Review the changes again before committing or pushing.')
        ]
      },
      {
        title: line('07 / 你的工作台', '07 / Your workspace'),
        paragraphs: [line('用对话推进任务，用观察栏理解过程，用审阅确认结果。', 'Move the task forward in chat, understand its progress in the monitor, and confirm the result in Review.')],
        bullets: [
          line('左侧保留任务列表、观察者、技能与 MCP 入口。观察者默认展开，右侧面板可以按需打开或手动收起。', 'The sidebar keeps tasks, Observer, Skills, and MCP within reach. Observer opens by default; open or collapse right-side panels as needed.'),
          line('在「设置 → 常规」调整姓名、主题、语言和正文字体；已有会话保持独立保存。', 'Adjust your name, theme, language, and reading font under Settings → General. Conversations remain saved separately.'),
          line('随时点击「引导」重看这七页；遇到问题，打开「设置 → 关于 → 常见报错」查看本地说明。', 'Select Guide anytime to revisit these seven pages. For help, open Settings → About → Common errors.')
        ]
      }
    ]
  };
  const releaseNotes = {
    title: line('Z 更新说明', 'Z release notes'),
    subtitle: line('2026.10.04 · 界面与运行观察', '2026.10.04 · Interface and runtime monitoring'),
    pages: [
      {
        title: line('新的 Z 工作台', 'The Z workspace'),
        paragraphs: [line('本次更新整理 Z 的名称、图标、欢迎页和帮助内容，让入口与说明围绕当前产品保持一致。', 'This update aligns the Z name, icon, welcome screen, and help content around the current product.')],
        bullets: [line('欢迎页支持个性化姓名，上手引导改为七页。', 'The welcome screen supports your chosen name, with a new seven-page guide.'), line('帮助与更新说明可在本机阅读，不需要跳转到外部网站。', 'Help and release notes can be read locally without visiting an external website.')]
      },
      {
        title: line('观察者让运行情况清晰可见', 'Observer makes runtime activity visible'),
        paragraphs: [line('「观察者」面板将已有监控器的真实状态接入界面，默认展开，也可手动收起。你可以看到何时检查、为何提醒，以及提醒是否送达。', 'The Observer panel displays real state from the existing monitor and opens by default. You can collapse it at any time. See when checks occur, why reminders trigger, and whether they are delivered.')],
        bullets: [line('展示检测轮次、会话动作、介入次数与触发时间线。', 'See check counts, session actions, interventions, and the trigger timeline.'), line('区分等待、关闭、运行、结束和异常，以及提醒排队、送达与发送失败。', 'Distinguish waiting, disabled, observing, completed, and error states, plus queued, delivered, and failed reminders.')]
      },
      {
        title: line('记录跟随各自的任务', 'Records stay with their task'),
        paragraphs: [line('监控快照随本轮结果保存。切换任务显示对应记录，重新载入快照不会重复累加介入次数。', 'Monitoring snapshots are saved with each run. Switching tasks shows their own records, and replaying a snapshot does not duplicate interventions.')],
        bullets: [line('没有监控数据的历史显示未知，不补造统计；任务成功不会隐藏已记录的观察者异常。', 'History without monitoring data is unknown, not invented statistics. Task success does not hide recorded Observer errors.'), line('此次界面更新不改变模型推理、评分或已有工具能力。观察者提醒不能替代测试与结果复核。', 'This interface update does not change model reasoning, scoring, or existing tool capabilities. Observer reminders do not replace tests or result review.')]
      }
    ]
  };
  const errors = [
    {
      title: line('模型连接失败', 'Model connection failed'),
      description: line('请求未能连接服务，或返回鉴权、额度、限流等错误。', 'The service could not be reached, or returned an authentication, quota, or rate-limit error.'),
      answer: line('在「设置 → API 配置」核对地址、接口格式、API Key 和模型 ID，再使用「测试连接」。保留错误码与发生时间。', 'Check the URL, API format, API key, and model ID under Settings → API configuration, then use Test connection. Keep the error code and time.')
    },
    {
      title: 'Expected id / function.name to be a string',
      description: line('工具调用响应缺少必要的标识或函数名，当前连接可能不兼容所选接口。', 'A tool-call response is missing its required ID or function name. The connection may be incompatible with the selected API format.'),
      answer: line('核对服务实际支持的接口格式与模型工具调用能力。修改连接配置前先结束当前任务，再测试新配置。', 'Check the service’s supported API format and the model’s tool-calling capabilities. End the current task before changing the connection, then test the new configuration.')
    },
    {
      title: line('没有最终回复或输出被截断', 'No final reply or truncated output'),
      description: line('模型可能耗尽单次输出预算，或服务只返回了推理内容而没有正文。', 'The model may have exhausted its generation budget, or the service returned reasoning without a final answer.'),
      answer: line('先查看任务过程和已有改动，避免重复执行。必要时降低推理强度、缩小任务范围，或选用合适的模型后继续。', 'First review task activity and existing changes to avoid duplicate work. If needed, lower reasoning effort, narrow the task, or continue with a suitable model.')
    },
    {
      title: line('工作区或权限阻止操作', 'Workspace or permissions block an action'),
      description: line('未选择工作区、目标路径不可用，或相应的读写与命令权限没有开放。', 'No workspace is selected, the target path is unavailable, or the required file or command permission is disabled.'),
      answer: line('检查任务栏的工作区与输入框的权限设置。按需要授权目标操作；项目文件夹被移动后需要重新选择。', 'Check the task-bar workspace and composer permissions. Authorize the required action, and select the folder again if it moved.')
    },
    {
      title: line('观察者没有记录或出现异常', 'Observer has no records or reports an error'),
      description: line('任务可能尚未达到检测条件、未启用观察者，或历史没有保存监控数据。异常也可能仅发生在观察者自身。', 'The task may not yet meet check conditions, Observer may be disabled, or history may lack monitoring data. An error can also affect Observer alone.'),
      answer: line('先看状态说明，再区分 0 次与未知。没有提醒不等于答案正确；观察者异常不一定是解题失败，还需核对任务消息与检查结果。', 'Read the status and distinguish zero from unknown. No reminders do not prove correctness; an Observer error does not necessarily mean task failure. Check task messages and verification results too.')
    },
    {
      title: line('连接中断或证书错误', 'Connection interrupted or certificate error'),
      description: line('网络、代理或证书校验可能阻止请求继续。', 'The network, proxy, or certificate validation may prevent the request from continuing.'),
      answer: line('检查网络和服务的证书、代理配置。保留原任务记录，确认状态后再继续或重试；不要为绕过错误关闭证书校验。', 'Check the network and the service’s certificate and proxy configuration. Keep the original task record, confirm its status, then continue or retry. Do not disable certificate validation to bypass the error.')
    }
  ];

  function normalizeUserName(value) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
  }
  function greeting(value, language = 'zh-CN') {
    const name = normalizeUserName(value);
    return String(language).toLowerCase() === 'en'
      ? (name ? `${name}, what comes next?` : 'Your next step, with Z.')
      : (name ? `${name}，下一步做什么？` : '下一步，交给 Z。');
  }
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  return freeze({ guide, releaseNotes, errors, translations, normalizeUserName, greeting });
});
