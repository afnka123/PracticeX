// Loaded before MathJax. Extension pages cannot run inline scripts, so the config lives here.
window.MathJax = {
  tex: {
    inlineMath: [["\\(", "\\)"]],
    displayMath: [["\\[", "\\]"]],
    // Model output is untrusted, so three packages stay off whatever else is on:
    //   autoload / require  would fetch more files at the model's request (and the page's CSP
    //                       blocks that anyway, which turns a stray \require into a dead formula)
    //   html                lets TeX emit raw HTML, CSS and links straight into the panel
    // Everything else the bundle carries is on, so a command the model reaches for is defined
    // rather than left on screen as source: ams, mathtools and cases for aligned and piecewise
    // work, mhchem for \ce and \pu, physics for vectors and operators, cancel and enclose for
    // struck-through working, braket for quantum notation, upgreek and textcomp and gensymb for
    // upright Greek and degree and ohm signs, colortbl and empheq and bbox for highlighted steps,
    // textmacros for text-mode commands inside math, and unicode for anything left over.
    packages: {
      "[-]": ["autoload", "require", "html"],
      "[+]": ["physics"],
    },
    macros: {
      // The physics package takes \div for divergence. Students write it for division far more
      // often, so put it back; \divergence still names the operator.
      div: "\\mathbin{\\unicode{0x00F7}}",
      // siunitx is not part of MathJax at any size, and models trained on LaTeX reach for it for
      // units. These keep such a formula readable instead of dropping it to red source; the prompt
      // still asks for mhchem's \pu{...}, which typesets units properly.
      si: ["\\mathrm{#1}", 1],
      unit: ["\\mathrm{#1}", 1],
      SI: ["#1\\,\\mathrm{#2}", 2],
      num: ["#1", 1],
      ang: ["#1^\\circ", 1],
      degree: "^\\circ",
      celsius: "^\\circ\\mathrm{C}",
      percent: "\\%",
    },
  },
  svg: { fontCache: "global" },
  options: { enableMenu: false },
  startup: { typeset: false },
};
