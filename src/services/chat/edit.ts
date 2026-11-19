import type { AssistantMessage, ReplyBlock, TextPart, ThinkingPart } from './types.js'

/**
 * 手动编辑助手回复：把回复拆成「思考步骤」和「最终回答」两部分供编辑，再按内容块原样写回。
 * 分组规则与 buildReplyView 一致：相邻思考块合成一步，最终回答是最后一个非文本块之后的正文。
 */

/** 一个可编辑的思考步骤 */
export type ThinkingEditPart = {
  /** 与 ThinkingStep.key 相同，是步骤首个思考块的下标 */
  key: string
  /** 该步骤全部思考块的下标；写回时只保留第一个，其余合并进它 */
  indexes: number[]
  text: string
}

export type EditableReply = {
  thinking: ThinkingEditPart[]
  /** 最终回答由末尾若干文本块拼成，可能为空（只有思考或工具调用） */
  answer: { indexes: number[]; text: string }
}

/** 只列出真正改动的部分：没改的步骤不写回，避免动到签名与时间 */
export type ReplyEdit = {
  thinking?: { key: string; text: string }[]
  answer?: string
}

export const getEditableReply = (reply: AssistantMessage): EditableReply => {
  const thinking: ThinkingEditPart[] = []
  let current: ThinkingEditPart | null = null
  let lastNonText = -1

  reply.blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      if (current) {
        current.indexes.push(index)
        current.text += block.thinking
      } else {
        current = { key: `thinking-${index}`, indexes: [index], text: block.thinking }
        thinking.push(current)
      }
      return
    }
    current = null
    // 模板提示由 describeReply 单独展示，不算正文，也不切断正文
    if (block.type !== 'text') {
      lastNonText = index
    }
  })

  const answerIndexes = reply.blocks.flatMap((block, index) => {
    if (index <= lastNonText || block.type !== 'text' || block.isTemplate) {
      return []
    }
    return [{ index, text: block.text }]
  })

  return {
    thinking,
    answer: {
      indexes: answerIndexes.map((item) => item.index),
      text: answerIndexes.map((item) => item.text).join(''),
    },
  }
}

/**
 * 把编辑结果写回内容块：改写后的回答清掉旧引用（引用按旧正文的位置登记），
 * 原本没有回答时在末尾补一个文本块。返回原对象表示没有变化。
 */
export const applyReplyEdit = (
  reply: AssistantMessage,
  edit: ReplyEdit,
  now: number
): AssistantMessage => {
  const editable = getEditableReply(reply)
  const removed = new Set<number>()
  const replacements = new Map<number, ReplyBlock>()
  let appended: TextPart | null = null

  for (const part of editable.thinking) {
    const draft = edit.thinking?.find((item) => item.key === part.key)
    if (draft === undefined || draft.text === part.text) {
      continue
    }
    const [first, ...rest] = part.indexes
    rest.forEach((index) => removed.add(index))
    if (!draft.text.trim()) {
      // 清空思考即删掉这一步
      removed.add(first)
      continue
    }
    const block = reply.blocks[first] as ThinkingPart
    replacements.set(first, {
      ...block,
      thinking: draft.text,
      // 内容改过，原签名不再匹配；历史思考本来就不回传，清掉避免续写时误用
      signature: undefined,
      ...(block.startedAt !== undefined && block.endedAt === undefined ? { endedAt: now } : {}),
    })
  }

  if (edit.answer !== undefined && edit.answer !== editable.answer.text) {
    const [first, ...rest] = editable.answer.indexes
    rest.forEach((index) => removed.add(index))
    if (!edit.answer.trim()) {
      if (first !== undefined) {
        removed.add(first)
      }
    } else if (first === undefined) {
      appended = { type: 'text', text: edit.answer }
    } else {
      replacements.set(first, { type: 'text', text: edit.answer })
    }
  }

  if (removed.size === 0 && replacements.size === 0 && !appended) {
    return reply
  }

  const blocks = reply.blocks.flatMap((block, index) => {
    if (removed.has(index)) {
      return []
    }
    const replacement = replacements.get(index)
    return [replacement ?? block]
  })
  if (appended) {
    blocks.push(appended)
  }
  return { ...reply, blocks }
}
