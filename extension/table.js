// Draws a "table" figure: a plain table that scrolls sideways when it is wider than the panel.
// The spec is data only — every cell goes in with textContent, never HTML — and MathJax typesets
// the cells afterwards through the callback the panel passes in.

export function renderTable(d, { typeset } = {}) {
  const t = d.table;
  const wrap = document.createElement("div");
  wrap.className = "diagramtable";

  if (t.caption) {
    const cap = document.createElement("p");
    cap.className = "label table-caption";
    cap.textContent = t.caption; // plain text by contract
    wrap.append(cap);
  }

  const scroller = document.createElement("div");
  scroller.className = "table-scroll";
  scroller.tabIndex = 0; // a wide table has to be scrollable from the keyboard too
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", t.caption || "Table for the question");

  const table = document.createElement("table");
  table.className = "figure-table";
  if (t.headers.length) {
    const head = document.createElement("thead");
    const tr = document.createElement("tr");
    for (const h of t.headers) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = h;
      tr.append(th);
    }
    head.append(tr);
    table.append(head);
  }
  const body = document.createElement("tbody");
  for (const row of t.rows) {
    const tr = document.createElement("tr");
    row.forEach((c, k) => {
      const heading = t.row_labels && k === 0;
      const cell = document.createElement(heading ? "th" : "td");
      if (heading) cell.scope = "row";
      if (!c) cell.classList.add("blank"); // a cell the student is meant to fill in
      cell.textContent = c;
      tr.append(cell);
    });
    body.append(tr);
  }
  table.append(body);
  scroller.append(table);
  wrap.append(scroller);
  typeset?.(wrap); // one pass for the whole table, not one per cell
  return wrap;
}
