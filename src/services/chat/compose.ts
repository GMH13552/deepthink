import { streamMessage } from '../api/client.js'
import type {
  AssistantBlockParam,
  CreateMessageRequest,
  MessageParam,
  ServerToolBlock,
} from '../api/types.js'
import { SYSTEM_PROMPT } from './prompt.js'
import { toRequestMessages } from './reply.js'
import type { AssistantMessage, Message, ReplyBlock, UserMessage } from './types.js'

/**
 * 手写回答的 AI 补全：把当前草稿当作 assistant 前缀发出去，让模型接着写。
 * 没有草稿时退化为「起草开头」。思考与回答都用同一接口，只是提示词不同。
 */

export type ComposeTarget = 'thinking' | 'answer'

export type ComposeDrafts = { thinking: string; answer: string }

/** 单次补全最多生成多少 token，避免一口气写太长 */
const COMPOSE_MAX_TOKENS = 512

const TASK: Record<ComposeTarget, { start: string; continue: string }> = {
  thinking: {
    start: '用户正在人工撰写这条回复的「思考过程」（第一人称的推理独白）。草稿还是空的，请写出接下来这段思考的开头，一到三句话，紧接着用户的提问展开。',
    continue:
      '用户正在人工撰写这条回复的「思考过程」（第一人称的推理独白）。请紧接草稿的最后一句话继续往下写，只输出新增的文字：不要重复草稿，不要复述任务，不要写标题、引号或前缀。',
  },
  answer: {
    start: '用户正在人工撰写给用户的「最终回答」。草稿还是空的，请写出接下来这段回答的开头，一到三句话。',
    continue:
      '用户正在人工撰写给用户的「最终回答」。请紧接草稿的最后一句话继续往下写，只输出新增的文字：不要重复草稿，不要复述任务，不要写标题、引号或前缀。',
  },
}

/**
 * 阅读网页的调用与结果块：只有带签名（服务端能解密）的才能回传。
 * 补全请求里把它们放成一轮「读网页」的历史，模型才看得到正文。
 */
const readLinkTurns = (blocks: ReplyBlock[]): { url: string; content: AssistantBlockParam[] }[] => {
  const results = new Map<string, ReplyBlock>()
  for (const block of blocks) {
    if (block.type === 'web_fetch_tool_result' && block.kind === 'read_link') {
      results.set(block.tool_use_id, block)
    }
  }
  const turns: { url: string; content: AssistantBlockParam[] }[] = []
  for (const block of blocks) {
    if (block.type !== 'server_tool_use' || block.kind !== 'read_link') {
      continue
    }
    const result = results.get(block.id)
    if (
      result?.type !== 'web_fetch_tool_result' ||
      result.content.type !== 'web_fetch_result' ||
      !result.signature?.trim()
    ) {
      continue
    }
    const url = block.input.action === 'read_link' && block.input.url ? block.input.url : result.content.url
    const use: AssistantBlockParam = {
      type: 'server_tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
      kind: block.kind,
    }
    turns.push({
      url,
      content: [use, result, { type: 'text', text: '好的。' }],
    })
  }
  return turns
}

/** 拼出补全请求：历史轮次 + 本轮提问 + 当前草稿前缀 */
export const createComposeRequest = (
  reply: AssistantMessage,
  history: Message[],
  question: UserMessage,
  target: ComposeTarget,
  seed: string,
  context = '',
  toolContext = '',
  fetched: ReplyBlock[] = []
): CreateMessageRequest => {
  const messages: MessageParam[] = []
  for (const turn of readLinkTurns(fetched)) {
    messages.push({ role: 'user', content: `请阅读这个网页：${turn.url}` })
    messages.push({ role: 'assistant', content: turn.content })
  }
  messages.push(...toRequestMessages(history, question))
  if (seed.trim()) {
    // 末尾的 assistant 内容即模型要接续的前缀，不需要额外字段
    messages.push({ role: 'assistant', content: [{ type: 'text', text: seed }] })
  }
  const system = [
    SYSTEM_PROMPT,
    '你正在协助用户人工撰写一条助手回复的草稿。只补全文字，不评价、不解释、不提及你在协助。',
    seed.trim() ? TASK[target].continue : TASK[target].start,
    context.trim()
      ? `这一轮已经写好的内容，仅供你接续语气，不要重复：\n${context}`
      : '',
    toolContext
      ? `本轮已经拿到的工具结果，写作时可以参考，但不要逐字照抄、不要提到「工具」：\n${toolContext}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: reply.model ?? 'deepseek-flash',
    system,
    messages,
    max_tokens: COMPOSE_MAX_TOKENS,
    thinking: { type: 'disabled' },
    tools: [],
    safety_check: { level: 'high' },
  }
}

/** 搜索请求：让模型真的调一次 deepseek_web_search */
export const createSearchRequest = (query: string): CreateMessageRequest => ({
  model: 'deepseek-flash',
  system: SYSTEM_PROMPT,
  messages: [
    {
      role: 'user',
      content: `请使用网页搜索查询：${query}\n只执行搜索，不要直接回答。`,
    },
  ],
  max_tokens: 256,
  thinking: { type: 'disabled' },
  tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
  safety_check: { level: 'high' },
})

/** 阅读请求：让模型真的调一次 deepseek_read_url，拿回网页正文 */
export const createFetchRequest = (url: string): CreateMessageRequest => ({
  model: 'deepseek-flash',
  system: SYSTEM_PROMPT,
  messages: [{ role: 'user', content: `请阅读这个网页：${url}` }],
  max_tokens: 256,
  thinking: { type: 'disabled' },
  tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
  safety_check: { level: 'high' },
})

/** 只收集工具块（搜索/阅读的调用与结果），正文丢弃 */
export const collectToolBlocks = async (
  apiKey: string,
  request: CreateMessageRequest,
  signal: AbortSignal
): Promise<ServerToolBlock[]> => {
  const blocks: ServerToolBlock[] = []
  for await (const event of streamMessage(apiKey, request, signal)) {
    if (event.type !== 'content_block_start') {
      continue
    }
    const block = event.content_block
    if (
      block.type === 'server_tool_use' ||
      block.type === 'web_search_tool_result' ||
      block.type === 'web_fetch_tool_result'
    ) {
      blocks.push(block)
    }
  }
  return blocks
}

/** 逐段读出补全文本；调用方负责拼接与中止 */
export const streamComposeSuggestion = async ({
  apiKey,
  request,
  signal,
  onDelta,
}: {
  apiKey: string
  request: CreateMessageRequest
  signal: AbortSignal
  onDelta: (text: string) => void
}): Promise<void> => {
  for await (const event of streamMessage(apiKey, request, signal)) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      onDelta(event.delta.text)
    }
  }
}
