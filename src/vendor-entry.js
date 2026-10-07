// Bundled once into src/renderer/vendor/vendor.js — see `npm run build:vendor`.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import mermaid from 'mermaid';
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Excalidraw, exportToSvg, restore, FONT_FAMILY, serializeAsJSON, convertToExcalidrawElements,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw';
import LZString from 'lz-string';

// CodeMirror 6 powers the Markdown editor and the inline diagram editor.
import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, highlightSpecialChars, rectangularSelection,
  crosshairCursor, placeholder,
} from '@codemirror/view';
import {
  history, historyKeymap, defaultKeymap, indentWithTab, undo, redo, selectAll,
} from '@codemirror/commands';
import {
  search, searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel,
  findNext, findPrevious,
} from '@codemirror/search';
import {
  syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';

const CM = {
  EditorState, EditorSelection, Compartment,
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, highlightSpecialChars, rectangularSelection,
  crosshairCursor, placeholder,
  history, historyKeymap, defaultKeymap, indentWithTab, undo, redo, selectAll,
  search, searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel,
  findNext, findPrevious,
  syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput,
  closeBrackets, closeBracketsKeymap,
  markdown, markdownLanguage, tags,
};

export {
  Marked, DOMPurify, hljs, mermaid, LZString, CM,
  React, createRoot, Excalidraw, exportToSvg, restore, FONT_FAMILY, serializeAsJSON,
  convertToExcalidrawElements, parseMermaidToExcalidraw,
};
