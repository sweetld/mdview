'use strict';

/**
 * A Mermaid sequence diagram as an editable list of participants and
 * messages, written back as Mermaid source. Blocks (alt, loop, par, …),
 * notes and activations travel through unchanged. Exposed as
 * window.SeqModel, with the designer adapter as window.SeqAdapter.
 */
(() => {
  const { mermaid } = window.MDV;

  // Mermaid's LINETYPE numbers for arrows, and the text that draws each.
  const ARROWS = [
    [0, '->>', 'Solid arrow'], [1, '-->>', 'Dotted arrow'],
    [5, '->', 'Solid line'], [6, '-->', 'Dotted line'],
    [24, '-)', 'Solid, open arrow'], [25, '--)', 'Dotted, open arrow'],
    [3, '-x', 'Solid, cross'], [4, '--x', 'Dotted, cross'],
    [33, '<<->>', 'Both ways'], [34, '<<-->>', 'Both ways, dotted'],
  ];
  const ARROW = new Map(ARROWS.map(([t, s]) => [t, s]));
  const ARROW_OPTIONS = ARROWS.map(([t, , label]) => [String(t), label]);
  const BLOCKS = {
    10: 'loop', 12: 'alt', 13: 'else', 15: 'opt', 19: 'par', 20: 'and', 22: 'rect',
    27: 'critical', 28: 'option', 30: 'break', 32: 'par over',
  };
  const OPENERS = new Set([10, 12, 15, 19, 22, 27, 30, 32]);
  const MIDS = new Set([13, 20, 28]);
  const CLOSERS = new Set([11, 14, 16, 21, 23, 29, 31]);
  const NOTE = 2; const ACTIVATE = 17; const DEACTIVATE = 18; const AUTONUMBER = 26;
  const PLACE = { 0: 'left of', 1: 'right of', 2: 'over' };

  const isMsg = (m) => ARROW.has(m.type);
  const count = (x) => (x ? (x.size ?? Object.keys(x).length) : 0);

  /* ------------------------------------------------------------- parsing */

  function splitHeader(text) {
    const lines = text.split('\n');
    let i = 0;
    const preamble = [];
    if (lines[0] && lines[0].trim() === '---') {
      preamble.push(lines[0]);
      for (i = 1; i < lines.length; i++) {
        preamble.push(lines[i]);
        if (lines[i].trim() === '---') { i++; break; }
      }
    }
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*sequenceDiagram\b/.test(line)) return { preamble };
      if (line.trim() === '' || line.trim().startsWith('%%')) preamble.push(line);
      else break;
    }
    return { preamble };
  }

  function unsupported(what) {
    const err = new Error(`This sequence diagram uses ${what}, which the visual editor cannot round-trip yet. Use Source mode.`);
    err.code = 'NOT_SUPPORTED';
    return err;
  }

  async function parse(text) {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
    if (diagram.type !== 'sequence') {
      const err = new Error('Not a sequence diagram');
      err.code = 'NOT_SUPPORTED';
      throw err;
    }
    const db = diagram.db;
    if (count(db.getCreatedActors()) || count(db.getDestroyedActors())) throw unsupported('create or destroy');
    const actorMap = db.getActors();
    const actors = db.getActorKeys().map((k) => {
      const a = actorMap.get(k) || {};
      if (count(a.links) || count(a.properties)) throw unsupported('participant links or properties');
      return { id: k, label: a.description || k, type: a.type === 'actor' ? 'actor' : 'participant' };
    });
    const boxes = db.getBoxes().map((b) => ({ name: b.name || '', fill: b.fill || '', actorKeys: [...(b.actorKeys || [])] }));
    const messages = db.getMessages().map((m) => ({
      from: m.from, to: m.to,
      text: typeof m.message === 'string' ? m.message : '',
      type: m.type, placement: m.placement,
      visible: m.message && typeof m.message === 'object' ? m.message.visible !== false : true,
    }));
    for (const m of messages) {
      const known = isMsg(m) || m.type === NOTE || m.type === ACTIVATE || m.type === DEACTIVATE
        || m.type === AUTONUMBER || OPENERS.has(m.type) || MIDS.has(m.type) || CLOSERS.has(m.type);
      if (!known) throw unsupported(`a statement of type ${m.type}`);
    }
    return { keyword: 'sequenceDiagram', preamble: splitHeader(text).preamble, actors, boxes, messages };
  }

  /* ----------------------------------------------------------- serialise */

  function actorLine(a, pad) {
    const kw = a.type === 'actor' ? 'actor' : 'participant';
    return `${pad}${kw} ${a.id}${a.label !== a.id ? ' as ' + a.label : ''}`;
  }

  function serialize(model) {
    const out = [...model.preamble, model.keyword];
    const done = new Set();
    for (const a of model.actors) {
      const box = model.boxes.find((b) => b.actorKeys.includes(a.id));
      if (!box) { out.push(actorLine(a, '  ')); continue; }
      if (done.has(box)) continue;
      done.add(box);
      const fill = box.fill && box.fill !== 'transparent' ? box.fill + ' ' : '';
      out.push(`  box ${fill}${box.name}`.trimEnd());
      for (const k of box.actorKeys) {
        const m = model.actors.find((x) => x.id === k);
        if (m) out.push(actorLine(m, '    '));
      }
      out.push('  end');
    }
    let depth = 1;
    for (const m of model.messages) {
      const pad = '  '.repeat(depth);
      if (isMsg(m)) out.push(`${pad}${m.from}${ARROW.get(m.type)}${m.to}: ${m.text || ' '}`);
      else if (m.type === NOTE) {
        const place = PLACE[m.placement] || 'over';
        const who = m.placement === 2 && m.to && m.to !== m.from ? `${m.from},${m.to}` : m.from;
        out.push(`${pad}Note ${place} ${who}: ${m.text || ' '}`);
      } else if (m.type === ACTIVATE) out.push(`${pad}activate ${m.from}`);
      else if (m.type === DEACTIVATE) out.push(`${pad}deactivate ${m.from}`);
      else if (m.type === AUTONUMBER) out.push(`${pad}autonumber${m.visible ? '' : ' off'}`);
      else if (CLOSERS.has(m.type)) { depth = Math.max(1, depth - 1); out.push('  '.repeat(depth) + 'end'); }
      else if (MIDS.has(m.type)) out.push(('  '.repeat(Math.max(1, depth - 1)) + `${BLOCKS[m.type]} ${m.text}`).trimEnd());
      else if (OPENERS.has(m.type)) { out.push(`${pad}${BLOCKS[m.type]} ${m.text}`.trimEnd()); depth++; }
    }
    return out.join('\n') + '\n';
  }

  /* ---------------------------------------------------------------- edits */

  const actorOf = (model, id) => model.actors.find((a) => a.id === id);

  function newId(model) {
    const taken = new Set(model.actors.map((a) => a.id));
    for (let n = 1; ; n++) if (!taken.has(`P${n}`)) return `P${n}`;
  }

  function addActor(model, label = 'Participant') {
    const id = newId(model);
    model.actors.push({ id, label, type: 'participant' });
    return id;
  }

  function removeActor(model, id) {
    model.actors = model.actors.filter((a) => a.id !== id);
    model.messages = model.messages.filter((m) => !(m.from === id || m.to === id));
    for (const b of model.boxes) b.actorKeys = b.actorKeys.filter((k) => k !== id);
    model.boxes = model.boxes.filter((b) => b.actorKeys.length);
  }

  // Inserts after `after` (a message index), or at the end.
  function addMessage(model, from, to, after = -1, text = 'message') {
    const i = after >= 0 ? after + 1 : model.messages.length;
    model.messages.splice(i, 0, { from, to, text, type: 0 });
    return i;
  }

  function removeMessage(model, i) {
    model.messages.splice(i, 1);
  }

  function moveMessage(model, i, step) {
    const j = i + step;
    if (j < 0 || j >= model.messages.length) return i;
    [model.messages[i], model.messages[j]] = [model.messages[j], model.messages[i]];
    return j;
  }

  function setAutonumber(model, on) {
    model.messages = model.messages.filter((m) => m.type !== AUTONUMBER);
    if (on) model.messages.unshift({ type: AUTONUMBER, text: '', visible: true });
  }

  function autonumber(model) {
    return model.messages.some((m) => m.type === AUTONUMBER && m.visible);
  }

  window.SeqModel = {
    parse, serialize, actorOf, addActor, removeActor, addMessage, removeMessage, moveMessage,
    setAutonumber, autonumber, isMsg, ARROWS, ARROW_OPTIONS,
  };

  /* ===================================================== designer adapter */

  // Message texts and lines come out of Mermaid in message order, so the
  // nth of each belongs to the nth real message.
  function messageIndexes(model) {
    return model.messages.map((m, i) => (isMsg(m) ? i : -1)).filter((i) => i >= 0);
  }

  function messageEls(canvas, model, i) {
    const real = messageIndexes(model);
    const k = real.indexOf(i);
    if (k < 0) return [];
    const texts = [...canvas.querySelectorAll('text.messageText')];
    const lines = [...canvas.querySelectorAll('.messageLine0, .messageLine1')];
    const out = [];
    if (texts.length === real.length && texts[k]) out.push(texts[k]);
    if (lines.length === real.length && lines[k]) out.push(lines[k]);
    return out;
  }

  function actorEls(canvas, esc, a) {
    const out = [...canvas.querySelectorAll(`rect.actor[name="${esc(a.id)}"]`)];
    for (const r of [...out]) {
      if (r.parentElement) out.push(...r.parentElement.querySelectorAll('text.actor-box, text.actor-man'));
    }
    // Stick figures carry no name; match the label text instead.
    for (const t of canvas.querySelectorAll('text.actor-man')) {
      if (t.textContent.trim() === a.label && !out.includes(t)) {
        out.push(t);
        if (t.parentElement) out.push(...t.parentElement.querySelectorAll('.actor-man:not(text)'));
      }
    }
    return out;
  }

  const msg = (model, sel) => (sel && sel.kind === 'message' ? model.messages[sel.id] : null);

  window.SeqAdapter = {
    name: 'sequence diagrams',
    connectLabel: 'Message',
    connectHint: 'Select the participant the message comes from first',
    addLabel: (model, sel) => (sel && (sel.kind === 'actor' || sel.kind === 'message') ? '+ Message' : '+ Participant'),
    matches: (type) => type === 'sequence',
    parse, serialize,

    bind(canvas, model, ctx) {
      for (const i of messageIndexes(model)) {
        const sel = { kind: 'message', id: i };
        for (const el of messageEls(canvas, model, i)) {
          el.classList.add('fd-msg');
          el.addEventListener('click', (e) => { e.stopPropagation(); ctx.click(sel, e); });
          el.addEventListener('dblclick', (e) => { e.stopPropagation(); ctx.dblclick(sel); });
        }
      }
      for (const a of model.actors) {
        const sel = { kind: 'actor', id: a.id };
        for (const el of actorEls(canvas, ctx.esc, a)) {
          el.classList.add('fd-actor');
          el.addEventListener('click', (e) => { e.stopPropagation(); ctx.click(sel, e); });
          el.addEventListener('dblclick', (e) => { e.stopPropagation(); ctx.dblclick(sel); });
        }
      }
    },

    applySelection(canvas, model, sel) {
      const esc = window.FlowDesigner.esc;
      const els = sel.kind === 'message' ? messageEls(canvas, model, sel.id)
        : sel.kind === 'actor' ? actorEls(canvas, esc, actorOf(model, sel.id) || { id: sel.id, label: '' }) : [];
      for (const el of els) el.classList.add('fd-selected');
    },

    canConnect: (sel) => sel.kind === 'actor',
    connect(model, a, b) {
      const i = addMessage(model, a.id, b.id);
      return { kind: 'message', id: i };
    },
    add(model, sel) {
      if (sel && sel.kind === 'actor') {
        const idx = model.actors.findIndex((a) => a.id === sel.id);
        const to = model.actors[idx + 1] || model.actors[idx];
        return { kind: 'message', id: addMessage(model, sel.id, to.id) };
      }
      if (sel && sel.kind === 'message') {
        const m = model.messages[sel.id];
        return { kind: 'message', id: addMessage(model, m.from, m.to, sel.id) };
      }
      return { kind: 'actor', id: addActor(model) };
    },
    remove(model, sel) {
      if (sel.kind === 'actor') removeActor(model, sel.id);
      else if (sel.kind === 'message') removeMessage(model, sel.id);
    },
    label(model, sel) {
      if (sel.kind === 'message') { const m = msg(model, sel); return m ? m.text : ''; }
      const a = actorOf(model, sel.id);
      return a ? a.label : '';
    },
    setLabel(model, sel, text) {
      if (sel.kind === 'message') { const m = msg(model, sel); if (m) m.text = text; return; }
      const a = actorOf(model, sel.id);
      if (a) a.label = text;
    },
    labelElement(canvas, model, sel) {
      if (sel.kind === 'message') return messageEls(canvas, model, sel.id)[0] || null;
      const a = actorOf(model, sel.id);
      return a ? actorEls(canvas, window.FlowDesigner.esc, a)[0] || null : null;
    },

    inspector(model, sel, ctx) {
      const { h, field, select, commit, commitTyped } = ctx;
      const actorOptions = model.actors.map((a) => [a.id, a.label]);

      if (sel && sel.kind === 'actor') {
        const a = actorOf(model, sel.id);
        if (!a) return [];
        const label = h('input', { type: 'text', value: a.label, 'data-field': 'label', spellcheck: 'false' });
        label.addEventListener('input', () => commitTyped((m) => { const x = actorOf(m, a.id); if (x) x.label = label.value; }, 'actor:' + a.id));
        return [
          h('div', { class: 'fd-head', text: `Participant ${a.id}` }),
          field('Name', label),
          field('Drawn as', select([['participant', 'Box'], ['actor', 'Stick figure']], a.type, (val) => commit((m) => { const x = actorOf(m, a.id); if (x) x.type = val; }))),
          h('p', { class: 'fd-hint', text: 'Shift+click another participant to send it a message. Double-click to rename.' }),
        ];
      }
      if (sel && sel.kind === 'message') {
        const i = sel.id;
        const m = model.messages[i];
        if (!m) return [];
        const text = h('input', { type: 'text', value: m.text, 'data-field': 'label', spellcheck: 'false' });
        text.addEventListener('input', () => commitTyped((x) => { if (x.messages[i]) x.messages[i].text = text.value; }, 'msg:' + i));
        const name = (id) => { const a = actorOf(model, id); return a ? a.label : id; };
        return [
          h('div', { class: 'fd-head', text: `${name(m.from)} → ${name(m.to)}` }),
          field('Text', text),
          field('Arrow', select(ARROW_OPTIONS, String(m.type), (val) => commit((x) => { if (x.messages[i]) x.messages[i].type = Number(val); }))),
          field('From', select(actorOptions, m.from, (val) => commit((x) => { if (x.messages[i]) x.messages[i].from = val; }))),
          field('To', select(actorOptions, m.to, (val) => commit((x) => { if (x.messages[i]) x.messages[i].to = val; }))),
          h('div', { class: 'fd-tools' },
            h('button', { type: 'button', class: 'ghost-btn', text: 'Reverse', onclick: () => commit((x) => { const y = x.messages[i]; if (y) [y.from, y.to] = [y.to, y.from]; }) }),
            h('button', { type: 'button', class: 'ghost-btn', text: '↑ Earlier', disabled: i === 0,
              onclick: () => { let j = i; commit((x) => { j = moveMessage(x, i, -1); }, { selectAfter: () => ({ kind: 'message', id: j }) }); } }),
            h('button', { type: 'button', class: 'ghost-btn', text: '↓ Later', disabled: i >= model.messages.length - 1,
              onclick: () => { let j = i; commit((x) => { j = moveMessage(x, i, 1); }, { selectAfter: () => ({ kind: 'message', id: j }) }); } }),
          ),
          h('p', { class: 'fd-hint', text: 'Double-click the message to edit its text in place. Blocks (alt, loop, par) and notes are edited in Source mode.' }),
        ];
      }
      return [
        h('div', { class: 'fd-head', text: 'Diagram' }),
        field('Numbering', select([['off', 'Off'], ['on', 'Number the messages']], autonumber(model) ? 'on' : 'off', (val) => commit((m) => setAutonumber(m, val === 'on')))),
        h('p', { class: 'fd-hint', text: 'Click a participant or message to edit it. Shift+click two participants to add a message between them.' }),
      ];
    },
  };
})();
