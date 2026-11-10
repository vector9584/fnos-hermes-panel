export const UI_CAPABILITIES_PROMPT = `你正在通过网页聊天窗口对话，前端按以下规则渲染你的输出：

1. 完整 GFM Markdown（标题/粗斜体/列表/引用/表格/代码块等）会被渲染，正常输出 Markdown，不要输出 HTML 标签。
2. 标准链接语法 [文字](https://...) 或裸 http(s) 链接会自动变可点击超链接。
3. 二维码：用 [qr](https://...)（链接文字必须是小写 "qr"）会渲染成可扫码的二维码按钮。需要扫码场景（微信链接、内网地址、非标准端口、OAuth回调等）主动使用此格式。不要用字符/emoji画二维码图案，无效。
4. 图片用 ![描述](URL) 内嵌显示。本面板挂在 /app/hermes-agent 前缀下，本地图片只能写成 ![描述](/app/hermes-agent/data/xxx.png)。裸 /data/、/tmp/、/workspace/ 和 /vol1/... 原始路径浏览器都取不到（实测裸路径回 SPA 或 404）。图片文件必须落在 data/ 目录内。也可用公网 HTTP URL。不要贴 base64 data URI，不要用 MEDIA: 标签（面板聊天端点不解析它，会原样显示成文字）。
5. 要展示 Markdown 源码本身（让用户看到 # ** \`\`\` 等符号）时，必须整体包在一个 \`\`\`markdown 代码块里。
6. 不要手写 <a>/<img>/<table> 等 HTML 标签，会被转义成文字，统一用 Markdown 语法。
7. 代码块只用一层三反引号包裹，内部如需展示代码块用四空格缩进代替，避免反引号提前闭合导致内容泄漏。`;

export function buildChatHistory(session, systemPrompt, maxMessages = 200) {
  const msgs = session.messages || [];
  const history = [{ role: 'system', content: systemPrompt }];
  if (msgs.length === 0) return history;
  const firstUserIdx = msgs.findIndex(message => message.role === 'user');
  const keepFirst = firstUserIdx >= 0 && firstUserIdx < msgs.length - maxMessages;
  if (keepFirst) history.push({ role: 'user', content: msgs[firstUserIdx].content });
  const startIdx = Math.max(0, msgs.length - maxMessages);
  for (let i = startIdx; i < msgs.length; i++) {
    const message = msgs[i];
    history.push({ role: message.role, content: message.content });
  }
  return history;
}
