export function isMailDraftReply(messages: Array<{ role: string; content: string }>, index: number): boolean {
  const reply = messages[index];
  // Recognize the letter itself, including saved replies whose earlier writing request
  // is outside the recent history. A following short formatting request must not hide it.
  if (reply?.role === "assistant" && hasMailDraftContent(reply.content)) return true;
  const users = messages.slice(0, index).filter((message) => message.role === "user").slice(-4).reverse();
  for (const message of users) {
    if (/^(?:改成|改为|用)?\s*(?:邮件|email)\s*(?:格式|形式)[。！!]?$/i.test(message.content.trim())) return true;
    if (/(请假信|请假条|邮件|email|letter)/i.test(message.content) && /(写|拟|起草|润色|draft|compose|rewrite)/i.test(message.content)) return true;
    if (!/(我叫|名字|署名|改成|改为|短一点|正式|语气|英文|中文|补充|加上|删掉|重写)/.test(message.content)) return false;
  }
  return false;
}

function hasMailDraftContent(content: string): boolean {
  if (!/^\s*(?:\*\*)?(?:主题|Subject)\s*[:：]/i.test(content.trim())) return false;
  const draft = parseMailDraft(content);
  return Boolean(draft.subject && draft.body);
}

export function parseMailDraft(content: string): { subject: string; body: string } {
  // Prefer the fenced-off letter in older conversational answers, excluding advice below it.
  const sections = content.split(/^\s*---+\s*$/m);
  let letter = sections.length >= 3 ? sections[1]!.trim() : content.trim();
  const subjectLine = /^\s*(?:\*\*)?(?:主题|Subject)\s*[:：]\s*(.*?)\s*$/im;
  const match = letter.match(subjectLine);
  const subject = match?.[1]?.replace(/\*\*/g, "").trim() ?? "";
  if (match?.index !== undefined) letter = letter.slice(match.index + match[0].length).trim();
  letter = letter.split(/\n\s*\n(?=(?:需要我|要不要我)[^\n]*(?:署名|日期|润色|补成))/)[0]!.trim();
  return { subject, body: letter };
}
