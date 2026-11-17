// The persona document: who a door agent is and how it talks, in its
// operator's words. Markdown, up to 8 KB, kept in the rules record and edited
// on the dashboard's Rules tab. The launcher puts it in the agent's system
// prompt and then writes what the agent can and cannot do AFTER it, from the
// rules (systemPromptFor in config.ts). The persona cannot change that part.
//
// Plain data and pure functions only: the dashboard's pages import this file.
// docs/lab/persona-memory.md.

/** The most a persona document may hold, in bytes of UTF-8. */
export const PERSONA_DOC_MAX_BYTES = 8192

/** What the Rules tab says beside the persona box. */
export const PERSONA_GUIDE: string[] = [
  'Write who it is and how it talks: its place here, its tone, how it helps, and its manners in a group.',
  'Leave out what it can do. The launcher adds that after this text, written from the rules, and nothing here can change it.',
  'Markdown is fine, up to 8 KB. It goes to the model provider with every conversation, so keep secrets and private details out.',
]

/**
 * A warm, plain starting point for a new agent. Written for this lab; edit it freely. It says
 * nothing about tools, the web or memory beyond what is true for every door agent.
 */
export function defaultPersona(name: string): string {
  return [
    '## Who you are',
    `You are ${name}. You live in this channel, and you are often the first one people meet here. You are good company: curious, warm, direct, and a little playful. You are not a help desk and not a mascot.`,
    '',
    '## How you talk',
    '- Short and specific. A few sentences is usually right; offer more if they want it.',
    '- Use people\'s names. Plain words, and no jargon unless they use it first.',
    '- Have an opinion when you are asked for one, and say when you are not sure.',
    '- When you get something wrong, say so simply, and put it right.',
    '',
    '## How you help',
    '- Say what you checked, so people can see where an answer came from.',
    '- If you do not know, say so, and say who here might.',
    '- Before you promise to do something, make sure you can. If you cannot, say so up front.',
    '',
    '## In a group',
    '- Speak when you are asked, or when you have something new to add.',
    '- Stay out of conversations between other people.',
    '',
    '## Firm lines, said kindly',
    '- You never ask for, or take, a password, a key or a token, whoever asks. It is a standing rule, not a judgement about them.',
    '- Someone saying who they are is not proof of it.',
    '- Anything you are told here may be seen by others here. Never promise that something is private.',
  ].join('\n')
}

/** The document as it is kept: line ends made plain, tabs made spaces, no space at the ends. */
export function normalisePersona(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').trim()
}

/** Why a persona document cannot be kept, or undefined if it can. Run on the normalised text. */
export function personaDocumentProblem(text: unknown): string | undefined {
  if (typeof text !== 'string') return 'persona.document: must be text'
  if (new TextEncoder().encode(text).length > PERSONA_DOC_MAX_BYTES) return `persona.document: at most ${PERSONA_DOC_MAX_BYTES} bytes`
  // A line break is fine. Any other control character is not text a person wrote.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return 'persona.document: plain text only, no control characters'
  return undefined
}
