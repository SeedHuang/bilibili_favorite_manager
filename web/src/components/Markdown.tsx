import { useMemo } from 'react';
import MarkdownIt from 'markdown-it';

/**
 * AI 气泡里的 markdown 渲染。
 *
 * **`html: false` 是这条链的安全边界,别打开。** 气泡里会夹着用户可控文本
 * (视频标题、简介都会被模型引用),开了它就等于把模型输出当 HTML 执行。
 * markdown-it 默认就是 false,这里写出来是让这条线是**有意的**,不是碰巧的。
 *
 * `breaks: true`:模型常用单个换行分段(不是 markdown 规范里的硬换行),
 * 不开的话整段会挤成一行,聊天气泡里几乎必然发生。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/**
 * 渲染 AI 消息。用户消息**不走这里** —— 用户输入按字面显示(pre-wrap),
 * 渲染器只给模型输出用。
 *
 * 服务端错误等纯文本消息也没有 markdown,但走同一个组件是无害的:
 * 解析不出结构时输出就是转义后的原文。
 */
export default function Markdown({ text }: { text: string }) {
  // render 是纯函数,但每条消息每次渲染都重算没意义 —— memo 在 text 上
  const html = useMemo(() => md.render(text), [text]);
  return <div className="bfm-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
