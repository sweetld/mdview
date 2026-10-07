'use strict';

/**
 * The Excalidraw editor, mounted into a container of the app's choosing, plus
 * the conversion of Mermaid diagrams into Excalidraw scenes. Exposed as
 * window.DrawEditor; app.js decides where and when it appears.
 */
(() => {
  const {
    React, createRoot, Excalidraw, serializeAsJSON, convertToExcalidrawElements,
    parseMermaidToExcalidraw,
  } = window.MDV;

  // Everything that would reach for a file dialog or the network stays off;
  // the app owns loading and saving.
  const UI_OPTIONS = {
    canvasActions: {
      loadScene: false,
      saveToActiveFile: false,
      export: false,
      saveAsImage: true,
      toggleTheme: false,
      clearCanvas: true,
      changeViewBackgroundColor: true,
    },
    tools: { image: true },
  };

  // A cheap identity for "has the drawing changed": every element carries a
  // version that bumps on each edit.
  function fingerprint(elements) {
    let out = '';
    for (const el of elements) if (!el.isDeleted) out += el.id + ':' + el.version + ';';
    return out;
  }

  function mount(container, { scene, dark = false, onChange } = {}) {
    container.classList.add('excalidraw-host');
    const root = createRoot(container);
    let api = null;
    let theme = dark ? 'dark' : 'light';
    const baseline = { value: fingerprint(scene.elements || []) };

    const render = () => {
      root.render(React.createElement(Excalidraw, {
        initialData: {
          elements: scene.elements || [],
          appState: { ...(scene.appState || {}), collaborators: new Map() },
          files: scene.files || {},
          scrollToContent: true,
        },
        theme,
        langCode: 'en',
        UIOptions: UI_OPTIONS,
        excalidrawAPI: (a) => { api = a; },
        onChange: (elements) => {
          if (onChange) onChange(fingerprint(elements) !== baseline.value);
        },
      }));
    };
    render();

    return {
      get api() { return api; },
      elements: () => (api ? api.getSceneElements() : scene.elements || []),
      // The scene as Excalidraw itself would save it.
      toJSON() {
        if (!api) return serializeAsJSON(scene.elements || [], scene.appState || {}, scene.files || {}, 'local');
        return serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local');
      },
      // Called after a save, so the dirty flag starts again from here.
      markClean() {
        baseline.value = fingerprint(api ? api.getSceneElements() : scene.elements || []);
      },
      isDirty() {
        return api ? fingerprint(api.getSceneElements()) !== baseline.value : false;
      },
      setTheme(isDark) {
        theme = isDark ? 'dark' : 'light';
        render();
      },
      focus() {
        const canvas = container.querySelector('.excalidraw__canvas, canvas');
        if (canvas) canvas.focus();
      },
      destroy() {
        root.unmount();
        container.classList.remove('excalidraw-host');
        container.replaceChildren();
      },
    };
  }

  // Lays a Mermaid diagram out as Excalidraw shapes. Flowcharts, sequence,
  // class, ER and state diagrams are understood; anything else arrives as a
  // single image of the rendered SVG.
  async function fromMermaid(text) {
    const { elements, files } = await parseMermaidToExcalidraw(text, {
      themeVariables: { fontSize: '16px' },
    });
    return { elements: convertToExcalidrawElements(elements), files: files || {}, appState: {} };
  }

  window.DrawEditor = { mount, fromMermaid };
})();
