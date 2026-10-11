/** Minimal TwiML (Twilio voice markup) builder. Every value is XML-escaped. */
export type TwimlNode = string;

type Attrs = Record<string, string | number | boolean | undefined>;

const ENTITIES: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" };

/** Escapes text content; `attribute` also escapes double quotes. */
export function escapeXml(text: string, attribute = false): string {
  return text.replace(attribute ? /[<>&"]/g : /[<>&]/g, (ch) => ENTITIES[ch]!);
}

export function el(name: string, attrs: Attrs = {}, ...children: TwimlNode[]): TwimlNode {
  const attrText = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v), true)}"`)
    .join("");
  return children.length ? `<${name}${attrText}>${children.join("")}</${name}>` : `<${name}${attrText}/>`;
}

export function say(text: string, voice: string): TwimlNode {
  return el("Say", { voice }, escapeXml(text));
}

export function twiml(...children: TwimlNode[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${children.join("")}</Response>`;
}
