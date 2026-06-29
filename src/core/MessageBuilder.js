'use strict';

/**
 * Envelope wrapping a WhatsApp interactive payload.
 * toString() returns a plain-text fallback so concatenation contexts degrade gracefully.
 */
class MessageEnvelope {
  constructor(interactive, textFallback) {
    this.interactive = interactive;
    this._textFallback = textFallback;
  }

  toString() { return this._textFallback; }

  [Symbol.toPrimitive](hint) {
    return hint === 'number' ? NaN : this._textFallback;
  }
}

/**
 * Build a reply-button interactive envelope (1–3 buttons).
 * Button IDs must match what the handler checks (e.g. '1', 'yes', '0').
 */
function buttons(body, buttonDefs) {
  const interactive = {
    type: 'button',
    body: { text: body },
    action: {
      buttons: buttonDefs.map(b => ({
        type: 'reply',
        reply: { id: String(b.id), title: b.title }
      }))
    }
  };
  const textFallback =
    body + '\n\n' +
    buttonDefs.map(b => b.title).join(' · ') +
    '\n\nReply with the option.';
  return new MessageEnvelope(interactive, textFallback);
}

/**
 * Build a list-message interactive envelope (up to 10 rows).
 * Row IDs must match what the handler checks (e.g. '1', '2', ...).
 */
function list(body, buttonLabel, rows) {
  const interactive = {
    type: 'list',
    body: { text: body },
    action: {
      button: buttonLabel,
      sections: [{
        rows: rows.map(r => ({
          id: String(r.id),
          title: r.title,
          ...(r.description ? { description: r.description } : {})
        }))
      }]
    }
  };
  const textFallback =
    body + '\n\n' +
    rows.map((r, i) => `${i + 1}. ${r.title}`).join('\n') +
    '\n\nReply with the number.';
  return new MessageEnvelope(interactive, textFallback);
}

module.exports = { buttons, list, MessageEnvelope };
