/** 发给 LLM 的单条消息 —— provider / tagger / tagcheck 共用 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
