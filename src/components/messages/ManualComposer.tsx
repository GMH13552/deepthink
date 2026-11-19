import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { useDismiss } from '../base/anchored.js'
import { showToast } from '../base/toastState.js'
import { AI_PHRASE_GROUPS } from '../../services/chat/phrases.js'
import { getEditableReply } from '../../services/chat/edit.js'
import { setDraftText } from '../../services/chat/drafts.js'
import { createManualFetch, createManualSearch } from '../../services/chat/composing.js'
import {
  composeSuggestion,
  discardComposingReply,
  finishComposingReply,
  searchWeb,
  writeComposingReply,
  writeEditingReply,
} from '../../services/chat/store.js'
import type { ComposeTarget } from '../../services/chat/compose.js'
import type { AssistantMessage, ReplyBlock } from '../../services/chat/types.js'
import type {
  ServerToolBlock,
  ServerToolUseBlock,
  WebFetchToolResultBlock,
  WebSearchResult,
  WebSearchToolResultBlock,
} from '../../services/api/types.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { Button } from '../base/Button.js'
import { IconLinkOutline16, IconRefreshOutline16, IconSearchOutline16 } from '../base/icons.js'
import styles from './ManualComposer.module.css'

/** 输入停顿这么久之后把内容写回消息，刷新页面也不会丢 */
const SAVE_DELAY = 600

type Step =
  | { key: string; kind: 'thinking'; text: string }
  | { key: string; kind: 'text'; text: string }
  | { key: string; kind: 'tool'; toolId: string }

type ToolForm = { kind: 'search'; query: string } | { kind: 'fetch'; value: string }

const keyOf = () => Math.random().toString(36).slice(2)

/** 允许裸域名：没有协议时补 https:// */
const normalizeUrl = (input: string): string | null => {
  const value = input.trim()
  if (!value) {
    return null
  }
  if (/^https?:\/\//i.test(value)) {
    return value
  }
  return /^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#][^\s]*)?$/i.test(value) ? `https://${value}` : null
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const deriveSteps = (blocks: ReplyBlock[], answerIndexes: Set<number>): Step[] => {
  const steps: Step[] = []
  blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      steps.push({ key: keyOf(), kind: 'thinking', text: block.thinking })
    } else if (block.type === 'text' && !block.isTemplate && !answerIndexes.has(index)) {
      // 工具步骤前后的正文段（真实回复里会有）照样可以编辑
      steps.push({ key: keyOf(), kind: 'text', text: block.text })
    } else if (block.type === 'server_tool_use') {
      steps.push({ key: block.id, kind: 'tool', toolId: block.id })
    }
  })
  return steps
}

/** 把工具块按调用 id 配对：调用块 + 结果块 */
const collectToolPairs = (blocks: ReplyBlock[]) => {
  const results = new Map<string, ReplyBlock>()
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
      results.set(block.tool_use_id, block)
    }
  }
  const pairs = new Map<string, ReplyBlock[]>()
  for (const block of blocks) {
    if (block.type !== 'server_tool_use') {
      continue
    }
    const result = results.get(block.id)
    pairs.set(block.id, result ? [block, result] : [block])
  }
  return pairs
}

const assemble = (
  steps: Step[],
  answer: string,
  pairOf: (toolId: string) => ReplyBlock[] | undefined
): ReplyBlock[] => {
  const blocks: ReplyBlock[] = []
  for (const step of steps) {
    if (step.kind === 'thinking' || step.kind === 'text') {
      if (step.text !== '') {
        blocks.push(
          step.kind === 'thinking'
            ? { type: 'thinking', thinking: step.text }
            : { type: 'text', text: step.text }
        )
      }
      continue
    }
    const pair = pairOf(step.toolId)
    if (pair) {
      blocks.push(...pair)
    }
  }
  if (answer !== '') {
    blocks.push({ type: 'text', text: answer })
  }
  return blocks
}

const searchResultsOf = (pair: ReplyBlock[] | undefined): WebSearchResult[] => {
  const result = pair?.find(
    (block): block is WebSearchToolResultBlock => block.type === 'web_search_tool_result'
  )
  return result ? (result.content.filter((item) => item.type === 'web_search_result') as WebSearchResult[]) : []
}

const useAutoHeight = (value: string, ref: React.MutableRefObject<HTMLTextAreaElement | null>) => {
  useLayoutEffect(() => {
    const element = ref.current
    if (element) {
      element.style.height = 'auto'
      element.style.height = `${Math.min(element.scrollHeight, 340)}px`
    }
  }, [value, ref])
}

const StepInput = ({
  value,
  label,
  placeholder,
  className,
  autoFocus,
  inputRef,
  onChange,
  onFocus,
  onKeyDown,
  children,
}: {
  value: string
  label: string
  placeholder: string
  className?: string
  autoFocus?: boolean
  inputRef?: (element: HTMLTextAreaElement | null) => void
  onChange: (value: string) => void
  onFocus?: () => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  children?: React.ReactNode
}) => {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useAutoHeight(value, ref)
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.label}>{label}</span>
        {children}
      </div>
      <textarea
        ref={(element) => {
          ref.current = element
          inputRef?.(element)
        }}
        className={clsx(styles.textarea, className)}
        aria-label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={2}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}

const EditableText = ({
  value,
  placeholder,
  label,
  className,
  onCommit,
}: {
  value: string
  placeholder: string
  label: string
  className?: string
  onCommit: (value: string) => void
}) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const cancelled = useRef(false)
  const draftRef = useRef(draft)
  draftRef.current = draft

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false
      setEditing(false)
      return
    }
    const next = draftRef.current.trim()
    setEditing(false)
    if (next && next !== value) {
      onCommit(next)
    }
  }

  // 点输入框以外的地方直接提交；不依赖失焦事件（嵌入浮层时不一定触发）
  useEffect(() => {
    if (!editing) {
      return
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!inputRef.current?.contains(event.target as Node)) {
        commit()
      }
    }
    document.addEventListener('mousedown', onPointerDown, true)
    return () => document.removeEventListener('mousedown', onPointerDown, true)
  })

  if (!editing) {
    return (
      <button
        type="button"
        className={clsx(styles.inlineText, className, !value && styles.inlinePlaceholder)}
        aria-label={label}
        title={value || placeholder}
        onClick={(event) => {
          event.stopPropagation()
          setDraft(value)
          setEditing(true)
        }}
      >
        {value || placeholder}
      </button>
    )
  }
  return (
    <input
      ref={inputRef}
      className={clsx(styles.inlineInput, className)}
      aria-label={label}
      autoFocus
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          cancelled.current = true
          setEditing(false)
        }
      }}
    />
  )
}

const ToolStep = ({
  pair,
  researching,
  onRemove,
  onChangePair,
  onReplaceFetch,
  onResearch,
}: {
  pair: ReplyBlock[]
  researching: boolean
  onRemove: () => void
  onChangePair: (update: (pair: ReplyBlock[]) => ReplyBlock[]) => void
  onReplaceFetch: (url: string) => void
  onResearch: (query: string) => void
}) => {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(() => searchResultsOf(pair).length === 0)
  const [draftUrl, setDraftUrl] = useState('')
  const [editingUrl, setEditingUrl] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')

  const use = pair.find((block): block is ServerToolUseBlock => block.type === 'server_tool_use')
  if (!use) {
    return null
  }
  const isSearch = use.kind !== 'read_link'
  const results = isSearch ? searchResultsOf(pair) : []
  const fetchResult = pair.find(
    (block): block is WebFetchToolResultBlock => block.type === 'web_fetch_tool_result'
  )
  const fetched =
    fetchResult && fetchResult.content.type === 'web_fetch_result' ? fetchResult.content : null
  const url = use.input.action === 'read_link' ? use.input.url : (fetched?.url ?? '')
  const title = fetched?.content.title ?? ''
  const query = use.input.action === 'search' ? (use.input.queries[0] ?? '') : ''
  const label = isSearch ? query || hostOf(results[0]?.url ?? '') : title || hostOf(url)

  const setQuery = (next: string) =>
    onChangePair((list) =>
      list.map((block) =>
        block.type === 'server_tool_use'
          ? { ...block, input: { ...block.input, queries: [next], query: next } as typeof block.input }
          : block
      )
    )

  const setResultTitle = (targetUrl: string, next: string) =>
    onChangePair((list) =>
      list.map((block) =>
        block.type === 'web_search_tool_result'
          ? {
              ...block,
              content: block.content.map((item) =>
                item.type === 'web_search_result' && item.url === targetUrl
                  ? { ...item, title: next }
                  : item
              ),
            }
          : block
      )
    )

  const setFetchTitle = (next: string) =>
    onChangePair((list) =>
      list.map((block) =>
        block.type === 'web_fetch_tool_result' && block.content.type === 'web_fetch_result'
          ? {
              ...block,
              content: {
                ...block.content,
                content: { ...block.content.content, title: next },
              },
            }
          : block
      )
    )

  const addUrl = () => {
    const value = normalizeUrl(draftUrl)
    if (!value) {
      showToast(t('composeToolInvalidUrl'))
      return
    }
    onChangePair((list) =>
      list.map((block) =>
        block.type === 'web_search_tool_result'
          ? {
              ...block,
              content: [
                ...block.content,
                {
                  type: 'web_search_result' as const,
                  title: hostOf(value),
                  url: value,
                  snippet: '',
                  site_icon: null,
                  site_name: null,
                  encrypted_content: '',
                  page_age: null,
                },
              ],
            }
          : block
      )
    )
    setDraftUrl('')
  }

  return (
    <div className={styles.toolCard}>
      <div className={styles.toolHead}>
        <span className={styles.toolIcon}>
          {isSearch ? <IconSearchOutline16 /> : <IconLinkOutline16 />}
        </span>
        {isSearch ? (
          <EditableText
            value={query}
            placeholder={label || t('composeToolSearch')}
            label={t('composeToolEditQuery')}
            className={styles.toolLabel}
            onCommit={setQuery}
          />
        ) : (
          <EditableText
            value={title}
            placeholder={hostOf(url)}
            label={t('composeToolEditTitle')}
            className={styles.toolLabel}
            onCommit={setFetchTitle}
          />
        )}
        <span className={styles.toolDetail}>
          {isSearch ? t('composeToolCount', { count: results.length }) : t('readLinkDone')}
        </span>
        {isSearch ? (
          <button
            type="button"
            className={styles.toolChevron}
            aria-expanded={expanded}
            aria-label={expanded ? t('composeToolCollapse') : t('composeToolExpand')}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? '▴' : '▾'}
          </button>
        ) : null}
        {isSearch ? (
          <button
            type="button"
            className={clsx(styles.toolAction, researching && styles.toolActionBusy)}
            aria-label={t('composeToolResearch')}
            title={t('composeToolResearch')}
            disabled={researching}
            onClick={() => onResearch(query)}
          >
            <IconRefreshOutline16 />
          </button>
        ) : null}
        <button
          type="button"
          className={styles.toolRemove}
          aria-label={t('composeToolRemove')}
          onClick={onRemove}
        >
          ×
        </button>
      </div>

      {!isSearch ? (
        <div className={styles.toolSub}>
          <a className={styles.resultUrl} href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
          {editingUrl ? (
            <input
              className={styles.inlineInput}
              aria-label={t('composeToolEditUrl')}
              autoFocus
              value={urlDraft}
              onChange={(event) => setUrlDraft(event.target.value)}
              onBlur={() => setEditingUrl(false)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  return
                }
                if (event.key === 'Enter') {
                  const next = normalizeUrl(urlDraft)
                  if (next && next !== url) {
                    onReplaceFetch(next)
                  }
                  setEditingUrl(false)
                } else if (event.key === 'Escape') {
                  setEditingUrl(false)
                }
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.urlEdit}
              aria-label={t('composeToolEditUrl')}
              onClick={() => {
                setUrlDraft(url)
                setEditingUrl(true)
              }}
            >
              {t('composeToolEditUrl')}
            </button>
          )}
        </div>
      ) : null}

      {isSearch && expanded ? (
        <div className={styles.toolBody}>
          {results.map((item) => (
            <div key={item.url} className={styles.resultRow}>
              <div className={styles.resultMain}>
                <EditableText
                  value={item.title}
                  placeholder={hostOf(item.url)}
                  label={t('composeToolEditTitle')}
                  className={styles.resultTitle}
                  onCommit={(next) => setResultTitle(item.url, next)}
                />
                <a className={styles.resultUrl} href={item.url} target="_blank" rel="noreferrer">
                  {item.url}
                </a>
              </div>
              <button
                type="button"
                className={styles.resultRemove}
                aria-label={t('composeToolRemoveResult')}
                onClick={() =>
                  onChangePair((list) =>
                    list.map((block) =>
                      block.type === 'web_search_tool_result'
                        ? {
                            ...block,
                            content: block.content.filter(
                              (next) => next.type !== 'web_search_result' || next.url !== item.url
                            ),
                          }
                        : block
                    )
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
          <div className={styles.resultAdd}>
            <input
              className={styles.toolInput}
              value={draftUrl}
              placeholder={t('composeToolUrlsPlaceholder')}
              aria-label={t('composeToolAddUrl')}
              onChange={(event) => setDraftUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  return
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addUrl()
                }
              }}
            />
            <Button size="s" variant="outlined" onClick={addUrl}>
              {t('composeToolAddUrl')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 手写回答：按步骤拼一条回复——思考、搜索、阅读、再思考、最终回答，
 * 顺序就是保存后的展示顺序；AI 补全只补当前这一段，工具结果会一并交给模型。
 */
export const ManualComposer = ({
  sessionId,
  message,
  mode = 'compose',
  onDone,
}: {
  sessionId: string
  message: AssistantMessage
  /** compose：手写新回答；edit：就地编辑已有回答 */
  mode?: 'compose' | 'edit'
  onDone?: () => void
}) => {
  const t = useTranslate()
  const thinkingEnabled = useSettings((state) => state.thinking)
  const editable = getEditableReply(message)
  const [steps, setSteps] = useState<Step[]>(() => {
    const initial = deriveSteps(message.blocks, new Set(editable.answer.indexes))
    // 开了深度思考，手写回答默认就带一段思考，不用再点「思考」
    if (mode === 'compose' && thinkingEnabled && !initial.some((step) => step.kind === 'thinking')) {
      return [{ key: keyOf(), kind: 'thinking', text: '' }, ...initial]
    }
    return initial
  })
  const [answer, setAnswer] = useState(editable.answer.text)
  const [toolForm, setToolForm] = useState<ToolForm | null>(null)
  const [toolBusy, setToolBusy] = useState(false)
  const [researchingId, setResearchingId] = useState<string | null>(null)
  const [assist, setAssist] = useState<{ key: string; controller: AbortController } | null>(null)
  const [phrasesOpen, setPhrasesOpen] = useState(false)
  const [focusedKey, setFocusedKey] = useState<string>('answer')
  const [revision, setRevision] = useState(0)

  const assistantRef = useRef<HTMLTextAreaElement | null>(null)
  const elements = useRef(new Map<string, HTMLTextAreaElement>())
  const toolController = useRef<AbortController | null>(null)
  const assistRef = useRef<AbortController | null>(null)
  const messagePairs = collectToolPairs(message.blocks)
  const pairOf = (toolId: string, overrides?: Map<string, ReplyBlock[]>) =>
    overrides?.get(toolId) ?? messagePairs.get(toolId)

  const blocks = assemble(steps, answer, pairOf)
  const latest = useRef({ sessionId, messageId: message.id, blocks })
  latest.current = { sessionId, messageId: message.id, blocks }
  /** 进编辑前的原始内容，取消时恢复 */
  const snapshot = useRef<ReplyBlock[]>(message.blocks)

  const writeBlocks = (next: ReplyBlock[]) =>
    mode === 'edit'
      ? writeEditingReply(sessionId, message.id, next)
      : writeComposingReply(sessionId, message.id, next)

  // 草稿自动落盘：手写模式写 composing 消息，编辑模式写回已完成消息（取消时用快照恢复）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (mode === 'edit') {
        writeEditingReply(sessionId, message.id, latest.current.blocks)
      } else {
        writeComposingReply(sessionId, message.id, latest.current.blocks)
      }
    }, SAVE_DELAY)
    return () => window.clearTimeout(timer)
  }, [sessionId, message.id, steps, answer, revision, mode])

  // 切走时停掉请求并落盘
  useEffect(
    () => () => {
      assistRef.current?.abort()
      toolController.current?.abort()
      if (mode === 'compose') {
        const current = latest.current
        writeComposingReply(current.sessionId, current.messageId, current.blocks)
      }
    },
    [mode]
  )

  const { anchorRef, panelRef } = { anchorRef: useRef<HTMLSpanElement>(null), panelRef: useRef<HTMLDivElement>(null) }
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!phrasesOpen) {
      setPanelStyle(null)
      return
    }
    const update = () => {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (!anchor || !panel) {
        return
      }
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(360, window.innerWidth - 16)
      panel.style.width = `${width}px`
      const contentHeight = panel.scrollHeight
      const spaceAbove = rect.top - 16
      const spaceBelow = window.innerHeight - rect.bottom - 16
      const above = spaceBelow < 160 && spaceAbove > spaceBelow
      const maxHeight = Math.max(96, Math.min(320, above ? spaceAbove : spaceBelow))
      const height = Math.min(contentHeight, maxHeight)
      const top = above
        ? Math.max(8, rect.top - 8 - height)
        : Math.min(rect.bottom + 8, window.innerHeight - height - 8)
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
      setPanelStyle((prev) =>
        prev &&
        prev.top === top &&
        prev.left === left &&
        prev.width === width &&
        prev.maxHeight === maxHeight
          ? prev
          : { top, left, width, maxHeight }
      )
    }
    update()
    window.addEventListener('scroll', update, { capture: true, passive: true })
    window.addEventListener('resize', update, { passive: true })
    const observer = new ResizeObserver(update)
    if (panelRef.current) {
      observer.observe(panelRef.current)
    }
    const timer = window.setInterval(update, 200)
    return () => {
      window.removeEventListener('scroll', update, { capture: true })
      window.removeEventListener('resize', update)
      observer.disconnect()
      window.clearInterval(timer)
    }
  }, [phrasesOpen, anchorRef, panelRef])
  useDismiss(phrasesOpen, [anchorRef, panelRef], () => setPhrasesOpen(false))

  const updateStep = (key: string, text: string) =>
    setSteps((list) =>
      list.map((step) => (step.key === key && step.kind !== 'tool' ? { ...step, text } : step))
    )

  const startAssist = (target: ComposeTarget, key: string) => {
    if (assist || !ensureApiKey()) {
      return
    }
    // 前缀带上前面已经写好的思考/正文，模型接着整条思路写，不会从提问重新开始
    const stepTexts = steps.flatMap((item) => (item.kind === 'tool' ? [] : [item.text.trim()]))
    const index = steps.findIndex((item) => item.key === key)
    const self = index >= 0 ? steps[index] : undefined
    const current =
      target === 'answer' ? answer.trim() : self && self.kind !== 'tool' ? self.text.trim() : ''
    const textIndex =
      index < 0 ? 0 : steps.slice(0, index).filter((item) => item.kind !== 'tool').length
    const before = target === 'answer' ? [] : stepTexts.slice(0, textIndex)
    const seed = [...before, current].filter(Boolean).join('\n\n')
    const context =
      target === 'answer' ? stepTexts.filter(Boolean).join('\n\n') : answer.trim()
    const controller = new AbortController()
    assistRef.current = controller
    setAssist({ key, controller })
    void composeSuggestion({
      sessionId,
      messageId: message.id,
      target,
      seed,
      context,
      signal: controller.signal,
      onDelta: (delta) => {
        if (target === 'answer') {
          setAnswer((value) => value + delta)
        } else {
          setSteps((list) =>
            list.map((item) =>
              item.key === key && item.kind === 'thinking'
                ? { ...item, text: item.text + delta }
                : item
            )
          )
        }
      },
    })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          showToast(error instanceof Error && error.message ? error.message : t('composeAssistFailed'))
        }
      })
      .finally(() => {
        if (assistRef.current === controller) {
          assistRef.current = null
        }
        setAssist((current) => (current?.controller === controller ? null : current))
      })
  }

  const addToolBlocks = (added: ServerToolBlock[]) => {
    const use = added.find((block) => block.type === 'server_tool_use')
    if (!use) {
      return
    }
    const next = [...steps, { key: use.id, kind: 'tool' as const, toolId: use.id }]
    const overrides = new Map([[use.id, added as ReplyBlock[]]])
    setSteps(next)
    writeBlocks(assemble(next, answer, (toolId) => pairOf(toolId, overrides)))
    setRevision((value) => value + 1)
  }

  /** 搜索这一条流程：关键词必填，网址是可选的「手动结果」 */
  const submitSearch = async (mode: 'search' | 'skip') => {
    if (!toolForm || toolForm.kind !== 'search' || toolBusy) {
      return
    }
    const query = toolForm.query.trim()
    if (!query) {
      showToast(t('composeToolQueryRequired'))
      return
    }
    if (mode === 'skip') {
      // 先建一个只有关键词的搜索步骤，网址稍后在卡片里补
      addToolBlocks(createManualSearch([], query))
      showToast(t('composeToolSkipAdded'))
      setToolForm(null)
      return
    }
    if (!ensureApiKey()) {
      return
    }
    const controller = new AbortController()
    toolController.current?.abort()
    toolController.current = controller
    setToolBusy(true)
    try {
      const found = await searchWeb(query, controller.signal)
      const count = found.reduce(
        (total, block) =>
          block.type === 'web_search_tool_result'
            ? total + block.content.filter((item) => item.type === 'web_search_result').length
            : total,
        0
      )
      if (!controller.signal.aborted) {
        if (count === 0) {
          showToast(t('composeToolFailed'))
        } else {
          addToolBlocks(found)
          showToast(t('composeToolAdded', { count }))
          setToolForm(null)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        showToast(error instanceof Error && error.message ? error.message : t('composeToolFailed'))
      }
    } finally {
      if (toolController.current === controller) {
        toolController.current = null
        setToolBusy(false)
      }
    }
  }

  /** 用卡片里的关键词重新搜一次，结果替换这条搜索步骤（工具 id 保持不变） */
  const researchTool = async (toolId: string, query: string) => {
    if (researchingId || toolBusy) {
      return
    }
    const pair = pairOf(toolId)
    const use = pair?.find((block) => block.type === 'server_tool_use')
    const keyword =
      use?.type === 'server_tool_use' && use.input.action === 'search'
        ? (query || use.input.queries[0] || '').trim()
        : ''
    if (!keyword) {
      showToast(t('composeToolQueryRequired'))
      return
    }
    if (!ensureApiKey()) {
      return
    }
    const controller = new AbortController()
    toolController.current?.abort()
    toolController.current = controller
    setResearchingId(toolId)
    try {
      const found = await searchWeb(keyword, controller.signal)
      const count = found.reduce(
        (total, block) =>
          block.type === 'web_search_tool_result'
            ? total + block.content.filter((item) => item.type === 'web_search_result').length
            : total,
        0
      )
      if (!controller.signal.aborted) {
        if (count === 0) {
          showToast(t('composeToolFailed'))
        } else {
          const fixed = found.map((block) =>
            block.type === 'server_tool_use'
              ? {
                  ...block,
                  id: toolId,
                  input: { ...block.input, queries: [keyword], query: keyword } as typeof block.input,
                }
              : block.type === 'web_search_tool_result'
                ? { ...block, tool_use_id: toolId }
                : block
          )
          const overrides = new Map([[toolId, fixed as ReplyBlock[]]])
          writeBlocks(assemble(steps, answer, (id) => pairOf(id, overrides)))
          setRevision((value) => value + 1)
          showToast(t('composeToolAdded', { count }))
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        showToast(error instanceof Error && error.message ? error.message : t('composeToolFailed'))
      }
    } finally {
      if (toolController.current === controller) {
        toolController.current = null
        setResearchingId(null)
      }
    }
  }

  const submitFetch = () => {
    if (!toolForm || toolForm.kind !== 'fetch' || toolBusy) {
      return
    }
    const value = normalizeUrl(toolForm.value)
    if (!value) {
      showToast(t('composeToolInvalidUrl'))
      return
    }
    addToolBlocks(createManualFetch(value))
    setToolForm(null)
  }

  /** 改写某个工具步骤的内容块（改标题、改搜索词、增删网页、换链接都走这里） */
  const updateToolPair = (toolId: string, update: (pair: ReplyBlock[]) => ReplyBlock[]) => {
    const pair = pairOf(toolId)
    if (!pair) {
      return
    }
    const overrides = new Map([[toolId, update(pair)]])
    writeBlocks(assemble(steps, answer, (id) => pairOf(id, overrides)))
    setRevision((value) => value + 1)
  }

  /** 换阅读链接：沿用原工具 id，签名作废，下次补全会重新抓 */
  const replaceFetch = (toolId: string, url: string) => {
    const overrides = new Map([[toolId, createManualFetch(url, toolId) as ReplyBlock[]]])
    writeBlocks(assemble(steps, answer, (id) => pairOf(id, overrides)))
    setRevision((value) => value + 1)
  }

  const save = () => {
    if (!answer.trim()) {
      showToast(t('composeSaveFailed'))
      return
    }
    assistRef.current?.abort()
    toolController.current?.abort()
    if (mode === 'edit') {
      if (writeEditingReply(sessionId, message.id, blocks)) {
        onDone?.()
      } else {
        showToast(t('composeSaveFailed'))
      }
      return
    }
    if (!finishComposingReply(sessionId, message.id, blocks)) {
      showToast(t('composeSaveFailed'))
    }
  }

  const discard = () => {
    assistRef.current?.abort()
    toolController.current?.abort()
    if (mode === 'edit') {
      // 取消：把进入编辑前的内容块写回去
      writeEditingReply(sessionId, message.id, snapshot.current)
      onDone?.()
      return
    }
    const result = discardComposingReply(sessionId, message.id)
    if (result) {
      setDraftText(result.removedSession ? null : sessionId, result.text)
    }
  }

  const insertPhrase = (phrase: string) => {
    const element = focusedKey === 'answer' ? assistantRef.current : elements.current.get(focusedKey) ?? null
    const step = steps.find((item) => item.key === focusedKey)
    const current =
      focusedKey === 'answer' ? answer : step && step.kind !== 'tool' ? step.text : answer
    const start = element?.selectionStart ?? current.length
    const end = element?.selectionEnd ?? current.length
    const next = current.slice(0, start) + phrase + current.slice(end)
    if (focusedKey === 'answer') {
      setAnswer(next)
    } else {
      updateStep(focusedKey, next)
    }
    setPhrasesOpen(false)
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(start + phrase.length, start + phrase.length)
    })
  }

  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      discard()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      save()
    }
  }

  const formPlaceholder =
    toolForm?.kind === 'search'
      ? t('composeToolSearchPlaceholder')
      : t('composeToolFetchPlaceholder')

  return (
    <div className={styles.composer}>
      <div className={styles.header}>
        <span className={styles.badge}>{mode === 'edit' ? t('editReply') : t('manualAnswer')}</span>
      </div>

      {steps.map((step, index) =>
        step.kind !== 'tool' ? (
          <StepInput
            key={step.key}
            value={step.text}
            label={step.kind === 'thinking' ? t('editThinking') : t('composeStepText')}
            placeholder={step.kind === 'thinking' ? t('composeThinkingPlaceholder') : ''}
            className={step.kind === 'thinking' ? styles.thinking : undefined}
            autoFocus={index === 0 && thinkingEnabled}
            inputRef={(element) => {
              if (element) {
                elements.current.set(step.key, element)
              } else {
                elements.current.delete(step.key)
              }
            }}
            onChange={(value) => updateStep(step.key, value)}
            onFocus={() => setFocusedKey(step.key)}
            onKeyDown={keyDown}
          >
            <span className={styles.stepActions}>
              {step.kind === 'thinking' ? (
                <button
                  type="button"
                  className={clsx(styles.assist, assist?.key === step.key && styles.assistActive)}
                  disabled={!!assist && assist.key !== step.key}
                  onClick={() =>
                    assist?.key === step.key
                      ? assist.controller.abort()
                      : startAssist('thinking', step.key)
                  }
                >
                  {assist?.key === step.key ? t('composeAssistStop') : t('composeAssist')}
                </button>
              ) : null}
              <button
                type="button"
                className={styles.stepRemove}
                aria-label={t('composeStepRemove')}
                onClick={() => setSteps((list) => list.filter((item) => item.key !== step.key))}
              >
                ×
              </button>
            </span>
          </StepInput>
        ) : (
          <ToolStep
            key={step.key}
            pair={pairOf(step.toolId) ?? []}
            researching={researchingId === step.toolId}
            onRemove={() => setSteps((list) => list.filter((item) => item.key !== step.key))}
            onChangePair={(update) => updateToolPair(step.toolId, update)}
            onReplaceFetch={(url) => replaceFetch(step.toolId, url)}
            onResearch={(query) => void researchTool(step.toolId, query)}
          />
        )
      )}

      {toolForm?.kind === 'search' ? (
        <div className={styles.searchPanel}>
          <div className={styles.searchRow}>
            <span className={styles.searchIcon}>
              <IconSearchOutline16 />
            </span>
            <input
              className={styles.searchInput}
              autoFocus
              value={toolForm.query}
              disabled={toolBusy}
              placeholder={t('composeToolQueryPlaceholder')}
              aria-label={t('composeToolQueryLabel')}
              onChange={(event) => setToolForm({ ...toolForm, query: event.target.value })}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setToolForm(null)
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  void submitSearch('search')
                }
              }}
            />
          </div>
          <div className={styles.searchActions}>
            <Button
              size="s"
              disabled={toolBusy || !toolForm.query.trim()}
              onClick={() => void submitSearch('search')}
            >
              {toolBusy ? t('composeToolBusy') : t('composeToolSearch')}
            </Button>
            <Button
              size="s"
              variant="outlined"
              disabled={toolBusy || !toolForm.query.trim()}
              title={t('composeToolSkipHint')}
              onClick={() => void submitSearch('skip')}
            >
              {t('composeToolSkip')}
            </Button>
            <Button size="s" variant="outlined" onClick={() => setToolForm(null)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : toolForm ? (
        <div className={styles.toolForm}>
          <input
            className={clsx(styles.toolInput, styles.formInput)}
            autoFocus
            value={toolForm.value}
            disabled={toolBusy}
            placeholder={formPlaceholder}
            aria-label={formPlaceholder}
            onChange={(event) => setToolForm({ ...toolForm, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setToolForm(null)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                submitFetch()
              }
            }}
          />
          <Button size="s" disabled={!toolForm.value.trim() || toolBusy} onClick={submitFetch}>
            {t('composeToolAdd')}
          </Button>
        </div>
      ) : null}

      <StepInput
        value={answer}
        label={t('editAnswer')}
        placeholder={t('composeAnswerPlaceholder')}
        autoFocus={steps.length === 0 || !thinkingEnabled}
        inputRef={(element) => {
          assistantRef.current = element
        }}
        onChange={setAnswer}
        onFocus={() => setFocusedKey('answer')}
        onKeyDown={keyDown}
      >
        <button
          type="button"
          className={clsx(styles.assist, assist?.key === 'answer' && styles.assistActive)}
          disabled={!!assist && assist.key !== 'answer'}
          onClick={() =>
            assist?.key === 'answer' ? assist.controller.abort() : startAssist('answer', 'answer')
          }
        >
          {assist?.key === 'answer' ? t('composeAssistStop') : t('composeAssist')}
        </button>
      </StepInput>

      <div className={styles.actions}>
        <Button size="s" variant="outlined" onClick={() => setSteps((list) => [...list, { key: keyOf(), kind: 'thinking', text: '' }])}>
          {t('composeAddThinking')}
        </Button>
        <Button
          size="s"
          variant="outlined"
          disabled={toolBusy}
          onClick={() => setToolForm({ kind: 'search', query: '' })}
        >
          {t('composeToolSearch')}
        </Button>

        <Button size="s" variant="outlined" disabled={toolBusy} onClick={() => setToolForm({ kind: 'fetch', value: '' })}>
          {t('composeToolFetch')}
        </Button>
        <span ref={anchorRef} className={styles.phraseAnchor}>
          <Button size="s" variant="outlined" aria-expanded={phrasesOpen} onClick={() => setPhrasesOpen((open) => !open)}>
            {t('composePhrases')}
          </Button>
        </span>
        <span className={styles.spacer} />
        <Button size="s" variant="outlined" onClick={discard}>
          {t('cancel')}
        </Button>
        <Button size="s" disabled={!answer.trim()} onClick={save}>
          {t('save')}
        </Button>
      </div>

      {phrasesOpen
        ? createPortal(
            <div ref={panelRef} className={styles.phrasePanel} style={panelStyle ?? { top: 0, left: 0, width: 360, visibility: 'hidden' }}>
              {AI_PHRASE_GROUPS.map((group) => (
                <div key={group.key} className={styles.phraseGroup}>
                  <div className={styles.phraseGroupLabel}>{group.label}</div>
                  {group.items.map((phrase) => (
                    <button key={phrase} type="button" className={styles.phrase} onClick={() => insertPhrase(phrase)}>
                      {phrase}
                    </button>
                  ))}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
