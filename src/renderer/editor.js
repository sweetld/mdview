'use strict';

/**
 * CodeMirror wrapper used by both the Markdown editor and the inline diagram
 * editor, plus the Markdown formatting commands the toolbar and Format menu
 * drive. Exposed as window.MdEditor; app.js owns all the surrounding UI.
 */
(() => {
  const {
    EditorState, EditorSelection, EditorView, keymap, lineNumbers, highlightActiveLine,
    highlightActiveLineGutter, drawSelection, dropCursor, highlightSpecialChars,
    rectangularSelection, crosshairCursor, placeholder,
    history, historyKeymap, defaultKeymap, indentWithTab, undo, redo, selectAll,
    search, searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel,
    findNext, findPrevious,
    syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput,
    closeBrackets, closeBracketsKeymap, markdown, markdownLanguage, tags,
  } = window.MDV.CM;

  /* --------------------------------------------------------- highlighting */

  // Colours come from the page's CSS variables, so the editor follows the
  // theme without being rebuilt.
  const markdownHighlight = HighlightStyle.define([
    { tag: tags.heading1, color: 'var(--hl-title)', fontWeight: '700', fontSize: '1.25em' },
    { tag: tags.heading2, color: 'var(--hl-title)', fontWeight: '700', fontSize: '1.12em' },
    { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: 'var(--hl-title)', fontWeight: '650' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.link, color: 'var(--accent)' },
    { tag: tags.url, color: 'var(--hl-string)' },
    { tag: tags.monospace, color: 'var(--hl-number)' },
    { tag: tags.quote, color: 'var(--fg-muted)', fontStyle: 'italic' },
    { tag: tags.list, color: 'var(--hl-keyword)' },
    { tag: tags.contentSeparator, color: 'var(--fg-faint)' },
    { tag: tags.processingInstruction, color: 'var(--fg-faint)' },
    { tag: tags.labelName, color: 'var(--hl-meta)' },
    { tag: tags.meta, color: 'var(--hl-meta)' },
    { tag: tags.comment, color: 'var(--hl-comment)', fontStyle: 'italic' },
    { tag: tags.escape, color: 'var(--hl-attr)' },
  ]);

  /* ------------------------------------------------------------- editors */

  function create({
    parent, doc = '', lang = 'markdown', lineNumbers: gutter = true, wrap = true,
    hint = '', keys = [], onChange, onCursor, onFocus, onBlur, onScroll,
  }) {
    const extensions = [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([
        ...keys,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorState.tabSize.of(2),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && onChange) onChange(update.state.doc.toString());
        if ((update.selectionSet || update.docChanged) && onCursor) onCursor(cursorInfo(update.state));
      }),
      EditorView.domEventHandlers({
        focus: () => { if (onFocus) onFocus(); },
        blur: () => { if (onBlur) onBlur(); },
      }),
    ];
    if (gutter) extensions.push(lineNumbers(), highlightActiveLineGutter());
    if (wrap) extensions.push(EditorView.lineWrapping);
    if (hint) extensions.push(placeholder(hint));
    if (lang === 'markdown') {
      extensions.push(
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(markdownHighlight),
        // Brackets only: auto-closed quotes get in the way of prose.
        markdownLanguage.data.of({ closeBrackets: { brackets: ['(', '[', '{'] } }),
        closeBrackets(),
      );
    }

    const view = new EditorView({ state: EditorState.create({ doc, extensions }), parent });
    if (onScroll) view.scrollDOM.addEventListener('scroll', () => onScroll(view.scrollDOM));

    return {
      view,
      getValue: () => view.state.doc.toString(),
      // Replaces the whole document, keeping the cursor where it was if it
      // still fits. A separate history entry, so it can be undone.
      setValue(text) {
        if (text === view.state.doc.toString()) return;
        const head = Math.min(view.state.selection.main.head, text.length);
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: head },
        });
      },
      replaceRange(from, to, insert) {
        view.dispatch({ changes: { from, to, insert }, userEvent: 'input' });
      },
      focus: () => view.focus(),
      hasFocus: () => view.hasFocus,
      undo: () => undo(view),
      redo: () => redo(view),
      selectAll: () => selectAll(view),
      openSearch: () => openSearchPanel(view),
      closeSearch: () => closeSearchPanel(view),
      findNext: () => findNext(view),
      findPrevious: () => findPrevious(view),
      format: (command) => format(view, command),
      cursor: () => cursorInfo(view.state),
      scrollTo(fraction) {
        const sc = view.scrollDOM;
        sc.scrollTop = fraction * (sc.scrollHeight - sc.clientHeight);
      },
      destroy: () => view.destroy(),
    };
  }

  function cursorInfo(state) {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1, lines: state.doc.lines };
  }

  // The editor, if any, that currently has keyboard focus.
  function focused() {
    const dom = document.activeElement && document.activeElement.closest('.cm-editor');
    return dom ? EditorView.findFromDOM(dom) : null;
  }

  /* ---------------------------------------------------------- formatting */

  // Wraps each selection in `before`/`after`, or unwraps it if already wrapped.
  function wrapSelection(view, before, after = before, fallback = '') {
    const tr = view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const outerFrom = range.from - before.length;
      const outerTo = range.to + after.length;
      if (outerFrom >= 0 && outerTo <= view.state.doc.length
          && view.state.sliceDoc(outerFrom, outerTo) === before + text + after) {
        return {
          changes: [{ from: outerFrom, to: range.from }, { from: range.to, to: outerTo }],
          range: EditorSelection.range(outerFrom, outerFrom + text.length),
        };
      }
      if (text.length >= before.length + after.length && text.startsWith(before) && text.endsWith(after)) {
        const inner = text.slice(before.length, text.length - after.length);
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.from + inner.length),
        };
      }
      const content = text || fallback;
      return {
        changes: { from: range.from, to: range.to, insert: before + content + after },
        range: EditorSelection.range(range.from + before.length, range.from + before.length + content.length),
      };
    });
    view.dispatch(tr, { scrollIntoView: true, userEvent: 'input' });
  }

  function selectedLines(state, range) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    const lines = [];
    for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
    return lines;
  }

  // Adds a block prefix to every selected line, or removes it when every line
  // already has one. `pattern` must match the indentation and the marker.
  function toggleLinePrefix(view, { pattern, prefix, numbered = false }) {
    const state = view.state;
    const tr = state.changeByRange((range) => {
      const lines = selectedLines(state, range);
      const allHave = lines.every((l) => pattern.test(l.text));
      const edits = [];
      let n = 1;
      for (const line of lines) {
        const indent = line.text.match(/^[ \t]*/)[0];
        if (allHave) {
          const m = line.text.match(pattern);
          edits.push({ from: line.from, to: line.from + m[0].length, insert: indent });
        } else if (!pattern.test(line.text)) {
          // Swap out any other block marker rather than stacking two.
          const other = line.text.slice(indent.length).match(/^(?:[-*+] (?:\[[ xX]\] )?|\d+[.)] |> ?)/);
          const to = line.from + indent.length + (other ? other[0].length : 0);
          edits.push({ from: line.from + indent.length, to, insert: numbered ? `${n}. ` : prefix });
        }
        n++;
      }
      const changes = state.changes(edits);
      return { changes, range: EditorSelection.range(changes.mapPos(range.anchor), changes.mapPos(range.head)) };
    });
    view.dispatch(tr, { scrollIntoView: true, userEvent: 'input' });
  }

  function setHeading(view, level) {
    const state = view.state;
    const tr = state.changeByRange((range) => {
      const edits = [];
      for (const line of selectedLines(state, range)) {
        const m = line.text.match(/^([ \t]*)(#{1,6})[ \t]+/);
        const current = m ? m[2].length : 0;
        const next = current === level ? 0 : level;
        const indent = m ? m[1] : line.text.match(/^[ \t]*/)[0];
        const marker = next ? '#'.repeat(next) + ' ' : '';
        edits.push({ from: line.from, to: line.from + (m ? m[0].length : indent.length), insert: indent + marker });
      }
      const changes = state.changes(edits);
      return { changes, range: EditorSelection.range(changes.mapPos(range.anchor), changes.mapPos(range.head)) };
    });
    view.dispatch(tr, { scrollIntoView: true, userEvent: 'input' });
  }

  // Inserts a block on lines of its own; `cursor` is the offset within `text`
  // where the caret should land.
  function insertBlock(view, text, cursor = text.length) {
    const state = view.state;
    const range = state.selection.main;
    const line = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    const before = line.from === 0 || line.text.trim() === '' && line.from === range.from ? '' : '\n';
    const after = endLine.to === state.doc.length ? '\n' : '\n';
    const insert = (range.from === line.from ? '' : before) + text + after;
    const base = range.from === line.from ? range.from : range.from + before.length;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: base + cursor },
      scrollIntoView: true,
      userEvent: 'input',
    });
  }

  function fenceSelection(view, lang = '') {
    const state = view.state;
    const range = state.selection.main;
    const text = state.sliceDoc(range.from, range.to);
    if (text.includes('\n') || (text && range.from === state.doc.lineAt(range.from).from)) {
      const lines = selectedLines(state, range);
      const from = lines[0].from;
      const to = lines[lines.length - 1].to;
      const body = state.sliceDoc(from, to);
      const insert = '```' + lang + '\n' + body + '\n```';
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from, head: from + insert.length }, userEvent: 'input' });
      return;
    }
    const block = '```' + lang + '\n' + text + '\n```';
    insertBlock(view, block, 4 + lang.length + text.length);
  }

  const TABLE = '| Column | Column |\n| --- | --- |\n| Cell | Cell |\n| Cell | Cell |';
  const MERMAID = '```mermaid\nflowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Done]\n  B -->|No| D[Try again]\n  D --> A\n```';

  function format(view, command) {
    switch (command) {
      case 'bold': wrapSelection(view, '**', '**', 'bold'); break;
      case 'italic': wrapSelection(view, '*', '*', 'italic'); break;
      case 'strike': wrapSelection(view, '~~', '~~', 'struck'); break;
      case 'code': wrapSelection(view, '`', '`', 'code'); break;
      case 'link': linkSelection(view, false); break;
      case 'image': linkSelection(view, true); break;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        setHeading(view, Number(command[1])); break;
      case 'paragraph': setHeading(view, 0); break;
      case 'bullet':
        toggleLinePrefix(view, { pattern: /^[ \t]*[-*+] (?!\[[ xX]\] )/, prefix: '- ' }); break;
      case 'numbered':
        toggleLinePrefix(view, { pattern: /^[ \t]*\d+[.)] /, numbered: true }); break;
      case 'task':
        toggleLinePrefix(view, { pattern: /^[ \t]*[-*+] \[[ xX]\] /, prefix: '- [ ] ' }); break;
      case 'quote':
        toggleLinePrefix(view, { pattern: /^[ \t]*> ?/, prefix: '> ' }); break;
      case 'codeblock': fenceSelection(view); break;
      case 'mermaid': insertBlock(view, MERMAID, 11); break;
      case 'table': insertBlock(view, TABLE, 2); break;
      case 'hr': insertBlock(view, '---'); break;
      default: return false;
    }
    view.focus();
    return true;
  }

  function linkSelection(view, image) {
    const state = view.state;
    const tr = state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      const isUrl = /^(https?:\/\/|www\.)\S+$/i.test(text);
      const label = isUrl ? '' : text;
      const url = isUrl ? text : (image ? 'image.png' : 'https://');
      const open = image ? '![' : '[';
      const insert = `${open}${label}](${url})`;
      // Select whatever still needs filling in: the label if a URL was
      // selected, otherwise the URL.
      const from = range.from + (isUrl ? open.length : open.length + label.length + 2);
      const len = isUrl ? 0 : url.length;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(from, from + len) };
    });
    view.dispatch(tr, { scrollIntoView: true, userEvent: 'input' });
  }

  window.MdEditor = { create, focused, format };
})();
