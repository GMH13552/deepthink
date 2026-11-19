import type {
  ServerToolBlock,
  ServerToolUseBlock,
  WebFetchToolResultBlock,
  WebSearchResult,
  WebSearchToolResultBlock,
} from '../api/types.js'
import type { ComposeDrafts } from './compose.js'
import type { ReplyBlock } from './types.js'

/**
 * 手写回答里的工具步骤：搜索 / 阅读网页。
 * 搜索可以真的调 deepseek_web_search，也可以只用用户粘的网址造一条来源列表；
 * 阅读先只插一个标签，等 AI 补全时再真的抓取正文。
 */

export type ComposingTool = {
  /** 对应的 server_tool_use 块 id */
  id: string
  kind: 'search' | 'read_link'
  /** 查询词或域名 */
  label: string
  /** 「3 个结果」这类补充说明 */
  detail: string
}

export const isToolBlock = (block: ReplyBlock): block is ServerToolBlock =>
  block.type === 'server_tool_use' ||
  block.type === 'web_search_tool_result' ||
  block.type === 'web_fetch_tool_result'

/** 内容块顺序：思考、工具步骤、正文，和真实回复一致 */
export const buildComposingBlocks = (drafts: ComposeDrafts, tools: ReplyBlock[]): ReplyBlock[] => [
  ...(drafts.thinking !== '' ? [{ type: 'thinking' as const, thinking: drafts.thinking }] : []),
  ...tools,
  ...(drafts.answer !== '' ? [{ type: 'text' as const, text: drafts.answer }] : []),
]

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** 手填网址时的标题：域名 + 路径，避免多条只显示同一个域名 */
const labelOf = (url: string) => {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/$/, '')
    return `${parsed.hostname.replace(/^www\./, '')}${path === '' || path === '/' ? '' : path}`
  } catch {
    return url
  }
}

const hex = (length: number) =>
  Array.from({ length }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')

const toolId = (prefix: string) => `srvtoolu_${prefix}_${Date.now().toString(36)}_${hex(24)}`

/** 只用网址造的搜索步骤：来源卡片有标题与链接，没有摘要正文 */
export const createManualSearch = (
  urls: string[],
  query = '',
  id = toolId('s')
): ServerToolBlock[] => {
  const use: ServerToolUseBlock = {
    type: 'server_tool_use',
    id,
    name: 'deepseek_web_search',
    input: { action: 'search', queries: query ? [query] : [], ...(query ? { query } : {}) },
    caller: { type: 'direct' },
    kind: 'search',
  }
  const content: WebSearchResult[] = urls.map((url) => ({
    type: 'web_search_result',
    title: labelOf(url),
    url,
    snippet: '',
    site_icon: null,
    site_name: null,
    encrypted_content: '',
    page_age: null,
  }))
  const result: WebSearchToolResultBlock = {
    type: 'web_search_tool_result',
    tool_use_id: id,
    content,
    kind: 'search',
  }
  return [use, result]
}

/** 纯标签的阅读步骤：结果块存在但正文为空，界面上只显示「已阅读网页」 */
export const createManualFetch = (url: string, id = toolId('rl')): ServerToolBlock[] => {
  const use: ServerToolUseBlock = {
    type: 'server_tool_use',
    id,
    name: 'deepseek_read_url',
    input: { action: 'read_link', url },
    caller: { type: 'direct' },
    kind: 'read_link',
  }
  const result: WebFetchToolResultBlock = {
    type: 'web_fetch_tool_result',
    tool_use_id: id,
    kind: 'read_link',
    content: {
      type: 'web_fetch_result',
      url,
      content: {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: '' },
        title: hostOf(url),
      },
      published_at: null,
    },
  }
  return [use, result]
}

export const listComposingTools = (blocks: ReplyBlock[]): ComposingTool[] => {
  const results = new Map<string, ServerToolBlock>()
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
      results.set(block.tool_use_id, block)
    }
  }
  const tools: ComposingTool[] = []
  for (const block of blocks) {
    if (block.type !== 'server_tool_use') {
      continue
    }
    const result = results.get(block.id)
    if (block.kind === 'read_link') {
      const url = block.input.action === 'read_link' ? block.input.url : ''
      tools.push({ id: block.id, kind: 'read_link', label: hostOf(url), detail: '已阅读' })
      continue
    }
    const queries = block.input.action === 'search' ? block.input.queries : []
    const sources =
      result?.type === 'web_search_tool_result'
        ? result.content.filter((item) => item.type === 'web_search_result')
        : []
    const count = sources.length
    const first = sources[0]
    tools.push({
      id: block.id,
      kind: 'search',
      // 真搜索显示查询词；粘贴网址时显示第一个域名
      label: queries[0] ?? (first?.type === 'web_search_result' ? hostOf(first.url) : '搜索'),
      detail: `${count} 个结果`,
    })
  }
  return tools
}

/** 删掉某条工具步骤：调用块与对应的结果块一起移除 */
export const removeToolBlocks = (blocks: ReplyBlock[], toolId: string): ReplyBlock[] =>
  blocks.filter((block) => {
    if (block.type === 'server_tool_use') {
      return block.id !== toolId
    }
    if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
      return block.tool_use_id !== toolId
    }
    return true
  })

export const countSearchResults = (blocks: ServerToolBlock[]): number =>
  blocks.reduce(
    (total, block) =>
      block.type === 'web_search_tool_result'
        ? total + block.content.filter((item) => item.type === 'web_search_result').length
        : total,
    0
  )

/** 还没有正文的阅读步骤，AI 补全前需要真抓一次 */
export const pendingFetchIds = (blocks: ReplyBlock[]): string[] => {
  // 真抓过的结果正文加密在 signature 里，data 一直是空串；有签名就算已经抓过
  const fetched = new Set<string>()
  for (const block of blocks) {
    if (
      block.type === 'web_fetch_tool_result' &&
      block.content.type === 'web_fetch_result' &&
      (block.content.content.source.data || block.signature?.trim())
    ) {
      fetched.add(block.tool_use_id)
    }
  }
  return blocks.flatMap((block) =>
    block.type === 'server_tool_use' && block.kind === 'read_link' && !fetched.has(block.id)
      ? [block.id]
      : []
  )
}

/** 工具结果的纯文本摘要，交给 AI 补全当上下文 */
export const summarizeTools = (blocks: ReplyBlock[]): string => {
  const results = new Map<string, ServerToolBlock>()
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
      results.set(block.tool_use_id, block)
    }
  }
  const lines: string[] = []
  for (const block of blocks) {
    if (block.type !== 'server_tool_use') {
      continue
    }
    const result = results.get(block.id)
    if (result?.type === 'web_search_tool_result') {
      for (const item of result.content) {
        if (item.type === 'web_search_result') {
          lines.push(
            `- [搜索] ${item.title} ${item.url}${item.snippet ? '\n  ' + item.snippet : ''}`
          )
        }
      }
    } else if (
      result?.type === 'web_fetch_tool_result' &&
      result.content.type === 'web_fetch_result'
    ) {
      const text = result.content.content.source.data
      const title = result.content.content.title ?? result.content.url
      lines.push(
        `- [阅读] ${title} ${result.content.url}${text ? '\n  ' + text.slice(0, 1500) : ''}`
      )
    }
  }
  return lines.join('\n')
}
